import { buildSandboxWebhook } from '../../services/api/src/modules/finance/gateways/sandbox.gateway';
import {
  Actor,
  aed,
  api,
  Centre,
  enableSandboxGateway,
  expectRefused,
  fils,
  finishCheckout,
  idempotencyKey,
  inviteStaff,
  issueInvoice,
  percent,
  registerPortalCustomer,
  runScheduledJob,
  signUpCentre,
  startCheckout,
  sum,
  TestApp,
  uniq,
} from '../support';

/**
 * Scenario 26: a duplicate payment webhook does not duplicate the payment -
 * and the neighbouring guarantees a cashier and a payment gateway rely on.
 *
 * The test plays the payment gateway: it builds the webhook the test gateway
 * ("sandbox") would send for a checkout session - raw JSON plus signature
 * header - and delivers it to the public webhook endpoint as often and as
 * concurrently as a real gateway might.
 *
 * Direct database reads are used here for one purpose only: to prove that rows
 * were NOT duplicated (payments, allocations, recorded webhook events, emitted
 * events), which no API response can show conclusively. One test also moves the
 * start time of a checkout into the past (there is no API to make an attempt old).
 */
describe('Payments are booked exactly once (scenario 26)', () => {
  let t: TestApp;
  let centre: Centre;
  let accountant: Actor;
  let receptionist: Actor;
  let customer: Actor;
  const id = uniq();

  const SERVICE_FEE = fils('100.00');
  const GOVERNMENT_FEE = fils('200.00');
  const TOTAL = sum([SERVICE_FEE, percent(SERVICE_FEE, 5), GOVERNMENT_FEE]);

  const newInvoice = () =>
    issueInvoice(t, accountant, {
      customerId: customer.customerId!,
      items: [
        { component: 'SERVICE_FEE', unitAmount: aed(SERVICE_FEE), taxRatePercent: 5 },
        { component: 'GOVERNMENT_FEE', unitAmount: aed(GOVERNMENT_FEE) },
      ],
    });
  const invoice = (invoiceId: string) => api(t, accountant).get(`/invoices/${invoiceId}`);
  const paymentsOf = async (invoiceId: string) => (await api(t, accountant).get(`/payments?invoiceId=${invoiceId}&pageSize=100`)).data as any[];
  const deliver = (hook: { body: string; headers: Record<string, string> }, channel: 'payments' | 'subscriptions' = 'payments') => {
    let req = t.http.post(`/api/v1/public/webhooks/${channel}/sandbox`);
    for (const [k, v] of Object.entries(hook.headers)) req = req.set(k, v);
    return req.send(hook.body);
  };
  /** Rows that must exist exactly once per completed payment (read with the system connection; see the file comment). */
  async function rowsFor(paymentId: string, eventId?: string) {
    const [payments, allocations, completedEvents, webhookEvents] = await Promise.all([
      t.sys.payment.count({ where: { tenantId: centre.id, id: paymentId } }),
      t.sys.paymentAllocation.count({ where: { tenantId: centre.id, paymentId } }),
      t.sys.outboxEvent.findMany({ where: { tenantId: centre.id, type: 'payment.completed' } }),
      eventId ? t.sys.paymentWebhookEvent.count({ where: { eventId } }) : Promise.resolve(0),
    ]);
    return { payments, allocations, completedEvents: completedEvents.filter((e) => (e.payload as any)?.paymentId === paymentId).length, webhookEvents };
  }

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Cashier Centre ${id}` });
    await api(t, centre.owner).patch('/tenant', { taxRatePercent: 5 });
    await enableSandboxGateway(t, centre.owner);
    accountant = await inviteStaff(t, centre, 'accountant');
    receptionist = await inviteStaff(t, centre, 'receptionist');
    customer = await registerPortalCustomer(t, centre, { fullName: 'Online Payer', email: `payer-${id}@example.test` });
    await t.settle();
  });
  afterAll(() => t.close());

  it('S26 duplicate payment webhook does not duplicate payment', async () => {
    const inv = await newInvoice();
    expect(inv.total).toBe(aed(TOTAL));
    const paymentsBefore = await t.sys.payment.count({ where: { tenantId: centre.id } });

    // The customer opens the hosted checkout. Nothing is paid yet: a PENDING attempt, the invoice untouched.
    const checkout = await startCheckout(t, customer, inv.id);
    expect(checkout).toMatchObject({ status: 'PENDING', amount: aed(TOTAL), gateway: 'sandbox', testMode: true });
    expect(await invoice(inv.id)).toMatchObject({ status: 'ISSUED', amountPaid: '0.00', balanceDue: aed(TOTAL) });

    // The gateway reports success ...
    const hook = buildSandboxWebhook(checkout.sessionRef, 'succeeded');
    const first = await deliver(hook);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, processed: true });
    expect(first.body.duplicate).toBeFalsy();
    // ... and, as gateways do, reports the very same event again. And again.
    for (let i = 0; i < 3; i++) {
      const again = await deliver(hook);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ received: true, duplicate: true });
    }
    await t.settle();

    // One payment, completed once, for the invoice total - seen through the API ...
    const payments = await paymentsOf(inv.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ id: checkout.paymentId, status: 'COMPLETED', amount: aed(TOTAL), refundedAmount: '0.00' });
    expect(payments[0].receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    const detail = await api(t, accountant).get(`/payments/${checkout.paymentId}`);
    expect(detail.paymentAllocations.map((a: any) => [a.invoiceId, a.amount])).toEqual([[inv.id, aed(TOTAL)]]);
    // ... and in the tables: nothing exists twice.
    expect(await t.sys.payment.count({ where: { tenantId: centre.id } })).toBe(paymentsBefore + 1);
    expect(await rowsFor(checkout.paymentId, hook.eventId)).toEqual({ payments: 1, allocations: 1, completedEvents: 1, webhookEvents: 1 });

    // The consequences happened once as well: the government fee is owed to the authority once, and the customer got one receipt message.
    const liabilities = await api(t, accountant).get('/finance/liabilities');
    expect(liabilities.components.find((c: any) => c.component === 'GOVERNMENT_FEE')).toMatchObject({ accrued: aed(GOVERNMENT_FEE), outstanding: aed(GOVERNMENT_FEE) });
    const inbox = await api(t, customer).get('/me/notifications?pageSize=100');
    expect(inbox.data.filter((n: any) => n.eventKey === 'payment.received')).toHaveLength(1);

    // A different event for the same session (the customer clicks "pay" on the checkout page a second time) pays nothing either.
    const secondClick = await finishCheckout(t, checkout);
    expect(secondClick.webhook.status).toBe(200);
    const otherEvent = await deliver(buildSandboxWebhook(checkout.sessionRef, 'succeeded'));
    expect(otherEvent.status).toBe(200);
    // A late "failed" event must not undo a completed payment.
    const lateFailure = await deliver(buildSandboxWebhook(checkout.sessionRef, 'failed'));
    expect(lateFailure.status).toBe(200);
    await t.settle();
    expect(await paymentsOf(inv.id)).toHaveLength(1);
    expect((await paymentsOf(inv.id))[0].status).toBe('COMPLETED');
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    expect(await rowsFor(checkout.paymentId)).toMatchObject({ payments: 1, allocations: 1, completedEvents: 1 });
    expect(await t.sys.payment.count({ where: { tenantId: centre.id } })).toBe(paymentsBefore + 1);
    expect((await api(t, customer).get('/me/notifications?pageSize=100')).data.filter((n: any) => n.eventKey === 'payment.received')).toHaveLength(1);
  });

  it('S26 concurrent deliveries of one webhook complete the payment once', async () => {
    const inv = await newInvoice();
    const checkout = await startCheckout(t, customer, inv.id);
    const hook = buildSandboxWebhook(checkout.sessionRef, 'succeeded');

    const answers = await Promise.all(Array.from({ length: 6 }, () => deliver(hook)));
    expect(answers.map((a) => a.status)).toEqual(Array(6).fill(200));
    expect(answers.filter((a) => a.body.processed === true && !a.body.duplicate)).toHaveLength(1);
    await t.settle();

    expect(await paymentsOf(inv.id)).toHaveLength(1);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    expect(await rowsFor(checkout.paymentId, hook.eventId)).toEqual({ payments: 1, allocations: 1, completedEvents: 1, webhookEvents: 1 });
  });

  it('S26 a forged, altered or misdirected webhook pays nothing', async () => {
    const inv = await newInvoice();
    const checkout = await startCheckout(t, customer, inv.id);
    const genuine = buildSandboxWebhook(checkout.sessionRef, 'succeeded');
    const untouched = async () => {
      await t.settle();
      expect(await invoice(inv.id)).toMatchObject({ status: 'ISSUED', amountPaid: '0.00', balanceDue: aed(TOTAL) });
      expect((await api(t, accountant).get(`/payments/${checkout.paymentId}`)).status).toBe('PENDING');
    };

    // Signed with the wrong secret.
    const forged = await deliver(buildSandboxWebhook(checkout.sessionRef, 'succeeded', { secret: 'not-the-gateway-secret-000000000000' }));
    expectRefused(forged, 400, 'WEBHOOK_SIGNATURE_INVALID');
    // The body was changed after signing (a smaller amount).
    const altered = await deliver({ body: genuine.body.replace(aed(TOTAL), '1.00'), headers: genuine.headers });
    expectRefused(altered, 400, 'WEBHOOK_SIGNATURE_INVALID');
    // No signature at all.
    expectRefused(await deliver({ body: genuine.body, headers: { 'content-type': 'application/json' } }), 400, 'WEBHOOK_SIGNATURE_INVALID');
    // A genuine event replayed a day later is outside the tolerance.
    const stale = await deliver(buildSandboxWebhook(checkout.sessionRef, 'succeeded', { timestampSeconds: Math.floor(Date.now() / 1000) - 86_400 }));
    expectRefused(stale, 400, 'WEBHOOK_SIGNATURE_INVALID');
    await untouched();
    // Delivered to the webhook of SaaS billing instead of customer payments: acknowledged or refused, but never booked.
    const misdirected = await deliver(genuine, 'subscriptions');
    expect([200, 400, 404]).toContain(misdirected.status);
    await untouched();
    expect(await t.sys.paymentWebhookEvent.count({ where: { eventId: genuine.eventId, gateway: 'sandbox' } })).toBe(0);

    // The attempts are visible to TypEase as security events.
    const admin = await t.createPlatformAdmin('SUPER_ADMIN');
    const events = await api(t, admin).get('/platform/security-events?pageSize=100');
    expect(events.data.some((e: any) => e.type === 'WEBHOOK_SIGNATURE_INVALID')).toBe(true);

    // After all that, the genuine event still works - once.
    expect((await deliver(genuine)).body).toMatchObject({ processed: true });
    expect((await deliver(genuine)).body).toMatchObject({ duplicate: true });
    await t.settle();
    expect(await paymentsOf(inv.id)).toHaveLength(1);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', balanceDue: '0.00' });
  });

  it('S26 a declined attempt and a second, successful one leave exactly one completed payment', async () => {
    const inv = await newInvoice();
    const declined = await startCheckout(t, customer, inv.id);
    const failure = await finishCheckout(t, declined, 'fail');
    expect(failure.webhook).toMatchObject({ delivered: true, status: 200 });
    await t.settle();
    expect((await api(t, accountant).get(`/payments/${declined.paymentId}`)).status).toBe('FAILED');
    expect(await invoice(inv.id)).toMatchObject({ status: 'ISSUED', amountPaid: '0.00' });
    // A success event for an attempt the gateway already reported as failed does not revive it.
    await deliver(buildSandboxWebhook(declined.sessionRef, 'succeeded'));
    await t.settle();
    expect(await invoice(inv.id)).toMatchObject({ status: 'ISSUED', amountPaid: '0.00' });

    const second = await startCheckout(t, customer, inv.id);
    expect(second.paymentId).not.toBe(declined.paymentId);
    await finishCheckout(t, second);
    await t.settle();
    const all = (await api(t, accountant).get(`/payments?customerId=${customer.customerId}&pageSize=100`)).data.filter((p: any) => [declined.paymentId, second.paymentId].includes(p.id));
    expect(all.map((p: any) => p.status).sort()).toEqual(['COMPLETED', 'FAILED']);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    // A paid invoice cannot be paid online again.
    expectRefused(await api(t, customer).req('POST', `/invoices/${inv.id}/pay`, {}), 409, 'INVOICE_NOT_PAYABLE');
  });

  it('S26 an abandoned checkout is closed after 60 minutes, and a late success webhook still books the payment - once', async () => {
    const inv = await newInvoice();
    const abandoned = await startCheckout(t, customer, inv.id);
    const fresh = await startCheckout(t, customer, inv.id);
    const failed = await startCheckout(t, customer, inv.id);
    await finishCheckout(t, failed, 'fail');
    const payment = (paymentId: string) => api(t, accountant).get(`/payments/${paymentId}`);
    const inbox = async () => (await api(t, customer).get('/me/notifications?pageSize=100')).data.length as number;
    await t.settle();
    const messagesBefore = await inbox();

    // Time travel (database): the first checkout page was opened 61 minutes ago, the second 59 minutes ago, and
    // the declined attempt long ago. There is no API to make an attempt old.
    const startedAgo = (paymentId: string, minutes: number) => t.sys.payment.update({ where: { id: paymentId }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } });
    await startedAgo(abandoned.paymentId, 61);
    await startedAgo(fresh.paymentId, 59);
    await startedAgo(failed.paymentId, 300);

    // --- the job that runs every five minutes
    expect(t.jobs.schedules().find((x) => x.name === 'finance.expire_checkouts')).toMatchObject({ everySeconds: 300 });
    await runScheduledJob(t, 'finance.expire_checkouts');
    expect(await payment(abandoned.paymentId)).toMatchObject({ status: 'CANCELLED', failureReason: 'EXPIRED', receiptNo: null });
    expect((await payment(fresh.paymentId)).status).toBe('PENDING'); // still inside the hour
    expect((await payment(failed.paymentId)).status).toBe('FAILED'); // a declined attempt stays what it is
    // Closing an attempt that never took money changes nothing else: the invoice, the customer's inbox.
    expect(await invoice(inv.id)).toMatchObject({ status: 'ISSUED', amountPaid: '0.00', balanceDue: aed(TOTAL) });
    expect(await inbox()).toBe(messagesBefore);
    // The job can run again and again.
    await runScheduledJob(t, 'finance.expire_checkouts');
    await runScheduledJob(t, 'finance.expire_checkouts');
    const closed = await api(t, centre.owner).get(`/audit-logs?action=payment.checkout_expired&resourceId=${abandoned.paymentId}&resourceType=Payment`);
    expect(closed.data).toHaveLength(1);
    expect(closed.data[0].actorType).toBe('SYSTEM');
    // The customer sees what happened to the attempt.
    expect(await api(t, customer).get(`/payments/${abandoned.paymentId}`)).toMatchObject({ status: 'CANCELLED', failureReason: 'EXPIRED' });

    // --- the gateway reports, late, that the customer DID pay on that page: the money is real, so it is booked - once
    const late = buildSandboxWebhook(abandoned.sessionRef, 'succeeded');
    const first = await deliver(late);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, processed: true });
    for (let i = 0; i < 3; i++) expect((await deliver(late)).body).toMatchObject({ received: true, duplicate: true });
    // (the same success under a new event id, as a gateway does when it retries from another region)
    expect((await deliver(buildSandboxWebhook(abandoned.sessionRef, 'succeeded'))).status).toBe(200);
    await t.settle();
    const revived = await payment(abandoned.paymentId);
    expect(revived).toMatchObject({ status: 'COMPLETED', amount: aed(TOTAL), failureReason: null });
    expect(revived.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    expect(await rowsFor(abandoned.paymentId, late.eventId)).toEqual({ payments: 1, allocations: 1, completedEvents: 1, webhookEvents: 1 });
    expect((await api(t, centre.owner).get(`/audit-logs?action=payment.checkout_revived&resourceId=${abandoned.paymentId}&resourceType=Payment`)).data).toHaveLength(1);

    // --- what must NOT come back: a declined attempt (late "success" for it), and the other open attempt once the invoice is paid
    await deliver(buildSandboxWebhook(failed.sessionRef, 'succeeded'));
    await t.settle();
    expect((await payment(failed.paymentId)).status).toBe('FAILED');
    const completed = (await paymentsOf(inv.id)).filter((p) => p.status === 'COMPLETED');
    expect(completed.map((p) => p.id)).toEqual([abandoned.paymentId]);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    // A late FAILURE for an attempt that was closed as expired is ignored (it stays cancelled, nothing is undone).
    const inv2 = await newInvoice();
    const stale = await startCheckout(t, customer, inv2.id);
    await startedAgo(stale.paymentId, 90);
    await runScheduledJob(t, 'finance.expire_checkouts');
    expect((await deliver(buildSandboxWebhook(stale.sessionRef, 'failed'))).status).toBe(200);
    await t.settle();
    expect(await payment(stale.paymentId)).toMatchObject({ status: 'CANCELLED', failureReason: 'EXPIRED' });
    // ... and the customer simply starts again.
    const again = await startCheckout(t, customer, inv2.id);
    await finishCheckout(t, again);
    await t.settle();
    expect(await invoice(inv2.id)).toMatchObject({ status: 'PAID', balanceDue: '0.00' });
    expect((await paymentsOf(inv2.id)).filter((p) => p.status === 'COMPLETED')).toHaveLength(1);
  });

  it('S26 a manual payment sent twice or simultaneously is booked once (Idempotency-Key)', async () => {
    const desk = api(t, receptionist);
    const inv = await newInvoice();
    const key = idempotencyKey();
    const body = { method: 'CASH', amount: '105.00', branchId: centre.headOfficeId, customerId: customer.customerId, allocations: [{ invoiceId: inv.id, amount: '105.00' }] };

    // Six identical requests at the same moment (a nervous double click, a retrying proxy).
    const answers = await Promise.all(Array.from({ length: 6 }, () => desk.with({ 'Idempotency-Key': key }).req('POST', '/payments', body)));
    const created = answers.filter((a) => a.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((a) => a.body.id)).size).toBe(1); // everybody who got an answer got the same payment
    for (const a of answers) expect([201, 409, 425, 429]).toContain(a.status);
    // Later replays return the stored answer.
    const replay = await desk.with({ 'Idempotency-Key': key }).req('POST', '/payments', body);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(created[0].body.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await paymentsOf(inv.id)).toHaveLength(1);
    expect(await invoice(inv.id)).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: '105.00', balanceDue: aed(TOTAL - fils('105.00')) });
    expect(await rowsFor(created[0].body.id)).toMatchObject({ payments: 1, allocations: 1, completedEvents: 1 });

    // The same key for something else is a mistake, not a replay.
    const reused = await desk.with({ 'Idempotency-Key': key }).req('POST', '/payments', { ...body, amount: '50.00', allocations: [{ invoiceId: inv.id, amount: '50.00' }] });
    expectRefused(reused, 409, 'IDEMPOTENCY_KEY_REUSED');
    // A key is not a secret shared between centres or users of other centres: another centre's identical key is independent.
    const other = await signUpCentre(t);
    expectRefused(await api(t, other.owner).with({ 'Idempotency-Key': key }).req('POST', '/payments', body), 404);

    // Two cashiers take the remaining balance at the same moment with different keys: only one can.
    const rest = aed(TOTAL - fils('105.00'));
    const restBody = { method: 'CARD_POS', amount: rest, branchId: centre.headOfficeId, customerId: customer.customerId, allocations: [{ invoiceId: inv.id, amount: rest }] };
    const race = await Promise.all([desk.with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/payments', restBody), api(t, accountant).with({ 'Idempotency-Key': idempotencyKey() }).req('POST', '/payments', restBody)]);
    expect(race.map((r) => r.status).sort()).toEqual([201, expect.any(Number)]);
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expectRefused(race.find((r) => r.status !== 201)!, [409, 422]);
    await t.settle();
    expect(await paymentsOf(inv.id)).toHaveLength(2);
    const final = await invoice(inv.id);
    expect(final).toMatchObject({ status: 'PAID', amountPaid: aed(TOTAL), balanceDue: '0.00' });
    expect(aed(sum((await paymentsOf(inv.id)).map((p) => fils(p.amount))))).toBe(final.total);

    // Refund requests have the same protection.
    const refundKey = idempotencyKey();
    const refundBody = { paymentId: created[0].body.id, invoiceId: inv.id, amount: '20.00', reason: 'Fee corrected', cancelCharge: true };
    const r1 = await api(t, accountant).with({ 'Idempotency-Key': refundKey }).req('POST', '/refunds', refundBody);
    const r2 = await api(t, accountant).with({ 'Idempotency-Key': refundKey }).req('POST', '/refunds', refundBody);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.body.id).toBe(r1.body.id);
    expect((await api(t, accountant).get(`/refunds?paymentId=${created[0].body.id}`)).data).toHaveLength(1);
  });
});
