import { TestApp } from '../../../test/helpers';
import { listen } from '../finance/fixtures';
import { buildSandboxWebhook } from '../finance/gateways/sandbox.gateway';
import { clockOf, completeOnboarding, DAY, eventsOf, invoicesOf, lifecycleOf, openInvoiceOf, outboxOf, paySandbox, setPeriod, signedUpTenant, subOf, tenantOf } from './fixtures';
import { LIFECYCLE_JOB } from './lifecycle.service';

describe('Subscriptions: lifecycle (trial, renewal, failed payment, grace, suspension, cancellation) and payment webhooks', () => {
  let t: TestApp;

  const postWebhook = (hook: { body: string; headers: Record<string, string> }, channel: 'subscriptions' | 'payments' = 'subscriptions') => {
    let req = t.http.post(`/api/v1/public/webhooks/${channel}/sandbox`);
    for (const [k, v] of Object.entries(hook.headers)) req = req.set(k, v);
    return req.send(hook.body);
  };
  const tick = (tenantId: string) => lifecycleOf(t).tick(tenantId);
  const statusTrail = async (tenantId: string) => (await eventsOf(t, tenantId, 'STATUS_CHANGED')).map((e) => `${(e.data as any).from}>${(e.data as any).to}`);

  beforeAll(async () => {
    t = await listen(await TestApp.create());
  });
  afterEach(() => clockOf(t).reset());
  afterAll(() => t.close());

  // ---------------------------------------------------------------- trial
  describe('trial', () => {
    it('reminds three days before the end, invoices at the end, and becomes ACTIVE when the invoice is paid', async () => {
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      await completeOnboarding(t, tenant);
      expect((await tenantOf(t, tenant.id)).status).toBe('TRIAL');
      const trialEndsAt = (await subOf(t, tenant.id)).trialEndsAt!;

      // Nothing happens while the trial is young.
      clockOf(t).advanceDays(5);
      expect(await tick(tenant.id)).toBe(false);
      expect(await outboxOf(t, tenant.id, 'subscription.renewal_due')).toHaveLength(0);

      // Three days before the end: one reminder, however often the job runs.
      clockOf(t).advanceDays(6.5); // day 11.5
      expect(await tick(tenant.id)).toBe(true);
      expect(await tick(tenant.id)).toBe(false);
      const reminders = await outboxOf(t, tenant.id, 'subscription.renewal_due');
      expect(reminders).toHaveLength(1);
      expect(reminders[0].payload).toMatchObject({ subscriptionId: (await subOf(t, tenant.id)).id, amount: '149.00', currency: 'AED', kind: 'TRIAL_ENDING', planKey: 'starter' });
      expect(new Date((reminders[0].payload as any).dueAt).getTime()).toBe(trialEndsAt.getTime());
      expect(await invoicesOf(t, tenant.id)).toHaveLength(0);

      // Trial over: the first invoice, and PAST_DUE because it is not paid.
      clockOf(t).advanceDays(2.6); // day 14.1
      expect(await tick(tenant.id)).toBe(true);
      expect(await tick(tenant.id)).toBe(false);
      const invoice = await openInvoiceOf(t, tenant.id);
      expect(invoice).toMatchObject({ reason: 'FIRST_PERIOD', status: 'OPEN', currency: 'AED', attemptCount: 1 });
      expect(invoice.number).toMatch(/^TE-SUB-\d{6}$/);
      expect(invoice.total.toFixed(2)).toBe('149.00');
      expect(invoice.periodStart.getTime()).toBe(trialEndsAt.getTime());
      expect(invoice.dueAt.getTime()).toBe(trialEndsAt.getTime());
      expect((await subOf(t, tenant.id)).status).toBe('PAST_DUE');
      expect((await tenantOf(t, tenant.id)).status).toBe('PAST_DUE');
      const failed = await outboxOf(t, tenant.id, 'subscription.payment_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].payload).toMatchObject({ invoiceId: invoice.id, amount: '149.00', attempt: 1 });
      // The centre keeps working while PAST_DUE, and the owner sees the invoice.
      await t.as(tenant.owner).get('/branches').expect(200);
      const view = await t.as(tenant.owner).get('/subscription').expect(200);
      expect(view.body.openInvoices.map((i: any) => i.id)).toEqual([invoice.id]);
      expect(view.body.openInvoices[0]).toMatchObject({ total: '149.00', overdue: true });

      // Paying through the gateway activates the subscription for the period that started when the trial ended.
      const { start, done } = await paySandbox(t, tenant.owner, invoice.id);
      expect(start).toMatchObject({ gateway: 'sandbox', testMode: true, amount: '149.00', currency: 'AED', number: invoice.number });
      expect(done.webhook.response).toMatchObject({ received: true, processed: true, outcome: 'PAID' });
      const sub = await subOf(t, tenant.id);
      expect(sub.status).toBe('ACTIVE');
      expect(sub.currentPeriodStart.getTime()).toBe(trialEndsAt.getTime());
      expect(sub.currentPeriodEnd.getTime()).toBe(invoice.periodEnd.getTime());
      expect((await tenantOf(t, tenant.id)).status).toBe('ACTIVE');
      const paid = await t.as(tenant.owner).get(`/subscription/invoices/${invoice.id}`).expect(200);
      expect(paid.body).toMatchObject({ status: 'PAID', paymentMethod: 'ONLINE:sandbox', total: '149.00' });
      expect(paid.body.paidAt).toBeTruthy();
      expect(await statusTrail(tenant.id)).toEqual(['TRIALING>PAST_DUE', 'PAST_DUE>ACTIVE']);
      expect((await eventsOf(t, tenant.id)).map((e) => e.type)).toEqual(expect.arrayContaining(['TRIAL_STARTED', 'TRIAL_ENDING', 'TRIAL_ENDED', 'INVOICE_CREATED', 'PAYMENT_ATTEMPT_FAILED', 'CHECKOUT_STARTED', 'INVOICE_PAID', 'ACTIVATED']));
      // SaaS billing never writes to the tenant's own payment tables.
      expect(await t.sys.payment.count({ where: { tenantId: tenant.id } })).toBe(0);
      expect(await t.sys.invoice.count({ where: { tenantId: tenant.id } })).toBe(0);
    });

    it('never gives a second trial', async () => {
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      await completeOnboarding(t, tenant);
      await t.as(tenant.owner).post('/subscription/cancel', { reason: 'Just trying it out' }).expect(200);
      clockOf(t).advanceDays(14.1);
      await tick(tenant.id);
      expect((await subOf(t, tenant.id)).status).toBe('CANCELLED');
      expect((await tenantOf(t, tenant.id)).status).toBe('CANCELLED');
      expect(await invoicesOf(t, tenant.id)).toHaveLength(0); // a cancelled trial is never invoiced
      const again = await t.as(tenant.owner).post('/subscription/restart', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      expect(again.body.outcome).toBe('PAYMENT_REQUIRED');
      expect(again.body.subscription.status).toBe('CANCELLED'); // until the invoice is paid
      expect(again.body.openInvoices[0]).toMatchObject({ reason: 'RESTART', total: '149.00' });
    });
  });

  // ---------------------------------------------------------------- renewal
  describe('renewal', () => {
    it('creates the renewal invoice 7 days ahead, and starts the next period when it is paid', async () => {
      const tenant = await t.createTenant({ plan: 'professional' });
      const start = new Date('2026-05-01T00:00:00.000Z');
      const end = new Date('2026-06-01T00:00:00.000Z');
      await setPeriod(t, tenant.id, start, end);

      clockOf(t).set(new Date('2026-05-24T00:00:00.000Z')); // 8 days before
      expect(await tick(tenant.id)).toBe(false);
      expect(await invoicesOf(t, tenant.id)).toHaveLength(0);

      clockOf(t).set(new Date('2026-05-25T12:00:00.000Z')); // inside the 7-day window
      expect(await tick(tenant.id)).toBe(true);
      expect(await tick(tenant.id)).toBe(false); // idempotent
      const invoice = await openInvoiceOf(t, tenant.id);
      expect(invoice).toMatchObject({ reason: 'RENEWAL', status: 'OPEN', attemptCount: 0 });
      expect(invoice.total.toFixed(2)).toBe('349.00');
      expect([invoice.periodStart.toISOString(), invoice.periodEnd.toISOString(), invoice.dueAt.toISOString()]).toEqual(['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
      const due = await outboxOf(t, tenant.id, 'subscription.renewal_due');
      expect(due).toHaveLength(1);
      expect(due[0].payload).toMatchObject({ subscriptionId: (await subOf(t, tenant.id)).id, amount: '349.00', currency: 'AED', invoiceId: invoice.id, kind: 'RENEWAL', dueAt: '2026-06-01T00:00:00.000Z' });
      expect((await subOf(t, tenant.id)).status).toBe('ACTIVE');

      // Paid ahead of time: the current period simply runs to its end, then the next one starts.
      await paySandbox(t, tenant.owner, invoice.id);
      let sub = await subOf(t, tenant.id);
      expect(sub.currentPeriodEnd.toISOString()).toBe(end.toISOString());
      clockOf(t).set(new Date('2026-05-31T23:00:00.000Z'));
      expect(await tick(tenant.id)).toBe(false);
      clockOf(t).set(new Date('2026-06-01T00:30:00.000Z'));
      expect(await tick(tenant.id)).toBe(true);
      expect(await tick(tenant.id)).toBe(false);
      sub = await subOf(t, tenant.id);
      expect(sub.status).toBe('ACTIVE');
      expect([sub.currentPeriodStart.toISOString(), sub.currentPeriodEnd.toISOString()]).toEqual(['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);
      expect((await eventsOf(t, tenant.id, 'RENEWED'))).toHaveLength(1);
      expect(await statusTrail(tenant.id)).toEqual([]); // it never left ACTIVE
      expect(await outboxOf(t, tenant.id, 'subscription.payment_failed')).toHaveLength(0);
      expect(await invoicesOf(t, tenant.id)).toHaveLength(1);
      // And the cycle repeats for the following period.
      clockOf(t).set(new Date('2026-06-25T00:00:00.000Z'));
      expect(await tick(tenant.id)).toBe(true);
      expect((await openInvoiceOf(t, tenant.id)).periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  // ---------------------------------------------------------------- dunning
  describe('failed payment -> grace -> suspension -> payment -> reactivation', () => {
    it('walks the whole path and reactivates on payment', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      const end = new Date('2026-06-01T00:00:00.000Z');
      await setPeriod(t, tenant.id, new Date('2026-05-01T00:00:00.000Z'), end);
      const at = (iso: string) => clockOf(t).set(new Date(iso));

      at('2026-05-26T00:00:00.000Z');
      await tick(tenant.id);
      const invoice = await openInvoiceOf(t, tenant.id);

      // Period over, nothing paid: PAST_DUE and the first failed attempt.
      at('2026-06-01T00:10:00.000Z');
      expect(await tick(tenant.id)).toBe(true);
      expect(await tick(tenant.id)).toBe(false);
      let sub = await subOf(t, tenant.id);
      expect(sub.status).toBe('PAST_DUE');
      expect((await tenantOf(t, tenant.id)).status).toBe('PAST_DUE');
      let inv = await openInvoiceOf(t, tenant.id);
      expect(inv.id).toBe(invoice.id);
      expect(inv).toMatchObject({ attemptCount: 1 });
      expect(inv.nextAttemptAt!.toISOString()).toBe('2026-06-02T00:10:00.000Z');
      expect(inv.lastError).toMatch(/No payment was received/);

      // Second attempt a day later, third two days after that.
      at('2026-06-02T00:09:00.000Z');
      expect(await tick(tenant.id)).toBe(false);
      at('2026-06-02T00:11:00.000Z');
      expect(await tick(tenant.id)).toBe(true);
      inv = await openInvoiceOf(t, tenant.id);
      expect(inv.attemptCount).toBe(2);
      expect(inv.nextAttemptAt!.toISOString()).toBe('2026-06-04T00:11:00.000Z');
      expect((await subOf(t, tenant.id)).status).toBe('PAST_DUE');

      // After the last attempt: GRACE for 7 days. The centre still works.
      at('2026-06-04T00:12:00.000Z');
      expect(await tick(tenant.id)).toBe(true);
      sub = await subOf(t, tenant.id);
      expect(sub.status).toBe('GRACE');
      expect(sub.graceEndsAt!.toISOString()).toBe('2026-06-11T00:12:00.000Z');
      expect((await openInvoiceOf(t, tenant.id)).attemptCount).toBe(3);
      expect((await tenantOf(t, tenant.id)).status).toBe('PAST_DUE');
      await t.as(tenant.owner).get('/branches').expect(200);
      const failures = await outboxOf(t, tenant.id, 'subscription.payment_failed');
      expect(failures.map((f) => (f.payload as any).attempt)).toEqual([1, 2, 3]);
      expect(failures[2].payload).toMatchObject({ graceEndsAt: '2026-06-11T00:12:00.000Z', nextAttemptAt: null });

      at('2026-06-10T00:00:00.000Z');
      expect(await tick(tenant.id)).toBe(false);

      // Grace over: subscription EXPIRED, centre SUSPENDED for non-payment.
      at('2026-06-11T00:13:00.000Z');
      expect(await tick(tenant.id)).toBe(true);
      expect(await tick(tenant.id)).toBe(false);
      expect((await subOf(t, tenant.id)).status).toBe('EXPIRED');
      let row = await tenantOf(t, tenant.id);
      expect(row).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'SUBSCRIPTION_UNPAID' });
      expect(row.suspendedAt!.toISOString()).toBe('2026-06-11T00:13:00.000Z');
      expect(await statusTrail(tenant.id)).toEqual(['ACTIVE>PAST_DUE', 'PAST_DUE>GRACE', 'GRACE>EXPIRED']);

      // A suspended centre cannot work...
      const blocked = await t.as(tenant.owner).get('/branches');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('TENANT_UNAVAILABLE');
      expect((await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' })).status).toBe(403);
      // ...but the owner can still see the subscription and pay.
      const view = await t.as(tenant.owner).get('/subscription').expect(200);
      expect(view.body).toMatchObject({ tenantStatus: 'SUSPENDED', suspendedForNonPayment: true, subscription: { status: 'EXPIRED' } });
      expect(view.body.openInvoices.map((i: any) => i.id)).toEqual([invoice.id]);
      await t.as(tenant.owner).get('/subscription/invoices').expect(200);

      // Payment three weeks later reactivates: the paid period starts when the money arrives.
      at('2026-07-02T09:00:00.000Z');
      await paySandbox(t, tenant.owner, invoice.id);
      sub = await subOf(t, tenant.id);
      expect(sub).toMatchObject({ status: 'ACTIVE', graceEndsAt: null });
      expect([sub.currentPeriodStart.toISOString(), sub.currentPeriodEnd.toISOString()]).toEqual(['2026-07-02T09:00:00.000Z', '2026-08-02T09:00:00.000Z']);
      row = await tenantOf(t, tenant.id);
      expect(row).toMatchObject({ status: 'ACTIVE', suspensionReason: null, suspendedAt: null });
      await t.as(tenant.owner).get('/branches').expect(200);
      expect(await statusTrail(tenant.id)).toEqual(['ACTIVE>PAST_DUE', 'PAST_DUE>GRACE', 'GRACE>EXPIRED', 'EXPIRED>ACTIVE']);
      expect((await eventsOf(t, tenant.id, 'ACTIVATED'))[0].data).toMatchObject({ previousStatus: 'EXPIRED' });
      expect(await tick(tenant.id)).toBe(false);
    });

    it('payment during PAST_DUE or GRACE reactivates for the period that was invoiced', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z'));
      clockOf(t).set(new Date('2026-06-01T00:10:00.000Z'));
      await tick(tenant.id);
      clockOf(t).set(new Date('2026-06-02T00:11:00.000Z'));
      await tick(tenant.id);
      clockOf(t).set(new Date('2026-06-04T00:12:00.000Z'));
      await tick(tenant.id);
      expect((await subOf(t, tenant.id)).status).toBe('GRACE');
      const invoice = await openInvoiceOf(t, tenant.id);
      clockOf(t).set(new Date('2026-06-06T00:00:00.000Z'));
      await paySandbox(t, tenant.owner, invoice.id);
      const sub = await subOf(t, tenant.id);
      expect(sub).toMatchObject({ status: 'ACTIVE', graceEndsAt: null });
      expect([sub.currentPeriodStart.toISOString(), sub.currentPeriodEnd.toISOString()]).toEqual(['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);
      expect((await tenantOf(t, tenant.id)).status).toBe('ACTIVE');
      expect(await statusTrail(tenant.id)).toEqual(['ACTIVE>PAST_DUE', 'PAST_DUE>GRACE', 'GRACE>ACTIVE']);
    });

    it('never overrides a suspension made by a platform administrator, nor onboarding / approval / archive states', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z'));
      clockOf(t).set(new Date('2026-06-01T00:10:00.000Z'));
      await tick(tenant.id);
      const invoice = await openInvoiceOf(t, tenant.id);
      // Suspended by TypEase for another reason while the invoice is open.
      await t.sys.tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED', suspensionReason: 'Fraud review', suspendedAt: new Date() } });
      await paySandbox(t, tenant.owner, invoice.id);
      expect((await subOf(t, tenant.id)).status).toBe('ACTIVE'); // the money is recorded...
      expect(await tenantOf(t, tenant.id)).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'Fraud review' }); // ...but the suspension stands

      for (const status of ['ONBOARDING', 'PENDING_APPROVAL', 'ARCHIVED'] as const) {
        const other = await t.createTenant({ plan: 'starter' });
        await setPeriod(t, other.id, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z'));
        await t.sys.tenant.update({ where: { id: other.id }, data: { status } });
        await tick(other.id);
        expect((await subOf(t, other.id)).status).toBe('PAST_DUE');
        expect((await tenantOf(t, other.id)).status).toBe(status);
      }
    });

    it('a centre that finishes onboarding after its trial lapsed does not stay active for free', async () => {
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      // The owner abandons onboarding; the trial runs out and nobody pays.
      for (const days of [14.1, 1.1, 2.1, 7.1]) {
        clockOf(t).advanceDays(days);
        await tick(tenant.id);
      }
      expect((await subOf(t, tenant.id)).status).toBe('EXPIRED');
      expect((await tenantOf(t, tenant.id)).status).toBe('ONBOARDING'); // onboarding is never overridden
      // Weeks later the owner comes back and completes onboarding: the tenancy module makes the centre ACTIVE...
      expect((await completeOnboarding(t, tenant)).status).toBe('ACTIVE');
      // ...and the next run puts it where its subscription says it belongs.
      expect(await tick(tenant.id)).toBe(true);
      expect(await tenantOf(t, tenant.id)).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'SUBSCRIPTION_UNPAID' });
      expect(await tick(tenant.id)).toBe(false);
      // Paying the open invoice brings it back.
      await paySandbox(t, tenant.owner, (await openInvoiceOf(t, tenant.id)).id);
      expect((await tenantOf(t, tenant.id)).status).toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------- cancellation
  describe('cancellation', () => {
    it('cancels at the period end, can be resumed before that, and a restart needs a payment', async () => {
      const tenant = await t.createTenant({ plan: 'professional' });
      const end = new Date('2026-06-01T00:00:00.000Z');
      await setPeriod(t, tenant.id, new Date('2026-05-01T00:00:00.000Z'), end);
      clockOf(t).set(new Date('2026-05-26T00:00:00.000Z'));
      await tick(tenant.id); // the renewal invoice already exists
      const renewal = await openInvoiceOf(t, tenant.id);

      await t.as(tenant.owner).post('/subscription/cancel', {}).expect(400);
      const res = await t.as(tenant.owner).post('/subscription/cancel', { reason: 'Closing the shop' }).expect(200);
      expect(res.body.subscription).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: true, cancellationReason: 'Closing the shop' });
      expect(res.body.openInvoices).toEqual([]); // the renewal no longer applies
      expect((await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: renewal.id } })).status).toBe('VOID');
      expect((await t.as(tenant.owner).post('/subscription/cancel', { reason: 'again' })).body.code).toBe('ALREADY_CANCELLING');
      expect(await tick(tenant.id)).toBe(false); // no new renewal invoice while cancelling

      const resumed = await t.as(tenant.owner).post('/subscription/resume').expect(200);
      expect(resumed.body.subscription).toMatchObject({ cancelAtPeriodEnd: false, cancellationReason: null });
      expect((await t.as(tenant.owner).post('/subscription/resume')).body.code).toBe('NOT_CANCELLING');
      expect(await tick(tenant.id)).toBe(true); // renewal invoice is back
      expect((await openInvoiceOf(t, tenant.id)).id).not.toBe(renewal.id);

      await t.as(tenant.owner).post('/subscription/cancel', { reason: 'Closing the shop after all' }).expect(200);
      clockOf(t).set(new Date('2026-05-31T23:59:00.000Z'));
      expect(await tick(tenant.id)).toBe(false); // still active until the paid period ends
      await t.as(tenant.owner).get('/branches').expect(200);
      clockOf(t).set(new Date('2026-06-01T00:01:00.000Z'));
      expect(await tick(tenant.id)).toBe(true);
      const sub = await subOf(t, tenant.id);
      expect(sub.status).toBe('CANCELLED');
      expect(sub.cancelledAt!.toISOString()).toBe('2026-06-01T00:01:00.000Z');
      expect((await tenantOf(t, tenant.id)).status).toBe('CANCELLED');
      expect(await t.sys.subscriptionInvoice.count({ where: { tenantId: tenant.id, status: 'OPEN' } })).toBe(0);
      expect(await statusTrail(tenant.id)).toEqual(['ACTIVE>CANCELLED']);
      expect(await tick(tenant.id)).toBe(false);
      await t.as(tenant.owner).get('/branches').expect(403);
      expect((await t.as(tenant.owner).post('/subscription/resume')).status).toBe(403); // managing needs a usable centre; coming back is "restart"

      // Coming back: a new subscription, no trial, active once the invoice is paid.
      clockOf(t).set(new Date('2026-08-10T08:00:00.000Z'));
      const back = await t.as(tenant.owner).post('/subscription/restart', { planKey: 'starter', billingCycle: 'ANNUAL' }).expect(201);
      expect(back.body.outcome).toBe('PAYMENT_REQUIRED');
      expect(back.body.openInvoices[0]).toMatchObject({ reason: 'RESTART', total: '1490.00' });
      expect((await tenantOf(t, tenant.id)).status).toBe('CANCELLED');
      await paySandbox(t, tenant.owner, back.body.invoiceId);
      const again = await subOf(t, tenant.id);
      expect(again).toMatchObject({ status: 'ACTIVE', billingCycle: 'ANNUAL', cancelAtPeriodEnd: false, cancelledAt: null });
      expect(again.plan.key).toBe('starter');
      expect([again.currentPeriodStart.toISOString(), again.currentPeriodEnd.toISOString()]).toEqual(['2026-08-10T08:00:00.000Z', '2027-08-10T08:00:00.000Z']);
      expect((await tenantOf(t, tenant.id)).status).toBe('ACTIVE');
      await t.as(tenant.owner).get('/branches').expect(200);
    });

    it('cancelling while an invoice is overdue ends the subscription straight away', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z'));
      clockOf(t).set(new Date('2026-06-01T00:10:00.000Z'));
      await tick(tenant.id);
      expect((await subOf(t, tenant.id)).status).toBe('PAST_DUE');
      const res = await t.as(tenant.owner).post('/subscription/cancel', { reason: 'Will not renew' }).expect(200);
      expect(res.body.subscription.status).toBe('CANCELLED');
      expect((await tenantOf(t, tenant.id)).status).toBe('CANCELLED');
      expect(await t.sys.subscriptionInvoice.count({ where: { tenantId: tenant.id, status: 'OPEN' } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------- webhooks
  describe('subscription payment webhooks', () => {
    async function dueInvoice() {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, new Date(Date.now() - 31 * DAY), new Date(Date.now() - DAY));
      await tick(tenant.id);
      const invoice = await openInvoiceOf(t, tenant.id);
      const start = await t.as(tenant.owner).post(`/subscription/invoices/${invoice.id}/pay`).expect(201);
      return { tenant, invoice, sessionRef: start.body.checkoutUrl.split('/').pop() as string };
    }

    it('a duplicate delivery pays the invoice once and is acknowledged', async () => {
      const { tenant, invoice, sessionRef } = await dueInvoice();
      const hook = buildSandboxWebhook(sessionRef, 'succeeded');
      const first = await postWebhook(hook).expect(200);
      expect(first.body).toMatchObject({ received: true, processed: true, outcome: 'PAID' });
      const second = await postWebhook(hook).expect(200);
      expect(second.body).toMatchObject({ received: true, processed: false, duplicate: true });
      const third = await postWebhook(hook).expect(200);
      expect(third.body.duplicate).toBe(true);
      // A different event for the same (already paid) session changes nothing either.
      const other = await postWebhook(buildSandboxWebhook(sessionRef, 'succeeded')).expect(200);
      expect(other.body).toMatchObject({ processed: false, outcome: 'ALREADY_PAID' });

      expect(await eventsOf(t, tenant.id, 'INVOICE_PAID')).toHaveLength(1);
      expect(await eventsOf(t, tenant.id, 'ACTIVATED')).toHaveLength(1);
      expect(await t.sys.paymentWebhookEvent.count({ where: { gateway: 'subscriptions:sandbox', eventId: hook.eventId } })).toBe(1);
      const paid = await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(paid).toMatchObject({ status: 'PAID', paymentMethod: 'ONLINE:sandbox' });
      expect((await subOf(t, tenant.id)).status).toBe('ACTIVE');
      // The delivery is recorded under the subscription namespace only.
      expect(await t.sys.paymentWebhookEvent.count({ where: { gateway: 'sandbox', eventId: hook.eventId } })).toBe(0);
    });

    it('parallel deliveries of one event pay the invoice once', async () => {
      const { tenant, sessionRef } = await dueInvoice();
      const hook = buildSandboxWebhook(sessionRef, 'succeeded');
      const results = await Promise.all([postWebhook(hook), postWebhook(hook), postWebhook(hook)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.processed === true)).toHaveLength(1);
      expect(await eventsOf(t, tenant.id, 'INVOICE_PAID')).toHaveLength(1);
      expect(await eventsOf(t, tenant.id, 'ACTIVATED')).toHaveLength(1);
    });

    it('rejects invalid signatures and stale deliveries', async () => {
      const { tenant, invoice, sessionRef } = await dueInvoice();
      const before = await t.sys.securityEvent.count({ where: { type: 'WEBHOOK_SIGNATURE_INVALID' } });
      const forged = await postWebhook(buildSandboxWebhook(sessionRef, 'succeeded', { secret: 'guessed-secret' }));
      expect(forged.status).toBe(400);
      expect(forged.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      const stale = await postWebhook(buildSandboxWebhook(sessionRef, 'succeeded', { timestampSeconds: Math.floor(Date.now() / 1000) - 3600 }));
      expect(stale.status).toBe(400);
      const genuine = buildSandboxWebhook(sessionRef, 'succeeded');
      await postWebhook({ ...genuine, body: genuine.body.replace('"amount":"149.00"', '"amount":"1.49"') }).expect(400);
      expect(await t.sys.securityEvent.count({ where: { type: 'WEBHOOK_SIGNATURE_INVALID' } })).toBe(before + 3);
      expect((await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('OPEN');
      expect((await subOf(t, tenant.id)).status).toBe('PAST_DUE');
      await t.http.post('/api/v1/public/webhooks/subscriptions/paypal').send({}).expect(404);
    });

    it('a failed checkout leaves the invoice open and tells the centre', async () => {
      const { tenant, invoice, sessionRef } = await dueInvoice();
      const res = await postWebhook(buildSandboxWebhook(sessionRef, 'failed', { reason: 'Card declined (test)' })).expect(200);
      expect(res.body).toMatchObject({ processed: true, outcome: 'FAILED' });
      expect(await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: 'OPEN', lastError: 'Card declined (test)' });
      const failures = await outboxOf(t, tenant.id, 'subscription.payment_failed');
      expect(failures.some((f) => (f.payload as any).reason === 'Card declined (test)' && (f.payload as any).invoiceId === invoice.id)).toBe(true);
      // The owner can simply try again.
      await paySandbox(t, tenant.owner, invoice.id);
      expect((await subOf(t, tenant.id)).status).toBe('ACTIVE');
    });

    it('is completely separate from customer-payment webhooks', async () => {
      const { tenant, invoice, sessionRef } = await dueInvoice();
      const hook = buildSandboxWebhook(sessionRef, 'succeeded');
      // The same (genuine) event sent to the CUSTOMER payment route: acknowledged, but nothing is paid.
      const wrongRoute = await postWebhook(hook, 'payments').expect(200);
      expect(wrongRoute.body).toMatchObject({ received: true, processed: false, reason: 'UNKNOWN_REFERENCE' });
      expect((await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('OPEN');
      expect(await t.sys.payment.count({ where: { tenantId: tenant.id } })).toBe(0);
      // On its own route it works - the two routes do not share their duplicate protection.
      expect((await postWebhook(hook).expect(200)).body).toMatchObject({ processed: true, outcome: 'PAID' });
      expect(await t.sys.payment.count({ where: { tenantId: tenant.id } })).toBe(0);
      expect(await t.sys.paymentAllocation.count({ where: { tenantId: tenant.id } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------- the scheduled job
  describe('the hourly job', () => {
    it('is scheduled, handles every due subscription, is idempotent, and one failure does not stop the others', async () => {
      expect(t.jobs.schedules().find((s) => s.name === LIFECYCLE_JOB)).toMatchObject({ cron: '0 * * * *' });
      const due = await Promise.all([signedUpTenant(t), signedUpTenant(t)]);
      for (const tenant of due) {
        await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
        await completeOnboarding(t, tenant);
        // Trial ended an hour ago (dates moved, clock untouched: the job runs for ALL centres).
        await t.sys.subscription.update({ where: { tenantId: tenant.id }, data: { trialEndsAt: new Date(Date.now() - 3_600_000), currentPeriodEnd: new Date(Date.now() - 3_600_000), currentPeriodStart: new Date(Date.now() - 15 * DAY) } });
      }
      const healthy = await t.createTenant({ plan: 'business' });
      // One centre whose step blows up in the middle of the run must not stop the others.
      const broken = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, broken.id, new Date(Date.now() - 31 * DAY), new Date(Date.now() - DAY));
      const lifecycle = lifecycleOf(t) as any;
      const realTick = lifecycle.tick.bind(lifecycle);
      lifecycle.tick = async (tenantId: string) => {
        if (tenantId === broken.id) throw new Error('simulated failure for one centre');
        return realTick(tenantId);
      };
      try {
        // Run through the job queue exactly as the worker would.
        await t.jobs.runScheduled(LIFECYCLE_JOB);
      } finally {
        delete lifecycle.tick; // back to the real method
      }
      for (const tenant of due) {
        expect((await subOf(t, tenant.id)).status).toBe('PAST_DUE');
        expect(await invoicesOf(t, tenant.id)).toHaveLength(1);
      }
      expect((await subOf(t, healthy.id)).status).toBe('ACTIVE');
      expect(await invoicesOf(t, healthy.id)).toHaveLength(0);
      expect((await subOf(t, broken.id)).status).toBe('ACTIVE'); // skipped this time, picked up by the next run

      // A second run creates nothing new.
      const summary = await lifecycleOf(t).run();
      expect(summary.failed).toBe(0);
      for (const tenant of due) expect(await invoicesOf(t, tenant.id)).toHaveLength(1);
      expect((await subOf(t, broken.id)).status).toBe('PAST_DUE');
      // Events are delivered from the system outbox.
      await t.settle();
      const delivered = await t.sys.outboxEvent.findMany({ where: { tenantId: due[0].id, type: 'subscription.payment_failed' } });
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.every((e) => e.status === 'PROCESSED')).toBe(true);
    });
  });
});
