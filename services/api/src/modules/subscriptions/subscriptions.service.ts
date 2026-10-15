import { Injectable } from '@nestjs/common';
import type { Coupon, SubscriptionPlan } from '@typease/database';
import type { PlanLimitKey } from '@typease/types';
import type { AdminChangePlanInput, ChangePlanInput, ExtendTrialInput, OfflineSubscriptionPaymentInput, PlatformSubscriptionListQuery, StartPlanInput, SubscriptionInvoiceListQuery } from '@typease/validation';
import { env } from '../../config/env';
import { ctx, runAsTenant } from '../../common/context';
import { Prisma, SystemDb, TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError, Errors, found } from '../../common/errors';
import { offeredFeatures } from '../../common/plan-features';
import { D, pageArgs, pageResult } from '../../common/pagination';
import { UsageService } from '../../common/usage.service';
import { GatewayError } from '../finance/gateways/payment-gateway';
import { PaymentGateways } from '../finance/gateways/payment-gateways';
import { PdfModel, renderPdf } from '../finance/pdf.renderer';
import { TYPEASE_COLORS } from '../tenancy/branding.service';
import { addDays, addMonths, changeKind, couponProblem, CouponProblem, periodEnd, priceFor, proration, usageExceeding } from './billing.calc';
import { BillingCore, FullSubscription, InvoiceLine, PERIOD_REASONS } from './billing.core';
import { PlansService } from './plans.service';

const INVOICE_SORT = ['createdAt', 'dueAt', 'total', 'number'] as const;
const SUB_SORT = ['createdAt', 'currentPeriodEnd', 'status'] as const;
const LIMIT_LABEL: Record<PlanLimitKey, string> = {
  branches: 'active branches',
  staffUsers: 'staff users',
  monthlyRequests: 'requests this month',
  storageMb: 'MB of stored documents',
  aiPages: 'AI pages this month',
  notifications: 'notifications this month',
  corporateClients: 'corporate clients',
};
const COUPON_MESSAGE: Record<CouponProblem, string> = {
  INACTIVE: 'This coupon code is not valid.',
  NOT_STARTED: 'This coupon is not valid yet.',
  EXPIRED: 'This coupon has expired.',
  EXHAUSTED: 'This coupon has already been used the maximum number of times.',
  WRONG_PLAN: 'This coupon is not valid for the chosen plan.',
  WRONG_CURRENCY: 'This coupon is not valid for the currency of the chosen plan.',
};
type Usage = Array<{ metric: PlanLimitKey; used: number; limit: number }>;

const planView = (p: SubscriptionPlan) => ({ id: p.id, key: p.key, name: p.name, description: p.description, monthlyPrice: p.monthlyPrice, annualPrice: p.annualPrice, currency: p.currency, limits: p.limits, features: offeredFeatures(p.features) });
const date = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

/**
 * SaaS subscription of a typing centre: what the owner does (choose a plan,
 * change it, cancel, pay) and what TypEase billing staff do on their behalf.
 * Reads for the owner go through the tenant-scoped connection (row-level
 * security); every change goes through BillingCore on the system connection.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly core: BillingCore,
    private readonly plans: PlansService,
    private readonly usage: UsageService,
    private readonly gateways: PaymentGateways,
  ) {}

  private tenantId(): string {
    return ctx().tenantId!;
  }

  // ------------------------------------------------------------------ read (owner)
  async current() {
    const tenantId = this.tenantId();
    const usage = await this.usage.summary();
    const data = await this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { status: true, suspensionReason: true } });
      const sub = await tx.subscription.findFirst({ where: { tenantId }, include: { plan: true, pendingPlan: true } });
      const open = sub ? await tx.subscriptionInvoice.findMany({ where: { tenantId, subscriptionId: sub.id, status: 'OPEN' }, orderBy: { dueAt: 'asc' } }) : [];
      return { tenant, sub, open };
    });
    const { sub, tenant, open } = data;
    if (!sub) return { tenantStatus: tenant.status, suspendedForNonPayment: false, subscription: null, plan: null, pendingChange: null, coupon: null, usage, openInvoices: [] };
    // Coupons are platform data the tenant-scoped role cannot read; only the one attached to this subscription is shown.
    const coupon = sub.couponId ? await this.sys.client.coupon.findUnique({ where: { id: sub.couponId } }) : null;
    const now = this.core.now();
    return {
      tenantStatus: tenant.status,
      suspendedForNonPayment: tenant.status === 'SUSPENDED' && tenant.suspensionReason === 'SUBSCRIPTION_UNPAID',
      subscription: {
        id: sub.id,
        status: sub.status,
        billingCycle: sub.billingCycle,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        trialEndsAt: sub.trialEndsAt,
        trialDaysLeft: sub.status === 'TRIALING' && sub.trialEndsAt ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000)) : null,
        graceEndsAt: sub.graceEndsAt,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        cancelledAt: sub.cancelledAt,
        cancellationReason: sub.cancellationReason,
        price: priceFor(sub.plan, sub.billingCycle),
      },
      plan: planView(sub.plan),
      pendingChange:
        sub.pendingPlan || sub.pendingCycle
          ? {
              plan: sub.pendingPlan ? { key: sub.pendingPlan.key, name: sub.pendingPlan.name } : null,
              billingCycle: sub.pendingCycle,
              // An upgrade waits for its proration invoice; everything else for the end of the period.
              effective: open.some((i) => i.reason === 'UPGRADE') ? 'AFTER_PAYMENT' : 'PERIOD_END',
              effectiveAt: sub.currentPeriodEnd,
            }
          : null,
      coupon: coupon && (!sub.couponEndsAt || sub.couponEndsAt > now) ? { code: coupon.code, description: coupon.description, percentOff: coupon.percentOff, amountOff: coupon.amountOff, currency: coupon.currency, endsAt: sub.couponEndsAt } : null,
      usage,
      openInvoices: open.map((i) => ({ id: i.id, number: i.number, reason: i.reason, total: i.total, currency: i.currency, dueAt: i.dueAt, overdue: i.dueAt < now })),
    };
  }

  async invoices(query: SubscriptionInvoiceListQuery) {
    const tenantId = this.tenantId();
    return this.db.tx(async (tx) => {
      const where: Prisma.SubscriptionInvoiceWhereInput = { tenantId, ...(query.status ? { status: query.status } : {}), ...(query.q ? { number: { contains: query.q, mode: 'insensitive' } } : {}) };
      const [rows, total] = await Promise.all([tx.subscriptionInvoice.findMany({ where, ...pageArgs(query, INVOICE_SORT, 'createdAt:desc') }), tx.subscriptionInvoice.count({ where })]);
      return pageResult(rows.map(({ gatewayRef: _g, ...r }) => r), total, query);
    });
  }

  async invoice(id: string) {
    const tenantId = this.tenantId();
    const { gatewayRef: _g, ...invoice } = found(await this.db.tx((tx) => tx.subscriptionInvoice.findFirst({ where: { id, tenantId } })), 'Invoice');
    return invoice;
  }

  async invoicePdf(id: string, forTenantId?: string) {
    const tenantId = forTenantId ?? this.tenantId();
    const invoice = found(await this.sys.client.subscriptionInvoice.findFirst({ where: { id, tenantId } }), 'Invoice');
    const tenant = await this.sys.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const lines = (invoice.lines as unknown as InvoiceLine[]) ?? [];
    const model: PdfModel = {
      title: 'Subscription invoice',
      number: invoice.number,
      currency: invoice.currency,
      brand: { name: 'TypEase', legalName: 'Typing Made Easy.', colors: TYPEASE_COLORS, footer: 'TypEase subscription billing. This invoice is for the TypEase platform, not for services to your customers.', poweredBy: false },
      meta: [
        ['Issued', date(invoice.createdAt)],
        ['Due', date(invoice.dueAt)],
        ['Status', invoice.status],
        ...(invoice.paidAt ? ([['Paid', date(invoice.paidAt)]] as Array<[string, string]>) : []),
        ['Period', `${date(invoice.periodStart)} to ${date(invoice.periodEnd)}`],
      ],
      party: { heading: 'Billed to', lines: [tenant.legalName ?? tenant.name, tenant.name, tenant.taxRegistrationNo ? `TRN ${tenant.taxRegistrationNo}` : '', tenant.contactEmail ?? ''].filter((v, i, a) => !!v && a.indexOf(v) === i) },
      sections: [
        {
          title: 'TypEase subscription',
          rows: lines.map((l) => ({ description: l.description, quantity: '1', unitAmount: D(l.amount).toFixed(2), discount: '-', tax: '-', total: D(l.amount).toFixed(2) })),
          subtotalLabel: 'Subtotal',
          subtotal: D(invoice.subtotal).toFixed(2),
        },
      ],
      totals: [
        { label: 'Subtotal', value: D(invoice.subtotal).toFixed(2) },
        { label: lines[0]?.couponCode ? `Discount (${lines[0].couponCode})` : 'Discount', value: D(invoice.discount).gt(0) ? `-${D(invoice.discount).toFixed(2)}` : '0.00' },
        { label: 'Tax', value: D(invoice.tax).toFixed(2) },
        { label: 'Total', value: D(invoice.total).toFixed(2), strong: true },
        { label: invoice.status === 'PAID' ? 'Paid' : 'Amount due', value: D(invoice.status === 'PAID' ? invoice.total : invoice.status === 'OPEN' ? invoice.total : 0).toFixed(2), strong: true },
      ],
      stamp: invoice.status === 'VOID' ? 'VOID' : null,
    };
    return { filename: `typease-invoice-${invoice.number}.pdf`, content: await renderPdf(model) };
  }

  // ------------------------------------------------------------------ coupons
  /** Validates a coupon for a plan and takes one redemption (atomically, so the last one cannot be taken twice). */
  private async redeem(tx: Tx, code: string, plan: SubscriptionPlan, tenantId: string): Promise<{ coupon: Coupon; couponEndsAt: Date | null }> {
    const coupon = await tx.coupon.findUnique({ where: { code } });
    if (!coupon) throw Errors.unprocessable('INVALID_COUPON', COUPON_MESSAGE.INACTIVE);
    const now = this.core.now();
    const problem = couponProblem(coupon, plan, now);
    if (problem) throw Errors.unprocessable(problem === 'EXHAUSTED' ? 'COUPON_EXHAUSTED' : 'INVALID_COUPON', COUPON_MESSAGE[problem], { problem });
    const usedBefore = await tx.subscriptionEvent.findFirst({ where: { tenantId, type: 'COUPON_APPLIED', data: { path: ['couponId'], equals: coupon.id } } });
    if (usedBefore) throw Errors.conflict('COUPON_ALREADY_USED', 'Your centre has already used this coupon.');
    const taken = await tx.$executeRaw`
      UPDATE "coupons" SET "redeemedCount" = "redeemedCount" + 1
      WHERE "id" = ${coupon.id}::uuid AND ("maxRedemptions" IS NULL OR "redeemedCount" < "maxRedemptions")`;
    if (!taken) throw Errors.unprocessable('COUPON_EXHAUSTED', COUPON_MESSAGE.EXHAUSTED, { problem: 'EXHAUSTED' });
    return { coupon, couponEndsAt: coupon.durationMonths ? addMonths(now, coupon.durationMonths) : null };
  }

  async applyCoupon(code: string, tenantId: string = this.tenantId()) {
    await this.core.tx(async (tx) => {
      const sub = found(await this.core.lockByTenant(tx, tenantId), 'Subscription');
      if (['CANCELLED', 'EXPIRED'].includes(sub.status)) throw Errors.conflict('SUBSCRIPTION_NOT_ACTIVE', 'This subscription has ended. Start a new subscription and enter the coupon there.');
      const now = this.core.now();
      if (sub.couponId && (!sub.couponEndsAt || sub.couponEndsAt > now)) throw Errors.conflict('COUPON_ALREADY_APPLIED', `The coupon ${sub.coupon?.code} is already active on this subscription. Only one coupon can be used at a time.`);
      const { coupon, couponEndsAt } = await this.redeem(tx, code, sub.pendingPlan ?? sub.plan, tenantId);
      await tx.subscription.update({ where: { id: sub.id }, data: { couponId: coupon.id, couponEndsAt } });
      await this.core.record(tx, sub, 'COUPON_APPLIED', { couponId: coupon.id, code: coupon.code, percentOff: coupon.percentOff, amountOff: coupon.amountOff, endsAt: couponEndsAt });
      this.core.auditLater(tenantId, 'subscription.coupon_applied', 'Subscription', sub.id, `Coupon ${coupon.code} applied`, { code: coupon.code });
      // Invoices that are still open are re-issued with the discount.
      await this.core.reissueOpenPeriodInvoices(tx, await this.core.reload(tx, sub.id), `Coupon ${coupon.code} applied.`);
    });
    return tenantId === ctx().tenantId ? this.current() : this.billingOf(tenantId);
  }

  // ------------------------------------------------------------------ start / restart
  /**
   * Onboarding step "choose your plan" (and coming back after a cancellation).
   * A first subscription on a plan with trial days starts as a trial without an
   * invoice; anything else gets an OPEN invoice that has to be paid.
   * tenants.status is not touched here: onboarding completion and the lifecycle job own it.
   */
  async start(input: StartPlanInput) {
    const tenantId = this.tenantId();
    const result = await this.core.tx(async (tx) => {
      const plan = await this.plans.selectable(tx, input.planKey);
      const existing = await this.core.lockByTenant(tx, tenantId);
      if (existing && !['CANCELLED', 'EXPIRED'].includes(existing.status)) {
        throw Errors.conflict('ALREADY_SUBSCRIBED', 'Your centre already has a subscription. Use "change plan" to switch.');
      }
      const now = this.core.now();
      const policy = await this.core.policy(tx);
      const redeemed = input.couponCode ? await this.redeem(tx, input.couponCode, plan, tenantId) : null;
      const couponData = redeemed ? { couponId: redeemed.coupon.id, couponEndsAt: redeemed.couponEndsAt } : {};

      if (!existing && plan.trialDays > 0) {
        const trialEndsAt = addDays(now, plan.trialDays);
        const created = await tx.subscription.create({
          data: { tenantId, planId: plan.id, status: 'TRIALING', billingCycle: input.billingCycle, currentPeriodStart: now, currentPeriodEnd: trialEndsAt, trialEndsAt, ...couponData },
        });
        await this.core.record(tx, created, 'TRIAL_STARTED', { planKey: plan.key, billingCycle: input.billingCycle, trialEndsAt, trialDays: plan.trialDays });
        if (redeemed) await this.core.record(tx, created, 'COUPON_APPLIED', { couponId: redeemed.coupon.id, code: redeemed.coupon.code, endsAt: redeemed.couponEndsAt });
        this.core.auditLater(tenantId, 'subscription.trial_started', 'Subscription', created.id, `Trial of ${plan.name} started (${plan.trialDays} days)`, { planKey: plan.key });
        return { outcome: 'TRIAL_STARTED' as const, invoiceId: null as string | null };
      }

      let sub: FullSubscription;
      if (!existing) {
        // No trial on this plan: the first period is invoiced straight away and is due now.
        const created = await tx.subscription.create({
          data: { tenantId, planId: plan.id, status: 'PAST_DUE', billingCycle: input.billingCycle, currentPeriodStart: now, currentPeriodEnd: periodEnd(now, input.billingCycle), ...couponData },
        });
        sub = await this.core.reload(tx, created.id);
        await this.core.record(tx, sub, 'STARTED', { planKey: plan.key, billingCycle: input.billingCycle, trial: false });
      } else {
        // Coming back after a cancellation or a lapse: never a second trial.
        await this.core.voidOpenInvoices(tx, existing, {}, 'Superseded by a new subscription.');
        await tx.subscription.update({
          where: { id: existing.id },
          data: { planId: plan.id, billingCycle: input.billingCycle, pendingPlanId: null, pendingCycle: null, cancelAtPeriodEnd: false, graceEndsAt: null, ...(redeemed ? couponData : { couponId: null, couponEndsAt: null }) },
        });
        sub = await this.core.reload(tx, existing.id);
        await this.core.record(tx, sub, 'RESTART_REQUESTED', { planKey: plan.key, billingCycle: input.billingCycle, previousStatus: existing.status });
      }
      if (redeemed) await this.core.record(tx, sub, 'COUPON_APPLIED', { couponId: redeemed.coupon.id, code: redeemed.coupon.code, endsAt: redeemed.couponEndsAt });
      const invoice = await this.core.createInvoice(tx, sub, {
        reason: existing ? 'RESTART' : 'FIRST_PERIOD',
        plan,
        cycle: input.billingCycle,
        periodStart: now,
        periodEnd: periodEnd(now, input.billingCycle),
        dueAt: now,
        // A brand-new subscription is reminded after a day; a lapsed one simply stays lapsed until it is paid.
        carry: existing ? undefined : { attemptCount: 0, nextAttemptAt: addDays(now, policy.retryDelaysDays[0] ?? 1), lastError: null },
      });
      if (invoice.status === 'PAID') await this.core.applyPaid(tx, sub, invoice); // free because of a coupon
      this.core.auditLater(tenantId, 'subscription.started', 'Subscription', sub.id, `${plan.name} (${input.billingCycle}) chosen; invoice ${invoice.number}`, { planKey: plan.key, invoice: invoice.number });
      return { outcome: invoice.status === 'PAID' ? ('ACTIVE' as const) : ('PAYMENT_REQUIRED' as const), invoiceId: invoice.id };
    });
    return { ...result, ...(await this.current()) };
  }

  // ------------------------------------------------------------------ change plan
  private describeExcess(excess: ReturnType<typeof usageExceeding>, plan: SubscriptionPlan): string {
    const parts = excess.map((e) => `${e.used} ${LIMIT_LABEL[e.metric]} (the ${plan.name} plan includes ${e.limit})`);
    return `You cannot move to the ${plan.name} plan yet: your centre currently has ${parts.join(' and ')}. Reduce this first, then try again.`;
  }

  /**
   * Upgrade: immediate, with a proration invoice; the new plan unlocks when it is
   * paid (immediately during a trial). Downgrade and monthly <-> annual switches
   * take effect at the end of the period. A change to a plan whose limits the
   * centre already exceeds is refused.
   */
  private async change(tenantId: string, input: { planKey: string; billingCycle?: 'MONTHLY' | 'ANNUAL' }, usage: Usage, opts: { byPlatform?: boolean; immediate?: boolean; reason?: string } = {}) {
    return this.core.tx(async (tx) => {
      const sub = found(await this.core.lockByTenant(tx, tenantId), 'Subscription');
      if (sub.status === 'PAST_DUE' || sub.status === 'GRACE') throw Errors.conflict('PAYMENT_OUTSTANDING', 'Please pay the outstanding invoice before changing your plan.');
      if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') throw Errors.conflict('SUBSCRIPTION_NOT_ACTIVE', 'This subscription has ended. Start a new subscription to choose a plan.');
      const target = await this.plans.selectable(tx, input.planKey, { allowPrivate: opts.byPlatform });
      if (target.currency !== sub.plan.currency) throw Errors.unprocessable('PLAN_NOT_AVAILABLE', 'That plan is billed in a different currency. Please contact TypEase support.');
      const cycle = input.billingCycle ?? sub.billingCycle;
      const now = this.core.now();
      const oldPrice = priceFor(sub.plan, sub.billingCycle);
      const newPrice = priceFor(target, sub.billingCycle);
      const kind = changeKind({ planId: sub.planId, cycle: sub.billingCycle, price: oldPrice }, { planId: target.id, cycle, priceAtCurrentCycle: newPrice });

      if (kind === 'NONE') {
        if (!sub.pendingPlanId && !sub.pendingCycle) throw Errors.conflict('NO_CHANGE', `Your centre is already on the ${target.name} plan with ${cycle.toLowerCase()} billing.`);
        // Choosing the current plan again withdraws a scheduled change.
        await this.core.voidOpenInvoices(tx, sub, { reason: 'UPGRADE' }, 'Plan change withdrawn.');
        await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null, pendingCycle: null } });
        await this.core.record(tx, sub, 'PLAN_CHANGE_WITHDRAWN', { pendingPlan: sub.pendingPlan?.key ?? null, pendingCycle: sub.pendingCycle });
        await this.core.reissueOpenPeriodInvoices(tx, await this.core.reload(tx, sub.id), 'Plan change withdrawn.', { onlyIfPlanOrCycleDiffers: true });
        return { kind: 'WITHDRAWN' as const, effective: 'NOW' as const, invoiceId: null as string | null, amount: null as string | null };
      }
      if (kind !== 'CYCLE_ONLY') {
        const excess = usageExceeding(usage, target.limits as Record<string, number>);
        if (excess.length) throw Errors.unprocessable('DOWNGRADE_BLOCKED_BY_USAGE', this.describeExcess(excess, target), { exceeded: excess });
      }
      await this.core.voidOpenInvoices(tx, sub, { reason: 'UPGRADE' }, 'Superseded by a newer plan change.');
      const applyNow = async (via: string) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: { planId: target.id, pendingPlanId: null, ...(sub.status === 'TRIALING' ? { billingCycle: cycle, pendingCycle: null } : { pendingCycle: cycle !== sub.billingCycle ? cycle : null }) },
        });
        await this.core.record(tx, sub, 'PLAN_CHANGED', { from: sub.plan.key, to: target.key, at: via, billingCycle: cycle, ...(opts.reason ? { reason: opts.reason } : {}) });
        this.core.auditLater(tenantId, 'subscription.plan_changed', 'Subscription', sub.id, `${sub.plan.name} -> ${target.name} (${via})`, { from: sub.plan.key, to: target.key, via, reason: opts.reason ?? null });
        await this.core.reissueOpenPeriodInvoices(tx, await this.core.reload(tx, sub.id), 'Plan changed.', { onlyIfPlanOrCycleDiffers: true });
        return { kind, effective: 'NOW' as const, invoiceId: null as string | null, amount: null as string | null };
      };

      if (sub.status === 'TRIALING') return applyNow('TRIAL');
      if (opts.immediate && opts.byPlatform && kind !== 'CYCLE_ONLY') return applyNow('PLATFORM_OVERRIDE');

      if (kind === 'UPGRADE') {
        const amount = proration(oldPrice, newPrice, sub.currentPeriodStart, sub.currentPeriodEnd, now);
        if (amount.isZero()) return applyNow('UPGRADE_NO_CHARGE');
        const invoice = await this.core.createInvoice(tx, sub, {
          reason: 'UPGRADE',
          plan: target,
          cycle: sub.billingCycle,
          periodStart: now,
          periodEnd: sub.currentPeriodEnd,
          dueAt: now,
          subtotal: amount,
          description: `Upgrade from ${sub.plan.name} to ${target.name} - prorated for the rest of the current period (${date(now)} to ${date(sub.currentPeriodEnd)})`,
        });
        if (invoice.status === 'PAID') {
          await this.core.applyPaid(tx, sub, invoice); // nothing to pay after the coupon
          if (cycle !== sub.billingCycle) await tx.subscription.update({ where: { id: sub.id }, data: { pendingCycle: cycle } });
          return { kind, effective: 'NOW' as const, invoiceId: invoice.id, amount: D(invoice.total).toFixed(2) };
        }
        await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id, pendingCycle: cycle !== sub.billingCycle ? cycle : null } });
        await this.core.record(tx, sub, 'UPGRADE_REQUESTED', { from: sub.plan.key, to: target.key, invoiceId: invoice.id, amount: D(invoice.total).toFixed(2) });
        await this.core.reissueOpenPeriodInvoices(tx, await this.core.reload(tx, sub.id), 'Plan upgrade requested.', { onlyIfPlanOrCycleDiffers: true });
        return { kind, effective: 'AFTER_PAYMENT' as const, invoiceId: invoice.id, amount: D(invoice.total).toFixed(2) };
      }

      // DOWNGRADE or CYCLE_ONLY: at the end of the period.
      await tx.subscription.update({
        where: { id: sub.id },
        data: { pendingPlanId: kind === 'DOWNGRADE' ? target.id : sub.pendingPlanId, pendingCycle: cycle !== sub.billingCycle ? cycle : kind === 'DOWNGRADE' ? null : sub.pendingCycle },
      });
      await this.core.record(tx, sub, kind === 'DOWNGRADE' ? 'PLAN_CHANGE_SCHEDULED' : 'CYCLE_CHANGE_SCHEDULED', { from: sub.plan.key, to: target.key, billingCycle: cycle, effectiveAt: sub.currentPeriodEnd, ...(opts.reason ? { reason: opts.reason } : {}) });
      this.core.auditLater(tenantId, 'subscription.change_scheduled', 'Subscription', sub.id, `${kind === 'DOWNGRADE' ? `Downgrade to ${target.name}` : `Switch to ${cycle.toLowerCase()} billing`} scheduled for ${date(sub.currentPeriodEnd)}`, { to: target.key, billingCycle: cycle });
      await this.core.reissueOpenPeriodInvoices(tx, await this.core.reload(tx, sub.id), 'Plan change scheduled.', { onlyIfPlanOrCycleDiffers: true });
      return { kind, effective: 'PERIOD_END' as const, invoiceId: null as string | null, amount: null as string | null };
    });
  }

  async changePlan(input: ChangePlanInput) {
    const usage = await this.usage.summary();
    const change = await this.change(this.tenantId(), input, usage);
    return { change, ...(await this.current()) };
  }

  // ------------------------------------------------------------------ cancel / resume
  async cancel(reason: string) {
    const tenantId = this.tenantId();
    await this.core.tx(async (tx) => {
      const sub = found(await this.core.lockByTenant(tx, tenantId), 'Subscription');
      if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') throw Errors.conflict('SUBSCRIPTION_NOT_ACTIVE', 'This subscription has already ended.');
      if (sub.cancelAtPeriodEnd) throw Errors.conflict('ALREADY_CANCELLING', `Your subscription is already set to end on ${date(sub.currentPeriodEnd)}.`);
      // A future renewal and any pending change no longer apply.
      await this.core.voidOpenInvoices(tx, sub, { OR: [{ reason: 'UPGRADE' }, { reason: 'RENEWAL', periodStart: { gte: sub.currentPeriodEnd } }] }, 'Subscription set to cancel.');
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, cancellationReason: reason, pendingPlanId: null, pendingCycle: null } });
      await this.core.record(tx, sub, 'CANCEL_SCHEDULED', { reason, effectiveAt: sub.currentPeriodEnd });
      this.core.auditLater(tenantId, 'subscription.cancel_scheduled', 'Subscription', sub.id, `Cancellation scheduled for ${date(sub.currentPeriodEnd)}`, { reason });
      // Already past the period it paid for (unpaid renewal): there is nothing left to wait for.
      if (this.core.now() >= sub.currentPeriodEnd) await this.core.cancelNow(tx, await this.core.reload(tx, sub.id));
    });
    return this.current();
  }

  async resume() {
    const tenantId = this.tenantId();
    await this.core.tx(async (tx) => {
      const sub = found(await this.core.lockByTenant(tx, tenantId), 'Subscription');
      if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') throw Errors.conflict('SUBSCRIPTION_NOT_ACTIVE', 'This subscription has already ended. Start a new subscription instead.');
      if (!sub.cancelAtPeriodEnd) throw Errors.conflict('NOT_CANCELLING', 'Your subscription is not set to cancel.');
      await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false, cancellationReason: null } });
      await this.core.record(tx, sub, 'RESUMED', {});
      this.core.auditLater(tenantId, 'subscription.resumed', 'Subscription', sub.id, 'Cancellation withdrawn');
    });
    return this.current();
  }

  // ------------------------------------------------------------------ pay online (platform gateway)
  async pay(invoiceId: string) {
    const tenantId = this.tenantId();
    const invoice = found(await this.sys.client.subscriptionInvoice.findFirst({ where: { id: invoiceId, tenantId } }), 'Invoice');
    if (invoice.status !== 'OPEN') {
      throw Errors.conflict('INVOICE_NOT_PAYABLE', invoice.status === 'PAID' ? 'This invoice is already paid.' : `This invoice is ${invoice.status.toLowerCase()} and cannot be paid.`);
    }
    const gateway = this.gateways.platform();
    const back = (result: string) => `${env().CENTRE_WEB_URL}/settings/subscription?invoice=${invoice.id}&result=${result}`;
    let session: Awaited<ReturnType<typeof gateway.createCheckout>>;
    try {
      session = await gateway.createCheckout({
        channel: 'subscriptions',
        reference: invoice.id,
        amount: D(invoice.total).toFixed(2),
        currency: invoice.currency,
        description: `TypEase subscription invoice ${invoice.number}`,
        successUrl: back('success'),
        cancelUrl: back('cancelled'),
        metadata: { tenantId, subscriptionInvoiceId: invoice.id, subscriptionId: invoice.subscriptionId },
      });
    } catch (e: any) {
      const reason = e instanceof GatewayError ? e.message : 'The payment gateway could not be reached.';
      throw new AppError(502, 'GATEWAY_ERROR', `The payment page could not be opened: ${reason} Please try again or contact TypEase support.`);
    }
    await this.core.tx(async (tx) => {
      await tx.subscriptionInvoice.updateMany({ where: { id: invoice.id, status: 'OPEN' }, data: { gatewayRef: session.sessionRef } });
      await this.core.record(tx, { id: invoice.subscriptionId, tenantId }, 'CHECKOUT_STARTED', { invoiceId: invoice.id, number: invoice.number, gateway: gateway.name });
    });
    return { invoiceId: invoice.id, number: invoice.number, amount: D(invoice.total).toFixed(2), currency: invoice.currency, gateway: gateway.name, testMode: gateway.isTest, checkoutUrl: session.checkoutUrl, expiresAt: session.expiresAt };
  }

  // ================================================================== platform billing administration
  async listSubscriptions(query: PlatformSubscriptionListQuery) {
    const where: Prisma.SubscriptionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.billingCycle ? { billingCycle: query.billingCycle } : {}),
      ...(query.planKey ? { plan: { key: query.planKey } } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.q ? { tenant: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { slug: { contains: query.q.toLowerCase() } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.sys.client.subscription.findMany({
        where,
        ...pageArgs(query, SUB_SORT, 'createdAt:desc'),
        include: { tenant: { select: { id: true, slug: true, name: true, status: true } }, plan: { select: { key: true, name: true, monthlyPrice: true, annualPrice: true, currency: true } }, pendingPlan: { select: { key: true, name: true } }, coupon: { select: { code: true } } },
      }),
      this.sys.client.subscription.count({ where }),
    ]);
    return pageResult(rows.map(({ gatewayCustomerRef: _g, ...r }) => r), total, query);
  }

  /** One centre's subscription, invoices and the full event history. */
  async billingOf(tenantId: string) {
    const tenant = found(await this.sys.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true, name: true, status: true, suspensionReason: true } }), 'Centre');
    const [subscription, invoices, events] = await Promise.all([
      this.sys.client.subscription.findUnique({ where: { tenantId }, include: { plan: true, pendingPlan: true, coupon: true } }),
      this.sys.client.subscriptionInvoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.sys.client.subscriptionEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 200 }),
    ]);
    return { tenant, subscription, invoices, events };
  }

  async recordOfflinePayment(invoiceId: string, input: OfflineSubscriptionPaymentInput) {
    const result = await this.core.tx(async (tx) => {
      const paidAt = input.paidAt ? new Date(input.paidAt) : undefined;
      if (paidAt && paidAt.getTime() > this.core.now().getTime() + 5 * 60_000) throw Errors.unprocessable('PAID_IN_FUTURE', 'The payment date cannot be in the future.');
      const r = await this.core.markPaid(tx, invoiceId, { method: `OFFLINE:${input.method}`, reference: input.reference, paidAt });
      if (r.outcome === 'ALREADY_PAID') throw Errors.conflict('INVOICE_NOT_PAYABLE', 'This invoice is already paid.');
      if (r.outcome === 'NOT_PAYABLE') throw Errors.conflict('INVOICE_NOT_PAYABLE', `This invoice is ${r.invoice.status.toLowerCase()} and cannot be paid.`);
      this.core.auditLater(r.invoice.tenantId, 'platform.subscription_offline_payment', 'SubscriptionInvoice', invoiceId, `${r.invoice.number}: offline payment recorded (${input.method}, ${input.reference})`, { method: input.method, reference: input.reference });
      return r;
    });
    return { invoice: result.invoice, ...(await this.billingOf(result.invoice.tenantId)) };
  }

  async voidInvoice(invoiceId: string, reason: string) {
    const invoice = found(await this.sys.client.subscriptionInvoice.findUnique({ where: { id: invoiceId } }), 'Invoice');
    await this.core.tx(async (tx) => {
      const sub = await this.core.lockById(tx, invoice.subscriptionId);
      if (!(await this.core.voidInvoice(tx, sub, invoice, reason))) throw Errors.conflict('INVOICE_NOT_OPEN', 'Only an open invoice can be voided.');
      // A voided upgrade invoice also withdraws the upgrade it was for.
      if (invoice.reason === 'UPGRADE' && sub.pendingPlanId) await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null } });
      this.core.auditLater(invoice.tenantId, 'platform.subscription_invoice_voided', 'SubscriptionInvoice', invoiceId, `${invoice.number} voided: ${reason}`, { reason });
    });
    return this.billingOf(invoice.tenantId);
  }

  /** More trial time for a centre still in trial, or one whose trial just ran out without a payment. */
  async extendTrial(tenantId: string, input: ExtendTrialInput) {
    await this.core.tx(async (tx) => {
      const sub = found(await this.core.lockByTenant(tx, tenantId), 'Subscription');
      const now = this.core.now();
      const everPaid = await tx.subscriptionInvoice.count({ where: { subscriptionId: sub.id, status: 'PAID', reason: { in: PERIOD_REASONS }, total: { gt: 0 } } });
      if (sub.status === 'TRIALING') {
        const trialEndsAt = addDays(sub.trialEndsAt ?? now, input.days);
        await tx.subscription.update({ where: { id: sub.id }, data: { trialEndsAt, currentPeriodEnd: trialEndsAt, renewalReminderAt: null } });
        await this.core.record(tx, sub, 'TRIAL_EXTENDED', { days: input.days, trialEndsAt, reason: input.reason });
      } else if (!everPaid && sub.trialEndsAt && ['PAST_DUE', 'GRACE', 'EXPIRED'].includes(sub.status)) {
        const trialEndsAt = addDays(now, input.days);
        await this.core.voidOpenInvoices(tx, sub, {}, 'Trial extended by TypEase.');
        await this.core.setStatus(tx, sub, 'TRIALING', { trialEndsAt, currentPeriodEnd: trialEndsAt, graceEndsAt: null, renewalReminderAt: null }, { reason: 'TRIAL_EXTENDED' });
        await this.core.record(tx, sub, 'TRIAL_EXTENDED', { days: input.days, trialEndsAt, reason: input.reason, reopened: true });
      } else {
        throw Errors.conflict('NOT_IN_TRIAL', 'Only a centre that is in its trial, or whose trial ended without a payment, can get more trial time.');
      }
      this.core.auditLater(tenantId, 'platform.subscription_trial_extended', 'Subscription', sub.id, `Trial extended by ${input.days} day(s): ${input.reason}`, { days: input.days, reason: input.reason });
    });
    return this.billingOf(tenantId);
  }

  async changePlanOnBehalf(tenantId: string, input: AdminChangePlanInput) {
    found(await this.sys.client.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }), 'Centre');
    // Usage is counted inside the centre's own row-level-security context.
    const usage = await runAsTenant(tenantId, () => this.usage.summary(), { actorLabel: 'platform:billing' });
    const change = await this.change(tenantId, input, usage, { byPlatform: true, immediate: input.immediate, reason: input.reason });
    return { change, ...(await this.billingOf(tenantId)) };
  }
}
