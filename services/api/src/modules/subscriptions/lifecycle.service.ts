import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SystemDb, Tx } from '../../common/db/prisma.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { D } from '../../common/pagination';
import { addDays, priceFor } from './billing.calc';
import { BillingCore, FullSubscription, PERIOD_REASONS } from './billing.core';

export const LIFECYCLE_JOB = 'subscriptions.lifecycle';
const NO_SAVED_METHOD = 'No payment was received by the due date. TypEase does not store card details, so the invoice has to be paid from the subscription page (or by bank transfer).';

export interface LifecycleSummary {
  checked: number;
  changed: number;
  failed: number;
}

/**
 * Hourly subscription lifecycle. Cross-tenant by nature, so it runs on the
 * system connection; each subscription is handled in its own transaction with
 * the row locked, so a run can be repeated or overlap with a payment safely
 * (idempotent: every step first checks whether it has already been done).
 *
 *   TRIALING  3 days before the end       -> subscription.renewal_due (once)
 *             trial over                  -> first invoice; unpaid = PAST_DUE
 *   ACTIVE    7 days before period end    -> renewal invoice + subscription.renewal_due
 *             period over, invoice paid   -> next period starts, pending plan / cycle applied
 *             period over, unpaid         -> PAST_DUE, collection attempts (subscription.payment_failed each time)
 *   PAST_DUE  attempts used up            -> GRACE for 7 days
 *   GRACE     grace over                  -> EXPIRED, centre SUSPENDED (reason SUBSCRIPTION_UNPAID)
 *   any       cancelAtPeriodEnd + period over -> CANCELLED, centre CANCELLED
 *
 * A payment at any point (see BillingCore.markPaid) reactivates the subscription.
 */
@Injectable()
export class SubscriptionLifecycle implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionLifecycle.name);

  constructor(
    private readonly sys: SystemDb,
    private readonly core: BillingCore,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit() {
    this.jobs.register(LIFECYCLE_JOB, async () => void (await this.run()), { attempts: 1 });
    this.jobs.schedule({ name: LIFECYCLE_JOB, cron: '0 * * * *', description: 'SaaS subscriptions: trial end, renewal invoices, failed payments, grace period, suspension and cancellation.' });
  }

  async run(): Promise<LifecycleSummary> {
    // Ended subscriptions are included too: their centre's status is re-checked on every run (see tick).
    const subs = await this.sys.client.subscription.findMany({ select: { id: true, tenantId: true }, orderBy: { currentPeriodEnd: 'asc' } });
    const summary: LifecycleSummary = { checked: subs.length, changed: 0, failed: 0 };
    for (const s of subs) {
      try {
        if (await this.tick(s.tenantId)) summary.changed += 1;
      } catch (e: any) {
        // One centre's problem never stops the billing of the others.
        summary.failed += 1;
        this.logger.error(`lifecycle failed for subscription ${s.id}: ${e?.stack ?? e}`);
      }
    }
    return summary;
  }

  /** One step for one subscription. Returns true when something changed. */
  async tick(tenantId: string): Promise<boolean> {
    return this.core.tx(async (tx) => {
      const sub = await this.core.lockByTenant(tx, tenantId);
      if (!sub) return false;
      let changed = false;
      if (sub.status === 'TRIALING') changed = await this.trialing(tx, sub);
      else if (sub.status === 'ACTIVE') changed = await this.active(tx, sub);
      else if (sub.status === 'PAST_DUE') changed = await this.pastDue(tx, sub);
      else if (sub.status === 'GRACE') changed = await this.grace(tx, sub);
      // Reconcile the centre's status on every run, not only on transitions: a centre that finishes
      // onboarding (or is approved) after its subscription lapsed must not stay ACTIVE for free.
      const current = changed ? await this.core.reload(tx, sub.id) : sub;
      const synced = await this.core.syncTenantStatus(tx, tenantId, current.status);
      return changed || synced;
    });
  }

  private renewalDue(sub: FullSubscription, invoice: { id: string; number: string; total: unknown; currency: string; dueAt: Date } | null, extra: Record<string, unknown>) {
    const plan = sub.pendingPlan ?? sub.plan;
    this.core.emit(
      'subscription.renewal_due',
      {
        subscriptionId: sub.id,
        dueAt: invoice?.dueAt ?? sub.currentPeriodEnd,
        amount: invoice ? D(invoice.total as any).toFixed(2) : priceFor(plan, sub.pendingCycle ?? sub.billingCycle).toFixed(2),
        currency: invoice?.currency ?? plan.currency,
        invoiceId: invoice?.id ?? null,
        invoiceNumber: invoice?.number ?? null,
        planKey: plan.key,
        planName: plan.name,
        ...extra,
      },
      sub.tenantId,
    );
  }

  private async trialing(tx: Tx, sub: FullSubscription): Promise<boolean> {
    const now = this.core.now();
    const policy = await this.core.policy(tx);
    const trialEndsAt = sub.trialEndsAt ?? sub.currentPeriodEnd;
    if (now < trialEndsAt) {
      if (sub.cancelAtPeriodEnd || sub.renewalReminderAt || now < addDays(trialEndsAt, -policy.trialReminderDays)) return false;
      await tx.subscription.update({ where: { id: sub.id }, data: { renewalReminderAt: now } });
      await this.core.record(tx, sub, 'TRIAL_ENDING', { trialEndsAt });
      this.renewalDue(sub, null, { kind: 'TRIAL_ENDING', trialEndsAt });
      return true;
    }
    await this.core.record(tx, sub, 'TRIAL_ENDED', { trialEndsAt });
    if (sub.cancelAtPeriodEnd) {
      await this.core.cancelNow(tx, sub);
      return true;
    }
    const { invoice } = await this.core.ensurePeriodInvoice(tx, sub, { reason: 'FIRST_PERIOD', periodStart: trialEndsAt, dueAt: trialEndsAt });
    if (invoice.status === 'PAID') await this.core.advance(tx, sub, invoice);
    else await this.core.failAttempt(tx, sub, invoice, NO_SAVED_METHOD);
    return true;
  }

  private async active(tx: Tx, sub: FullSubscription): Promise<boolean> {
    const now = this.core.now();
    const policy = await this.core.policy(tx);
    if (now >= sub.currentPeriodEnd) {
      if (sub.cancelAtPeriodEnd) {
        await this.core.cancelNow(tx, sub);
        return true;
      }
      // An upgrade that was never paid was prorated for a period that is now over: the renewal carries the new plan instead.
      await this.core.voidOpenInvoices(tx, sub, { reason: 'UPGRADE' }, 'The period this upgrade was prorated for has ended.');
      const { invoice } = await this.core.ensurePeriodInvoice(tx, sub, { reason: 'RENEWAL', periodStart: sub.currentPeriodEnd, dueAt: sub.currentPeriodEnd });
      if (invoice.status === 'PAID') await this.core.advance(tx, sub, invoice);
      else await this.core.failAttempt(tx, sub, invoice, NO_SAVED_METHOD);
      return true;
    }
    if (sub.cancelAtPeriodEnd || now < addDays(sub.currentPeriodEnd, -policy.renewalLeadDays)) return false;
    const { invoice, created } = await this.core.ensurePeriodInvoice(tx, sub, { reason: 'RENEWAL', periodStart: sub.currentPeriodEnd, dueAt: sub.currentPeriodEnd });
    if (!created && sub.renewalReminderAt) return false;
    await tx.subscription.update({ where: { id: sub.id }, data: { renewalReminderAt: now } });
    if (invoice.status === 'OPEN') this.renewalDue(sub, invoice, { kind: 'RENEWAL' });
    return true;
  }

  private async pastDue(tx: Tx, sub: FullSubscription): Promise<boolean> {
    const now = this.core.now();
    if (sub.cancelAtPeriodEnd) {
      await this.core.cancelNow(tx, sub);
      return true;
    }
    let invoice = await tx.subscriptionInvoice.findFirst({ where: { subscriptionId: sub.id, status: 'OPEN', reason: { in: PERIOD_REASONS } }, orderBy: { createdAt: 'desc' } });
    if (!invoice) {
      // The invoice was paid ahead or voided by an administrator: make sure there is one for the period that is due.
      // Normally that is the period after the current one; for a subscription that started without a trial and
      // was never paid it is the current (first) period itself.
      const firstPeriodUnpaid = now < sub.currentPeriodEnd;
      const periodStart = firstPeriodUnpaid ? sub.currentPeriodStart : sub.currentPeriodEnd;
      const reason = firstPeriodUnpaid || (sub.trialEndsAt && sub.trialEndsAt.getTime() === sub.currentPeriodEnd.getTime()) ? 'FIRST_PERIOD' : 'RENEWAL';
      const ensured = await this.core.ensurePeriodInvoice(tx, sub, { reason, periodStart, dueAt: periodStart });
      if (ensured.invoice.status === 'PAID') {
        await this.core.advance(tx, sub, ensured.invoice);
        return true;
      }
      invoice = ensured.invoice;
      await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { nextAttemptAt: now } });
      invoice = { ...invoice, nextAttemptAt: now };
    }
    if (!invoice.nextAttemptAt || now < invoice.nextAttemptAt) return false;
    await this.core.failAttempt(tx, sub, invoice, NO_SAVED_METHOD);
    return true;
  }

  private async grace(tx: Tx, sub: FullSubscription): Promise<boolean> {
    const now = this.core.now();
    if (sub.cancelAtPeriodEnd) {
      await this.core.cancelNow(tx, sub);
      return true;
    }
    if (sub.graceEndsAt && now < sub.graceEndsAt) return false;
    // The unpaid invoice stays OPEN: paying it is how the centre comes back.
    await this.core.setStatus(tx, sub, 'EXPIRED', { graceEndsAt: null }, { reason: 'GRACE_PERIOD_OVER' });
    await this.core.record(tx, sub, 'SUSPENDED_FOR_NON_PAYMENT', { graceEndedAt: sub.graceEndsAt });
    this.core.auditLater(sub.tenantId, 'subscription.expired', 'Subscription', sub.id, 'Grace period over without payment: subscription expired, centre suspended');
    return true;
  }
}
