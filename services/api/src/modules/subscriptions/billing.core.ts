import { Injectable } from '@nestjs/common';
import type { BillingCycle, Coupon, Subscription, SubscriptionInvoice, SubscriptionPlan, SubscriptionStatus, TenantStatus } from '@typease/database';
import type { DomainEventType } from '@typease/types';
import { AuditService } from '../../common/audit.service';
import { tryCtx } from '../../common/context';
import { Prisma, SystemDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { found } from '../../common/errors';
import { D } from '../../common/pagination';
import { BillingClock } from './billing-clock';
import { addDays, BillingPolicy, couponDiscount, Cycle, formatInvoiceNumber, invoiceAmounts, mergePolicy, periodEnd, priceFor } from './billing.calc';

export const UNPAID_SUSPENSION = 'SUBSCRIPTION_UNPAID';
export const SEQUENCE_KEY = 'subscriptions.invoice_sequence';
export const POLICY_KEY = 'subscriptions.policy';
/** Invoices that buy a billing period (as opposed to a prorated upgrade). */
export const PERIOD_REASONS = ['FIRST_PERIOD', 'RENEWAL', 'RESTART'];
export type InvoiceReason = 'FIRST_PERIOD' | 'RENEWAL' | 'RESTART' | 'UPGRADE';

export type FullSubscription = Subscription & { plan: SubscriptionPlan; pendingPlan: SubscriptionPlan | null; coupon: Coupon | null };
export interface InvoiceLine {
  description: string;
  planId: string;
  planKey: string;
  planName: string;
  billingCycle: Cycle;
  periodStart: string;
  periodEnd: string;
  amount: string;
  couponCode?: string | null;
}

const TENANT_STATUS: Record<SubscriptionStatus, TenantStatus> = { TRIALING: 'TRIAL', ACTIVE: 'ACTIVE', PAST_DUE: 'PAST_DUE', GRACE: 'PAST_DUE', EXPIRED: 'SUSPENDED', CANCELLED: 'CANCELLED' };

/**
 * State changes of SaaS billing. Billing state is platform-controlled: the
 * tenant-scoped database role can only read it, so everything here runs on the
 * system connection, inside one transaction per subscription with the
 * subscription row locked. Every transition is recorded in subscription_events.
 */
@Injectable()
export class BillingCore {
  constructor(
    private readonly sys: SystemDb,
    private readonly clock: BillingClock,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
  ) {}

  async policy(tx: Tx): Promise<BillingPolicy> {
    const row = await tx.platformSetting.findUnique({ where: { key: POLICY_KEY } });
    return mergePolicy(row?.value);
  }

  /**
   * Global, gap-free SaaS invoice number (TE-SUB-000001 ...). The counter row in
   * platform_settings stays locked until the surrounding transaction ends, so two
   * invoices can never share a number and a rolled-back invoice does not burn one.
   */
  async nextInvoiceNumber(tx: Tx): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
      INSERT INTO "platform_settings" ("key", "value", "updatedAt") VALUES (${SEQUENCE_KEY}, '{"next": 2}'::jsonb, now())
      ON CONFLICT ("key") DO UPDATE SET "value" = jsonb_build_object('next', ("platform_settings"."value"->>'next')::bigint + 1), "updatedAt" = now()
      RETURNING (("value"->>'next')::bigint - 1) AS n`;
    return formatInvoiceNumber(rows[0].n);
  }

  /** Serialises everything that concerns one tenant's billing, even before a subscription row exists. */
  async lockTenant(tx: Tx, tenantId: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`subscription:${tenantId}`}, 0))::text AS locked`;
  }
  private include = { plan: true, pendingPlan: true, coupon: true } as const;
  async lockByTenant(tx: Tx, tenantId: string): Promise<FullSubscription | null> {
    await this.lockTenant(tx, tenantId);
    await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return tx.subscription.findUnique({ where: { tenantId }, include: this.include });
  }
  async lockById(tx: Tx, id: string): Promise<FullSubscription> {
    const row = found(await tx.subscription.findUnique({ where: { id }, select: { tenantId: true } }), 'Subscription');
    return found(await this.lockByTenant(tx, row.tenantId), 'Subscription');
  }
  reload(tx: Tx, id: string): Promise<FullSubscription> {
    return tx.subscription.findUniqueOrThrow({ where: { id }, include: this.include });
  }

  async record(tx: Tx, sub: { id: string; tenantId: string }, type: string, data: Record<string, unknown> = {}): Promise<void> {
    await tx.subscriptionEvent.create({ data: { tenantId: sub.tenantId, subscriptionId: sub.id, type, data: JSON.parse(JSON.stringify(data)), actorId: tryCtx()?.userId ?? null } });
  }

  /** Domain events go to the system outbox once the billing transaction has committed. */
  emit(type: DomainEventType, payload: Record<string, unknown>, tenantId: string): void {
    this.sys.afterCommit(() => this.events.emitSystem(type, payload, tenantId));
  }
  auditLater(tenantId: string, action: string, resourceType: string, resourceId: string, summary: string, after?: unknown): void {
    this.sys.afterCommit(() => this.audit.logSystem({ action, resourceType, resourceId, summary, after }, tenantId));
  }

  /**
   * Keeps tenants.status in step with the subscription - but never overrides
   * ONBOARDING / PENDING_APPROVAL / ARCHIVED, nor a suspension made by a platform
   * administrator for another reason.
   */
  async syncTenantStatus(tx: Tx, tenantId: string, status: SubscriptionStatus): Promise<boolean> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (['ONBOARDING', 'PENDING_APPROVAL', 'ARCHIVED'].includes(tenant.status)) return false;
    const suspendedForBilling = tenant.status === 'SUSPENDED' && tenant.suspensionReason === UNPAID_SUSPENSION;
    if (tenant.status === 'SUSPENDED' && !suspendedForBilling) return false;
    // A cancelled centre only comes back through a paid restart.
    if (tenant.status === 'CANCELLED' && !['ACTIVE', 'TRIALING'].includes(status)) return false;
    const target = TENANT_STATUS[status];
    if (tenant.status === target) return false;
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        status: target,
        ...(target === 'SUSPENDED' ? { suspendedAt: this.clock.now(), suspensionReason: UNPAID_SUSPENSION } : suspendedForBilling ? { suspendedAt: null, suspensionReason: null } : {}),
      },
    });
    this.auditLater(tenantId, 'tenant.status_changed_by_billing', 'Tenant', tenantId, `${tenant.status} -> ${target} (subscription ${status})`, { from: tenant.status, to: target, subscriptionStatus: status });
    return true;
  }

  /** Status transition + its subscription_events row + tenant status. */
  async setStatus(tx: Tx, sub: FullSubscription, to: SubscriptionStatus, data: Prisma.SubscriptionUncheckedUpdateInput = {}, why: Record<string, unknown> = {}): Promise<FullSubscription> {
    const from = sub.status;
    await tx.subscription.update({ where: { id: sub.id }, data: { ...data, status: to } });
    if (from !== to) await this.record(tx, sub, 'STATUS_CHANGED', { from, to, ...why });
    await this.syncTenantStatus(tx, sub.tenantId, to);
    return this.reload(tx, sub.id);
  }

  /** The coupon that applies to an invoice for a period starting at `periodStart`. */
  activeCoupon(sub: Pick<FullSubscription, 'coupon' | 'couponEndsAt'>, periodStart: Date): Coupon | null {
    if (!sub.coupon) return null;
    if (sub.couponEndsAt && periodStart >= sub.couponEndsAt) return null;
    return sub.coupon;
  }

  async createInvoice(
    tx: Tx,
    sub: FullSubscription,
    input: { reason: InvoiceReason; plan: SubscriptionPlan; cycle: BillingCycle; periodStart: Date; periodEnd: Date; dueAt: Date; subtotal?: Prisma.Decimal; description?: string; carry?: { attemptCount: number; nextAttemptAt: Date | null; lastError: string | null } },
  ): Promise<SubscriptionInvoice> {
    const policy = await this.policy(tx);
    const coupon = this.activeCoupon(sub, input.periodStart);
    const subtotal = input.subtotal ?? priceFor(input.plan, input.cycle);
    const amounts = invoiceAmounts(subtotal, couponDiscount(subtotal, coupon, { percentOnly: input.reason === 'UPGRADE' }), policy.taxRatePercent);
    const now = this.clock.now();
    const free = amounts.total.isZero();
    const line: InvoiceLine = {
      description: input.description ?? `${input.plan.name} plan - ${input.cycle === 'ANNUAL' ? 'annual' : 'monthly'} subscription`,
      planId: input.plan.id,
      planKey: input.plan.key,
      planName: input.plan.name,
      billingCycle: input.cycle,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
      amount: amounts.subtotal.toFixed(2),
      couponCode: amounts.discount.gt(0) ? (coupon?.code ?? null) : null,
    };
    const invoice = await tx.subscriptionInvoice.create({
      data: {
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
        number: await this.nextInvoiceNumber(tx),
        status: free ? 'PAID' : 'OPEN',
        reason: input.reason,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ...amounts,
        currency: input.plan.currency,
        lines: [line] as unknown as Prisma.InputJsonValue,
        dueAt: input.dueAt,
        paidAt: free ? now : null,
        paymentMethod: free ? 'NONE' : null,
        attemptCount: input.carry?.attemptCount ?? 0,
        nextAttemptAt: free ? null : (input.carry?.nextAttemptAt ?? null),
        lastError: input.carry?.lastError ?? null,
      },
    });
    await this.record(tx, sub, 'INVOICE_CREATED', { invoiceId: invoice.id, number: invoice.number, reason: input.reason, total: amounts.total.toFixed(2), discount: amounts.discount.toFixed(2), planKey: input.plan.key, billingCycle: input.cycle, dueAt: input.dueAt });
    return invoice;
  }

  async voidInvoice(tx: Tx, sub: { id: string; tenantId: string }, invoice: { id: string; number: string }, reason: string): Promise<boolean> {
    const changed = await tx.subscriptionInvoice.updateMany({ where: { id: invoice.id, status: 'OPEN' }, data: { status: 'VOID', lastError: reason.slice(0, 500), nextAttemptAt: null } });
    if (changed.count) await this.record(tx, sub, 'INVOICE_VOIDED', { invoiceId: invoice.id, number: invoice.number, reason });
    return changed.count > 0;
  }
  async voidOpenInvoices(tx: Tx, sub: { id: string; tenantId: string }, where: Prisma.SubscriptionInvoiceWhereInput, reason: string): Promise<number> {
    const open = await tx.subscriptionInvoice.findMany({ where: { ...where, subscriptionId: sub.id, status: 'OPEN' }, select: { id: true, number: true } });
    let n = 0;
    for (const invoice of open) if (await this.voidInvoice(tx, sub, invoice, reason)) n += 1;
    return n;
  }

  /** The invoice that buys the period starting at `periodStart`, created on first need (idempotent). */
  async ensurePeriodInvoice(tx: Tx, sub: FullSubscription, input: { reason: 'FIRST_PERIOD' | 'RENEWAL'; periodStart: Date; dueAt: Date }): Promise<{ invoice: SubscriptionInvoice; created: boolean }> {
    const existing = await tx.subscriptionInvoice.findFirst({
      where: { subscriptionId: sub.id, reason: { in: PERIOD_REASONS }, periodStart: input.periodStart, status: { in: ['OPEN', 'PAID'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { invoice: existing, created: false };
    const plan = sub.pendingPlan ?? sub.plan;
    const cycle = sub.pendingCycle ?? sub.billingCycle;
    const invoice = await this.createInvoice(tx, sub, { reason: input.reason, plan, cycle, periodStart: input.periodStart, periodEnd: periodEnd(input.periodStart, cycle), dueAt: input.dueAt });
    return { invoice, created: true };
  }

  /**
   * Replaces OPEN period invoices after something that changes their price
   * (coupon applied, plan or cycle change scheduled). Issued amounts are never
   * edited: the old invoice is voided and a new one is issued.
   */
  async reissueOpenPeriodInvoices(tx: Tx, sub: FullSubscription, why: string, opts: { onlyIfPlanOrCycleDiffers?: boolean } = {}): Promise<SubscriptionInvoice[]> {
    const open = await tx.subscriptionInvoice.findMany({ where: { subscriptionId: sub.id, status: 'OPEN', reason: { in: PERIOD_REASONS } } });
    const out: SubscriptionInvoice[] = [];
    for (const old of open) {
      const line = ((old.lines as unknown as InvoiceLine[]) ?? [])[0];
      // An invoice for the period that is already running keeps its plan; one for a future period follows the pending change.
      const future = old.periodStart >= sub.currentPeriodEnd && sub.status !== 'PAST_DUE' && sub.status !== 'GRACE';
      const plan = future ? (sub.pendingPlan ?? sub.plan) : ((await tx.subscriptionPlan.findUnique({ where: { id: line?.planId ?? sub.planId } })) ?? sub.plan);
      const cycle = (future ? (sub.pendingCycle ?? sub.billingCycle) : (line?.billingCycle ?? sub.billingCycle)) as BillingCycle;
      if (opts.onlyIfPlanOrCycleDiffers && line && line.planId === plan.id && line.billingCycle === cycle) continue;
      await this.voidInvoice(tx, sub, old, why);
      out.push(
        await this.createInvoice(tx, sub, {
          reason: old.reason as InvoiceReason,
          plan,
          cycle,
          periodStart: old.periodStart,
          periodEnd: periodEnd(old.periodStart, cycle),
          dueAt: old.dueAt,
          carry: { attemptCount: old.attemptCount, nextAttemptAt: old.nextAttemptAt, lastError: null },
        }),
      );
    }
    return out;
  }

  /**
   * Starts the paid period of an invoice: applies the plan / cycle it was priced
   * for, moves the period, clears dunning state and reactivates the centre.
   * After a lapse (EXPIRED / CANCELLED) the period starts when the money arrives.
   */
  async advance(tx: Tx, sub: FullSubscription, invoice: SubscriptionInvoice): Promise<FullSubscription> {
    const now = this.clock.now();
    const line = ((invoice.lines as unknown as InvoiceLine[]) ?? [])[0];
    const planId = line?.planId ?? sub.planId;
    const cycle = (line?.billingCycle ?? sub.billingCycle) as BillingCycle;
    const lapsed = sub.status === 'EXPIRED' || sub.status === 'CANCELLED';
    const start = lapsed ? now : invoice.periodStart;
    const end = lapsed ? periodEnd(now, cycle) : invoice.periodEnd;
    // Coupon months are counted in periods: the coupon leaves the subscription when a period starts on or after its end date.
    const couponOver = !!sub.couponId && !!sub.couponEndsAt && start >= sub.couponEndsAt;
    const updated = await this.setStatus(
      tx,
      sub,
      'ACTIVE',
      {
        planId,
        billingCycle: cycle,
        // A change scheduled after this invoice was issued stays pending for the following period.
        pendingPlanId: sub.pendingPlanId && sub.pendingPlanId !== planId ? sub.pendingPlanId : null,
        pendingCycle: sub.pendingCycle && sub.pendingCycle !== cycle ? sub.pendingCycle : null,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        graceEndsAt: null,
        renewalReminderAt: null,
        ...(lapsed ? { cancelAtPeriodEnd: false, cancelledAt: null, cancellationReason: null } : {}),
        ...(couponOver ? { couponId: null, couponEndsAt: null } : {}),
      },
      { reason: 'INVOICE_PAID', invoiceId: invoice.id },
    );
    if (planId !== sub.planId) await this.record(tx, sub, 'PLAN_CHANGED', { from: sub.plan.key, to: updated.plan.key, at: 'PERIOD_START' });
    if (cycle !== sub.billingCycle) await this.record(tx, sub, 'CYCLE_CHANGED', { from: sub.billingCycle, to: cycle });
    if (couponOver) await this.record(tx, sub, 'COUPON_ENDED', { couponId: sub.couponId, code: sub.coupon?.code });
    await this.record(tx, sub, sub.status === 'ACTIVE' ? 'RENEWED' : 'ACTIVATED', { invoiceId: invoice.id, periodStart: start, periodEnd: end, planKey: updated.plan.key, billingCycle: cycle, previousStatus: sub.status });
    // Anything still open belongs to a period or an offer that is over.
    await this.voidOpenInvoices(tx, sub, { id: { not: invoice.id }, OR: [{ reason: 'UPGRADE' }, { periodStart: { lte: start } }] }, 'Superseded: a new billing period started.');
    return updated;
  }

  /**
   * OPEN -> PAID exactly once (conditional update), then the consequence of the
   * payment: an upgrade unlocks the new plan; a period invoice starts (or, when
   * paid ahead of time, will start) its period; a lapsed centre is reactivated.
   */
  async markPaid(
    tx: Tx,
    invoiceId: string,
    how: { method: string; reference?: string | null; paidAt?: Date },
  ): Promise<{ outcome: 'PAID' | 'ALREADY_PAID' | 'NOT_PAYABLE'; invoice: SubscriptionInvoice; subscription: FullSubscription }> {
    const before = found(await tx.subscriptionInvoice.findUnique({ where: { id: invoiceId } }), 'Invoice');
    const sub = await this.lockById(tx, before.subscriptionId);
    const now = this.clock.now();
    const changed = await tx.subscriptionInvoice.updateMany({
      where: { id: invoiceId, status: 'OPEN' },
      data: { status: 'PAID', paidAt: how.paidAt ?? now, paymentMethod: how.method, gatewayRef: how.reference ?? before.gatewayRef, lastError: null, nextAttemptAt: null },
    });
    const invoice = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (!changed.count) return { outcome: invoice.status === 'PAID' ? 'ALREADY_PAID' : 'NOT_PAYABLE', invoice, subscription: sub };
    await this.record(tx, sub, 'INVOICE_PAID', { invoiceId, number: invoice.number, total: D(invoice.total).toFixed(2), method: how.method, reference: how.reference ?? null });
    this.auditLater(sub.tenantId, 'subscription.invoice_paid', 'SubscriptionInvoice', invoiceId, `${invoice.number} paid (${invoice.currency} ${D(invoice.total).toFixed(2)}, ${how.method})`, { method: how.method, reference: how.reference ?? null });
    return { outcome: 'PAID', invoice, subscription: await this.applyPaid(tx, sub, invoice) };
  }

  /** Consequence of a paid invoice (also used for invoices that are free because of a coupon). */
  async applyPaid(tx: Tx, sub: FullSubscription, invoice: SubscriptionInvoice): Promise<FullSubscription> {
    const now = this.clock.now();
    if (invoice.reason === 'UPGRADE') {
      const line = ((invoice.lines as unknown as InvoiceLine[]) ?? [])[0];
      if (!line || line.planId === sub.planId) return sub;
      await tx.subscription.update({ where: { id: sub.id }, data: { planId: line.planId, pendingPlanId: sub.pendingPlanId === line.planId ? null : sub.pendingPlanId } });
      await this.record(tx, sub, 'PLAN_CHANGED', { from: sub.plan.key, to: line.planKey, at: 'UPGRADE_PAID', invoiceId: invoice.id });
      // A renewal already issued for the next period was priced for the old plan.
      const updated = await this.reload(tx, sub.id);
      await this.reissueOpenPeriodInvoices(tx, updated, 'Plan upgraded: renewal re-issued at the new price.', { onlyIfPlanOrCycleDiffers: true });
      return this.reload(tx, sub.id);
    }
    const begun = now >= invoice.periodStart;
    if (begun || ['PAST_DUE', 'GRACE', 'EXPIRED', 'CANCELLED'].includes(sub.status)) return this.advance(tx, sub, invoice);
    return sub; // paid ahead of the period end: the lifecycle job starts the period on time
  }

  /** Collection attempt that did not bring in the money: counts it, schedules the next one or starts the grace period. */
  async failAttempt(tx: Tx, sub: FullSubscription, invoice: SubscriptionInvoice, reason: string): Promise<FullSubscription> {
    const policy = await this.policy(tx);
    const now = this.clock.now();
    const attempt = invoice.attemptCount + 1;
    const delay = policy.retryDelaysDays[attempt - 1];
    const exhausted = delay === undefined;
    const nextAttemptAt = exhausted ? null : addDays(now, delay);
    const graceEndsAt = exhausted ? addDays(now, policy.graceDays) : null;
    await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { attemptCount: attempt, nextAttemptAt, lastError: reason.slice(0, 500) } });
    await this.record(tx, sub, 'PAYMENT_ATTEMPT_FAILED', { invoiceId: invoice.id, number: invoice.number, attempt, reason, nextAttemptAt, graceEndsAt });
    this.emit(
      'subscription.payment_failed',
      { subscriptionId: sub.id, invoiceId: invoice.id, invoiceNumber: invoice.number, amount: D(invoice.total).toFixed(2), currency: invoice.currency, attempt, reason, nextAttemptAt, graceEndsAt },
      sub.tenantId,
    );
    if (exhausted) return this.setStatus(tx, sub, 'GRACE', { graceEndsAt }, { reason: 'ATTEMPTS_EXHAUSTED', invoiceId: invoice.id, graceEndsAt });
    if (sub.status !== 'PAST_DUE') return this.setStatus(tx, sub, 'PAST_DUE', {}, { reason: 'INVOICE_UNPAID', invoiceId: invoice.id });
    return sub;
  }

  /** The end of a subscription the centre asked to cancel. */
  async cancelNow(tx: Tx, sub: FullSubscription): Promise<FullSubscription> {
    await this.voidOpenInvoices(tx, sub, {}, 'Subscription cancelled.');
    const updated = await this.setStatus(tx, sub, 'CANCELLED', { cancelledAt: this.clock.now(), pendingPlanId: null, pendingCycle: null, graceEndsAt: null }, { reason: sub.cancellationReason ?? 'CANCELLED_AT_PERIOD_END' });
    await this.record(tx, sub, 'CANCELLED', { reason: sub.cancellationReason });
    this.auditLater(sub.tenantId, 'subscription.cancelled', 'Subscription', sub.id, 'Subscription cancelled at the end of the period', { reason: sub.cancellationReason });
    return updated;
  }

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sys.tx(fn);
  }
  now(): Date {
    return this.clock.now();
  }
}
