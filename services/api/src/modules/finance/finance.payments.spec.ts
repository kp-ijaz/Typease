import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { listen } from './fixtures';
import {
  addCorporateAdmin, buildSandboxWebhook, createCorporate, createCustomer, createRequest, createService, enableSandbox, enableStripe, issueInvoice, key, outbox,
  postSandboxWebhook, recordPayment, sessionRefOf,
} from './fixtures';
import { signTimestamped } from './gateways/payment-gateway';

const sandboxPath = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

describe('Finance: payments, idempotency and gateway webhooks', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let gamma: TenantFixture; // no payment gateway configured
  let receptionist: Actor;
  let accountant: Actor;
  let operator: Actor;
  let customer: Actor;
  let otherCustomer: Actor;

  const liabilities = (invoiceId: string) => t.sys.liabilityEntry.findMany({ where: { invoiceId }, orderBy: [{ occurredAt: 'asc' }, { component: 'asc' }] });
  const invoiceRow = (id: string) => t.sys.invoice.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    gamma = await t.createTenant({ name: 'Gamma Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    accountant = await t.addStaff(alpha, 'accountant');
    operator = await t.addStaff(alpha, 'operator');
    customer = await t.addCustomer(alpha, { fullName: 'Aisha Khan' });
    otherCustomer = await t.addCustomer(alpha, { fullName: 'Omar Said' });
    await enableSandbox(t, alpha);
    await enableSandbox(t, beta);
  });
  afterAll(() => t.close());

  // ---------------------------------------------------------------- manual payments
  describe('manual payments', () => {
    it('records a payment: completed at once, numbered, allocated, liability accrued, event emitted', async () => {
      const service = await createService(t, alpha);
      const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
      const inv = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id }); // 100 + 5 tax + 200 government = 305
      const res = await recordPayment(t, receptionist, { method: 'CASH', amount: '305.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '305.00' }] }).expect(201);
      expect(res.body.paymentNo).toMatch(/^PAY-\d{6}$/);
      expect(res.body.receiptNo).toMatch(/^RCT-\d{6}$/);
      expect(res.body).toMatchObject({ status: 'COMPLETED', method: 'CASH', amount: '305.00', currency: 'AED', customerId: customer.customerId, receivedById: receptionist.userId, unallocatedAmount: '0.00' });
      expect(res.body.paymentAllocations).toHaveLength(1);
      expect(res.body.paymentAllocations[0]).toMatchObject({ invoiceId: inv.id, amount: '305.00' });
      expect(res.body.idempotencyKey).toBeUndefined();
      expect(res.body.gatewaySessionRef).toBeUndefined();

      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'PAID' });
      const after = (await t.as(accountant).get(`/invoices/${inv.id}`).expect(200)).body;
      expect(after).toMatchObject({ status: 'PAID', amountPaid: '305.00', balanceDue: '0.00' });
      expect(after.payments[0]).toMatchObject({ paymentNo: res.body.paymentNo, allocated: '305.00' });

      // Only the government fee is held for someone else; the service fee and its tax are the centre's own.
      const ledger = await liabilities(inv.id);
      expect(ledger.map((l) => [l.component, l.direction, l.amount.toFixed(2), l.requestId, l.sourceType, l.sourceId])).toEqual([['GOVERNMENT_FEE', 'ACCRUAL', '200.00', request.id, 'PAYMENT', res.body.id]]);

      const events = await outbox(t, alpha.id, 'payment.completed');
      const event = events.find((e) => (e.payload as any).paymentId === res.body.id)!;
      expect(event.payload).toMatchObject({ amount: '305.00', currency: 'AED', method: 'CASH', customerId: customer.customerId, invoiceIds: [inv.id], requestIds: [request.id] });
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'payment.recorded', resourceId: res.body.id } });
      expect(audit!.actorUserId).toBe(receptionist.userId);
    });

    it('requires an Idempotency-Key, replays the same request and refuses a reused key with a different body', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const body = { method: 'CARD_POS', amount: '100.00', reference: 'POS slip 4471', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '100.00' }] };
      const missing = await t.as(receptionist).post('/payments', body);
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await t.as(receptionist).post('/payments', body).set('Idempotency-Key', 'short')).body.code).toBe('IDEMPOTENCY_KEY_INVALID');

      const k = key();
      const first = await recordPayment(t, receptionist, body, k).expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const replay = await recordPayment(t, receptionist, body, k).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      // Key order in the JSON body does not matter.
      const reordered = await recordPayment(t, receptionist, { allocations: [{ amount: '100.00', invoiceId: inv.id }], branchId: alpha.headOfficeId, reference: 'POS slip 4471', amount: '100.00', method: 'CARD_POS' }, k).expect(201);
      expect(reordered.body.id).toBe(first.body.id);
      expect(await t.sys.payment.count({ where: { tenantId: alpha.id, paymentAllocations: { some: { invoiceId: inv.id } } } })).toBe(1);
      expect((await invoiceRow(inv.id)).amountPaid.toFixed(2)).toBe('100.00');

      const different = await recordPayment(t, receptionist, { ...body, amount: '50.00', allocations: [{ invoiceId: inv.id, amount: '50.00' }] }, k);
      expect(different.status).toBe(409);
      expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // The same key in another tenant is unrelated.
      const betaCustomer = await createCustomer(t, beta);
      const betaInvoice = await issueInvoice(t, beta.owner, betaCustomer.id);
      await recordPayment(t, beta.owner, { method: 'CASH', amount: '10.00', branchId: beta.headOfficeId, allocations: [{ invoiceId: betaInvoice.id, amount: '10.00' }] }, k).expect(201);
    });

    it('a failed attempt can be retried with the same key', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const k = key();
      const body = { method: 'CASH', amount: '999.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '999.00' }] };
      expect((await recordPayment(t, receptionist, body, k)).status).toBe(422);
      expect(await t.sys.idempotencyKey.count({ where: { tenantId: alpha.id, key: k } })).toBe(0);
      expect((await recordPayment(t, receptionist, body, k)).status).toBe(422);
    });

    it('spreads partial payments over the components proportionally (remainder on the service fee)', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!, { thirdPartyFee: '35.00' }); // service 105, government 200, third party 35 = 340
      const pay = (amount: string, method = 'CASH') => recordPayment(t, receptionist, { method, amount, branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount }] }).expect(201);
      await pay('100.00');
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'PARTIALLY_PAID' });
      expect((await invoiceRow(inv.id)).balanceDue.toFixed(2)).toBe('240.00');
      let ledger = await liabilities(inv.id);
      // 100 * 200/340 = 58.82 ; 100 * 35/340 = 10.29 ; the remaining 30.89 is service fee
      expect(Object.fromEntries(ledger.map((l) => [l.component, l.amount.toFixed(2)]))).toEqual({ GOVERNMENT_FEE: '58.82', THIRD_PARTY_FEE: '10.29' });
      await pay('100.00', 'BANK_TRANSFER');
      await pay('140.00', 'CHEQUE');
      ledger = await liabilities(inv.id);
      const total = (c: string) => ledger.filter((l) => l.component === c).reduce((a, l) => a + Number(l.amount), 0).toFixed(2);
      // After full payment exactly the component totals have been accrued - no rounding drift.
      expect(total('GOVERNMENT_FEE')).toBe('200.00');
      expect(total('THIRD_PARTY_FEE')).toBe('35.00');
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'PAID' });
      const detail = (await t.as(accountant).get(`/invoices/${inv.id}`)).body;
      expect(detail.payments).toHaveLength(3);
      expect(detail.balanceDue).toBe('0.00');
    });

    it('does not accrue a liability for a component the centre treats as revenue', async () => {
      await t.as(alpha.owner).put('/finance/fee-components', { components: [{ type: 'THIRD_PARTY_FEE', treatment: 'REVENUE' }] }).expect(200);
      const inv = await issueInvoice(t, accountant, customer.customerId!, { thirdPartyFee: '35.00' });
      await recordPayment(t, receptionist, { method: 'CASH', amount: '340.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '340.00' }] }).expect(201);
      expect((await liabilities(inv.id)).map((l) => l.component)).toEqual(['GOVERNMENT_FEE']);
      await t.as(alpha.owner).put('/finance/fee-components', { components: [{ type: 'THIRD_PARTY_FEE', treatment: 'PASS_THROUGH_LIABILITY' }] }).expect(200);
    });

    it('one payment can settle several invoices', async () => {
      const a = await issueInvoice(t, accountant, customer.customerId!, { governmentFee: '0' }); // 105
      const b = await issueInvoice(t, accountant, customer.customerId!); // 305
      const res = await recordPayment(t, receptionist, { method: 'BANK_TRANSFER', amount: '205.00', reference: 'TRF-88213', branchId: alpha.headOfficeId, allocations: [{ invoiceId: a.id, amount: '105.00' }, { invoiceId: b.id, amount: '100.00' }] }).expect(201);
      expect(res.body.paymentAllocations).toHaveLength(2);
      expect(await invoiceRow(a.id)).toMatchObject({ status: 'PAID' });
      expect(await invoiceRow(b.id)).toMatchObject({ status: 'PARTIALLY_PAID' });
      const event = (await outbox(t, alpha.id, 'payment.completed')).find((e) => (e.payload as any).paymentId === res.body.id)!;
      expect((event.payload as any).invoiceIds.sort()).toEqual([a.id, b.id].sort());
    });

    it('rejects wrong allocations, overpayment, unpayable invoices and card numbers', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const post = (body: Record<string, unknown>) => recordPayment(t, receptionist, { method: 'CASH', branchId: alpha.headOfficeId, ...body });
      const mismatch = await post({ amount: '100.00', allocations: [{ invoiceId: inv.id, amount: '90.00' }] });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.code).toBe('ALLOCATION_MISMATCH');
      const over = await post({ amount: '305.01', allocations: [{ invoiceId: inv.id, amount: '305.01' }] });
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('OVERPAYMENT');
      expect((await post({ amount: '10.00', allocations: [{ invoiceId: inv.id, amount: '5.00' }, { invoiceId: inv.id, amount: '5.00' }] })).body.code).toBe('DUPLICATE_INVOICE');
      await post({ amount: '0', allocations: [{ invoiceId: inv.id, amount: '0' }] }).expect(400);
      await post({ amount: '10.00', allocations: [] }).expect(400);
      await post({ method: 'ONLINE_GATEWAY', amount: '10.00', allocations: [{ invoiceId: inv.id, amount: '10.00' }] }).expect(400);
      // Card numbers must never be stored - not even in a free-text reference.
      const card = await post({ amount: '10.00', reference: 'card 4242 4242 4242 4242', allocations: [{ invoiceId: inv.id, amount: '10.00' }] });
      expect(card.status).toBe(400);
      expect(JSON.stringify(card.body)).toMatch(/card numbers/i);
      await post({ amount: '10.00', reference: 'Approval 123456, slip 0098', allocations: [{ invoiceId: inv.id, amount: '10.00' }] }).expect(201);

      const draft = (await t.as(accountant).post('/invoices', { customerId: customer.customerId, items: [{ description: 'Fee', component: 'SERVICE_FEE', unitAmount: '10.00' }] }).expect(201)).body;
      expect((await post({ amount: '10.00', allocations: [{ invoiceId: draft.id, amount: '10.00' }] })).body.code).toBe('INVOICE_NOT_PAYABLE');
      const voided = await issueInvoice(t, accountant, customer.customerId!);
      await t.as(accountant).post(`/invoices/${voided.id}/void`, { reason: 'Duplicate invoice' }).expect(200);
      expect((await post({ amount: '10.00', allocations: [{ invoiceId: voided.id, amount: '10.00' }] })).status).toBe(409);
      // A paid invoice can no longer be voided.
      await post({ amount: '295.00', allocations: [{ invoiceId: inv.id, amount: '295.00' }] }).expect(201);
      expect((await t.as(accountant).post(`/invoices/${inv.id}/void`, { reason: 'Too late' })).body.code).toBe('INVOICE_HAS_PAYMENTS');
    });

    it('two simultaneous payments can never both settle the same balance', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const body = { method: 'CASH', amount: '305.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '305.00' }] };
      const [a, b] = await Promise.all([recordPayment(t, receptionist, body), recordPayment(t, accountant, body)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      // The loser sees either "too much for the balance" or "already paid", depending on timing - never a second payment.
      expect([409, 422]).toContain(statuses[1]);
      const row = await invoiceRow(inv.id);
      expect(row.amountPaid.toFixed(2)).toBe('305.00');
      expect(row.balanceDue.toFixed(2)).toBe('0.00');
      expect(await t.sys.paymentAllocation.count({ where: { invoiceId: inv.id } })).toBe(1);
    });

    it('completed payments and their allocations are immutable in the database', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const p = (await recordPayment(t, receptionist, { method: 'CASH', amount: '50.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '50.00' }] }).expect(201)).body;
      await expect(t.sys.payment.update({ where: { id: p.id }, data: { amount: '500.00' } })).rejects.toThrow(/immutable/);
      await expect(t.sys.payment.update({ where: { id: p.id }, data: { status: 'PENDING' } })).rejects.toThrow(/cannot move/);
      await expect(t.sys.payment.delete({ where: { id: p.id } })).rejects.toThrow(/never deleted/);
      await expect(t.sys.paymentAllocation.updateMany({ where: { paymentId: p.id }, data: { amount: '1.00' } })).rejects.toThrow(/append-only/);
      await expect(t.sys.paymentAllocation.create({ data: { tenantId: alpha.id, paymentId: p.id, invoiceId: inv.id, amount: '0.01' } })).rejects.toThrow(/exceeds payment/);
      await expect(t.sys.liabilityEntry.deleteMany({ where: { invoiceId: inv.id } })).rejects.toThrow(/append-only/);
    });

    it('enforces permissions, own-rows access and tenant isolation', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const body = { method: 'CASH', amount: '10.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '10.00' }] };
      await recordPayment(t, operator, body).expect(403);
      await recordPayment(t, customer, body).expect(403);
      await t.as(null).post('/payments', body).expect(401);
      // Another tenant cannot pay into, or reference, Alpha's invoice or branch.
      await recordPayment(t, beta.owner, { ...body, branchId: beta.headOfficeId }).expect(404);
      await recordPayment(t, beta.owner, body).expect(404);
      const p = (await recordPayment(t, receptionist, body).expect(201)).body;
      await t.as(beta.owner).get(`/payments/${p.id}`).expect(404);
      await t.as(beta.owner).get(`/payments/${p.id}/receipt/pdf`).expect(404);
      expect((await t.as(beta.owner).get('/payments?pageSize=100').expect(200)).body.data.every((x: any) => x.tenantId === beta.id)).toBe(true);
      // The paying customer sees the payment (without internal fields); another customer does not.
      const mine = await t.as(customer).get(`/payments/${p.id}`).expect(200);
      expect(mine.body.receiptNo).toBe(p.receiptNo);
      expect(mine.body.receivedById).toBeUndefined();
      expect(mine.body.reconciliationId).toBeUndefined();
      await t.as(otherCustomer).get(`/payments/${p.id}`).expect(404);
      const list = await t.as(customer).get('/payments?pageSize=100').expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      expect(list.body.data.every((x: any) => x.customerId === customer.customerId)).toBe(true);
      expect((await t.as(otherCustomer).get('/payments').expect(200)).body.data).toHaveLength(0);
      // Filters
      const byInvoice = await t.as(accountant).get(`/payments?invoiceId=${inv.id}&method=CASH&status=COMPLETED`).expect(200);
      expect(byInvoice.body.data.map((x: any) => x.id)).toEqual([p.id]);
    });

    it('produces a receipt PDF for a completed payment', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const p = (await recordPayment(t, receptionist, { method: 'CASH', amount: '305.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '305.00' }] }).expect(201)).body;
      const pdf = await t.as(customer).get(`/payments/${p.id}/receipt/pdf`).buffer(true).parse(binary).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['content-disposition']).toContain(`receipt-${p.receiptNo}.pdf`);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await t.as(otherCustomer).get(`/payments/${p.id}/receipt/pdf`).expect(404);
    });
  });

  // ---------------------------------------------------------------- online payments
  describe('online payments through the sandbox gateway', () => {
    it('answers 503 INTEGRATION_NOT_CONFIGURED when no gateway is connected - manual payments still work', async () => {
      const c = await createCustomer(t, gamma);
      const inv = await issueInvoice(t, gamma.owner, c.id);
      const res = await t.as(gamma.owner).post(`/invoices/${inv.id}/pay`, {});
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('INTEGRATION_NOT_CONFIGURED');
      expect(res.body.message).toMatch(/Integrations/);
      expect(await t.sys.payment.count({ where: { tenantId: gamma.id } })).toBe(0);
      await recordPayment(t, gamma.owner, { method: 'CASH', amount: '305.00', branchId: gamma.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '305.00' }] }).expect(201);
    });

    it('runs the whole flow: checkout -> signed webhook -> payment completed exactly once', async () => {
      const service = await createService(t, alpha);
      const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId: service.id });
      const inv = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });
      // Only the owning customer can start the payment.
      await t.as(otherCustomer).post(`/invoices/${inv.id}/pay`, {}).expect(404);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      expect(start.body).toMatchObject({ status: 'PENDING', gateway: 'sandbox', testMode: true, amount: '305.00', currency: 'AED', invoiceId: inv.id });
      expect(start.body.checkoutUrl).toContain('/api/v1/public/payments/sandbox/checkout/sbx_cs_');
      // Nothing is paid yet.
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'ISSUED' });
      const pending = await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } });
      expect(pending).toMatchObject({ status: 'PENDING', method: 'ONLINE_GATEWAY', gateway: 'sandbox', receiptNo: null });

      const page = await t.http.get(sandboxPath(start.body.checkoutUrl)).expect(200);
      expect(page.body).toMatchObject({ gateway: 'sandbox', testMode: true, amount: '305.00', currency: 'AED' });
      expect(page.body.notice).toMatch(/TEST PAYMENT/);

      const done = await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      expect(done.body.webhook).toMatchObject({ delivered: true, status: 200, response: { received: true, processed: true, outcome: 'COMPLETED' } });
      expect(done.body.returnUrl).toContain('result=success');

      const paid = await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } });
      expect(paid.status).toBe('COMPLETED');
      expect(paid.receiptNo).toMatch(/^RCT-\d{6}$/);
      expect(paid.gatewayPaymentRef).toMatch(/^sbx_pi_/);
      expect(paid.receivedAt).toBeTruthy();
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'PAID' });
      expect((await liabilities(inv.id)).map((l) => [l.component, l.amount.toFixed(2)])).toEqual([['GOVERNMENT_FEE', '200.00']]);
      const event = (await outbox(t, alpha.id, 'payment.completed')).find((e) => (e.payload as any).paymentId === paid.id)!;
      expect(event.payload).toMatchObject({ method: 'ONLINE_GATEWAY', amount: '305.00', invoiceIds: [inv.id], requestIds: [request.id] });
      const stored = await t.sys.paymentWebhookEvent.findFirstOrThrow({ where: { gateway: 'sandbox', eventId: done.body.webhook.eventId } });
      expect(stored).toMatchObject({ signatureValid: true, status: 'PROCESSED', tenantId: alpha.id });

      // "Paying" the same session again sends a new event, but a completed payment is never completed twice.
      const again = await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      expect(again.body.webhook.response).toMatchObject({ received: true, processed: false, outcome: 'IGNORED' });
      expect(await t.sys.paymentAllocation.count({ where: { paymentId: paid.id } })).toBe(1);
      expect((await invoiceRow(inv.id)).amountPaid.toFixed(2)).toBe('305.00');
      expect((await outbox(t, alpha.id, 'payment.completed')).filter((e) => (e.payload as any).paymentId === paid.id)).toHaveLength(1);
      // The customer sees the receipt; the session reference is never exposed.
      const mine = await t.as(customer).get(`/payments/${paid.id}`).expect(200);
      expect(mine.body).toMatchObject({ status: 'COMPLETED', receiptNo: paid.receiptNo });
      expect(JSON.stringify(mine.body)).not.toContain('sbx_cs_');
      await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(409);
    });

    it('a duplicate delivery of the same event returns 200 and does nothing', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, { amount: '100.00' }).expect(201);
      const hook = buildSandboxWebhook(sessionRefOf(start.body.checkoutUrl), 'succeeded');
      const first = await postSandboxWebhook(t, hook).expect(200);
      expect(first.body).toMatchObject({ received: true, processed: true });
      const second = await postSandboxWebhook(t, hook).expect(200);
      expect(second.body).toMatchObject({ received: true, processed: false, duplicate: true });
      const third = await postSandboxWebhook(t, hook).expect(200);
      expect(third.body.duplicate).toBe(true);
      expect(await t.sys.paymentWebhookEvent.count({ where: { gateway: 'sandbox', eventId: hook.eventId } })).toBe(1);
      expect(await t.sys.paymentAllocation.count({ where: { paymentId: start.body.paymentId } })).toBe(1);
      const row = await invoiceRow(inv.id);
      expect(row).toMatchObject({ status: 'PARTIALLY_PAID' });
      expect(row.amountPaid.toFixed(2)).toBe('100.00');
    });

    it('parallel deliveries of one event complete the payment once', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      const hook = buildSandboxWebhook(sessionRefOf(start.body.checkoutUrl), 'succeeded');
      const results = await Promise.all([postSandboxWebhook(t, hook), postSandboxWebhook(t, hook), postSandboxWebhook(t, hook)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.processed === true)).toHaveLength(1);
      expect(await t.sys.paymentAllocation.count({ where: { paymentId: start.body.paymentId } })).toBe(1);
      expect((await invoiceRow(inv.id)).amountPaid.toFixed(2)).toBe('305.00');
    });

    it('rejects an invalid signature with 400 and records a security event', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      const ref = sessionRefOf(start.body.checkoutUrl);
      const before = await t.sys.securityEvent.count({ where: { type: 'WEBHOOK_SIGNATURE_INVALID' } });

      const forged = buildSandboxWebhook(ref, 'succeeded', { secret: 'not-the-real-secret' });
      const res = await postSandboxWebhook(t, forged);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      // A valid signature over a different body (tampered amount) is just as invalid.
      const genuine = buildSandboxWebhook(ref, 'succeeded');
      const tampered = { ...genuine, body: genuine.body.replace('"amount":"305.00"', '"amount":"1.00"') };
      expect(tampered.body).not.toBe(genuine.body);
      await postSandboxWebhook(t, tampered).expect(400);
      // Missing header.
      await postSandboxWebhook(t, { body: genuine.body, headers: { 'content-type': 'application/json' } }).expect(400);

      expect(await t.sys.securityEvent.count({ where: { type: 'WEBHOOK_SIGNATURE_INVALID' } })).toBe(before + 3);
      const event = await t.sys.securityEvent.findFirst({ where: { type: 'WEBHOOK_SIGNATURE_INVALID' }, orderBy: { createdAt: 'desc' } });
      expect(event).toMatchObject({ severity: 'HIGH', tenantId: alpha.id });
      // Nothing was recorded or changed.
      expect(await t.sys.paymentWebhookEvent.count({ where: { eventId: { in: [forged.eventId, genuine.eventId] } } })).toBe(0);
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } })).status).toBe('PENDING');
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'ISSUED' });
      // The untampered delivery still works afterwards.
      await postSandboxWebhook(t, genuine).expect(200);
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'PAID' });
    });

    it('rejects stale deliveries (replay resistance)', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      const ref = sessionRefOf(start.body.checkoutUrl);
      const old = buildSandboxWebhook(ref, 'succeeded', { timestampSeconds: Math.floor(Date.now() / 1000) - 301 });
      const res = await postSandboxWebhook(t, old);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      const future = buildSandboxWebhook(ref, 'succeeded', { timestampSeconds: Math.floor(Date.now() / 1000) + 3600 });
      await postSandboxWebhook(t, future).expect(400);
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } })).status).toBe('PENDING');
      const recent = buildSandboxWebhook(ref, 'succeeded', { timestampSeconds: Math.floor(Date.now() / 1000) - 120 });
      await postSandboxWebhook(t, recent).expect(200);
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } })).status).toBe('COMPLETED');
    });

    it('a failed checkout marks the payment FAILED and leaves the invoice open', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      const res = await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/fail`).send({ reason: 'Card declined (test)' }).expect(200);
      expect(res.body.webhook.response).toMatchObject({ received: true, processed: true, outcome: 'FAILED' });
      expect(res.body.returnUrl).toContain('result=cancelled');
      const failed = await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } });
      expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'Card declined (test)', receiptNo: null });
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'ISSUED' });
      expect((await outbox(t, alpha.id, 'payment.failed')).some((e) => (e.payload as any).paymentId === failed.id && (e.payload as any).reason === 'Card declined (test)')).toBe(true);
      // A success for a failed payment is not applied, and is flagged for a person to look at.
      const late = await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      expect(late.body.webhook.response.processed).toBe(false);
      expect(await t.sys.securityEvent.count({ where: { type: 'WEBHOOK_PAYMENT_NOT_PENDING', tenantId: alpha.id } })).toBeGreaterThan(0);
      // The customer can simply try again.
      const retry = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      await t.http.post(`${sandboxPath(retry.body.checkoutUrl)}/complete`).expect(200);
      expect(await invoiceRow(inv.id)).toMatchObject({ status: 'PAID' });
      // No receipt for a failed payment.
      expect((await t.as(customer).get(`/payments/${failed.id}/receipt/pdf`)).status).toBe(409);
    });

    it('money that arrives after the invoice was settled is recorded in full but left unallocated', async () => {
      const inv = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      // Meanwhile the customer pays most of it in cash at the counter.
      await recordPayment(t, receptionist, { method: 'CASH', amount: '300.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: '300.00' }] }).expect(201);
      await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      const online = (await t.as(accountant).get(`/payments/${start.body.paymentId}`).expect(200)).body;
      expect(online).toMatchObject({ status: 'COMPLETED', amount: '305.00', unallocatedAmount: '300.00' });
      expect(online.paymentAllocations.map((a: any) => a.amount)).toEqual(['5.00']);
      const row = await invoiceRow(inv.id);
      expect(row.status).toBe('PAID');
      expect(row.amountPaid.toFixed(2)).toBe('305.00');
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'payment.unallocated', resourceId: start.body.paymentId } })).toBe(1);
    });

    it('corporate admins pay their company invoices; staff can create a payment link; return URLs are validated', async () => {
      const company = await createCorporate(t, alpha);
      const rival = await createCorporate(t, alpha);
      const admin = await addCorporateAdmin(t, alpha, company.id);
      const rivalAdmin = await addCorporateAdmin(t, alpha, rival.id);
      const employee = await createCustomer(t, alpha, { corporateAccountId: company.id });
      const inv = await issueInvoice(t, accountant, employee.id, { corporateAccountId: company.id });
      await t.as(rivalAdmin).post(`/invoices/${inv.id}/pay`, {}).expect(404);
      const evil = await t.as(admin).post(`/invoices/${inv.id}/pay`, { returnUrl: 'https://evil.example.com/steal' });
      expect(evil.status).toBe(400);
      expect(evil.body.code).toBe('INVALID_RETURN_URL');
      expect(await t.sys.payment.count({ where: { tenantId: alpha.id, corporateAccountId: company.id } })).toBe(0); // refused before anything was created
      const start = await t.as(admin).post(`/invoices/${inv.id}/pay`, { amount: '105.00', returnUrl: 'http://localhost:3003/invoices/paid' }).expect(201);
      const done = await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      expect(done.body.returnUrl).toMatch(/^http:\/\/localhost:3003\/invoices\/paid\?payment=.*result=success$/);
      const payment = await t.sys.payment.findUniqueOrThrow({ where: { id: start.body.paymentId } });
      expect(payment).toMatchObject({ status: 'COMPLETED', corporateAccountId: company.id });
      expect((await t.as(admin).get('/payments').expect(200)).body.data.map((p: any) => p.id)).toEqual([payment.id]);
      expect((await t.as(rivalAdmin).get('/payments').expect(200)).body.data).toHaveLength(0);
      // Receptionist creates a link for the rest; an operator may not.
      await t.as(operator).post(`/invoices/${inv.id}/pay`, {}).expect(403);
      const link = await t.as(receptionist).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      expect(link.body.amount).toBe('200.00');
      expect((await t.as(receptionist).post(`/invoices/${inv.id}/pay`, { amount: '200.01' })).body.code).toBe('OVERPAYMENT');
    });

    it('a webhook can only ever touch the tenant that owns the payment', async () => {
      const betaCustomer = await createCustomer(t, beta);
      const betaInvoice = await issueInvoice(t, beta.owner, betaCustomer.id);
      const betaStart = await t.as(beta.owner).post(`/invoices/${betaInvoice.id}/pay`, {}).expect(201);
      const alphaInvoice = await issueInvoice(t, accountant, customer.customerId!);
      await t.http.post(`${sandboxPath(betaStart.body.checkoutUrl)}/complete`).expect(200);
      expect((await invoiceRow(betaInvoice.id)).status).toBe('PAID');
      expect((await invoiceRow(alphaInvoice.id)).status).toBe('ISSUED');
      const p = await t.sys.payment.findUniqueOrThrow({ where: { id: betaStart.body.paymentId } });
      expect(p.tenantId).toBe(beta.id);
      await t.as(alpha.owner).get(`/payments/${p.id}`).expect(404);
      const audit = await t.sys.auditLog.findFirst({ where: { action: 'payment.completed_online', resourceId: p.id } });
      expect(audit).toMatchObject({ tenantId: beta.id, actorType: 'SYSTEM', actorLabel: 'webhook:sandbox' });
    });

    it('unknown gateways and unknown sessions are handled safely', async () => {
      await t.http.post('/api/v1/public/webhooks/payments/paypal').send({ id: 'x' }).expect(404);
      await t.http.get('/api/v1/public/payments/sandbox/checkout/sbx_cs_not-a-real-session').expect(404);
      await t.http.post('/api/v1/public/payments/sandbox/checkout/garbage/complete').expect(404);
      // A correctly signed sandbox event about a session we never created is acknowledged and ignored.
      const body = JSON.stringify({ id: `sbx_evt_${uniq()}`, type: 'checkout.succeeded', created: Math.floor(Date.now() / 1000), data: { sessionRef: 'sbx_cs_unknown', paymentRef: 'sbx_pi_unknown', amount: '5.00', currency: 'AED', metadata: {} } });
      const res = await postSandboxWebhook(t, { body, headers: { 'content-type': 'application/json', 'x-typease-sandbox-signature': signTimestamped(body, 'sandbox-webhook-secret-change-me') } }).expect(200);
      expect(res.body).toMatchObject({ received: true, processed: false, reason: 'UNKNOWN_REFERENCE' });
    });
  });

  // ---------------------------------------------------------------- stripe webhooks (signature scheme, tenant secrets)
  describe('stripe webhooks verified with the tenant\'s own signing secret', () => {
    const stripeEvent = (sessionId: string, paymentId: string, opts: { type?: string; amountMinor?: number; id?: string } = {}) =>
      JSON.stringify({
        id: opts.id ?? `evt_${uniq()}`,
        object: 'event',
        type: opts.type ?? 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: sessionId, object: 'checkout.session', payment_status: 'paid', payment_intent: `pi_${uniq()}`, amount_total: opts.amountMinor ?? 30500, currency: 'aed', client_reference_id: paymentId, metadata: { paymentId } } },
      });
    const post = (body: string, signature?: string) => {
      let req = t.http.post('/api/v1/public/webhooks/payments/stripe').set('content-type', 'application/json');
      if (signature) req = req.set('Stripe-Signature', signature);
      return req.send(body);
    };
    let delta: TenantFixture;
    let invoiceId: string;
    const pendingStripePayment = async (amount = '305.00') => {
      const sessionId = `cs_test_${uniq()}`;
      const inv = await t.sys.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      const p = await t.sys.payment.create({
        data: { tenantId: delta.id, branchId: delta.headOfficeId, paymentNo: `PAY-S${uniq()}`, customerId: inv.customerId, method: 'ONLINE_GATEWAY', status: 'PENDING', amount, currency: 'AED', gateway: 'stripe', gatewaySessionRef: sessionId, reference: inv.invoiceNo },
      });
      return { sessionId, paymentId: p.id };
    };

    beforeAll(async () => {
      delta = await t.createTenant({ name: 'Delta Typing' });
      await enableStripe(t, delta, { secretKey: 'sk_test_delta', webhookSecret: 'whsec_delta_secret' });
      const c = await createCustomer(t, delta);
      invoiceId = (await issueInvoice(t, delta.owner, c.id)).id;
    });

    it('completes the payment for a correctly signed checkout.session.completed', async () => {
      const { sessionId, paymentId } = await pendingStripePayment();
      const body = stripeEvent(sessionId, paymentId);
      // Signed with another secret: refused.
      const wrong = await post(body, signTimestamped(body, 'whsec_someone_else'));
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      await post(body).expect(400);
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('PENDING');

      const ok = await post(body, signTimestamped(body, 'whsec_delta_secret')).expect(200);
      expect(ok.body).toMatchObject({ received: true, processed: true, outcome: 'COMPLETED' });
      const paid = await t.sys.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(paid.status).toBe('COMPLETED');
      expect(paid.gatewayPaymentRef).toMatch(/^pi_/);
      expect((await invoiceRow(invoiceId)).status).toBe('PAID');
      expect((await post(body, signTimestamped(body, 'whsec_delta_secret')).expect(200)).body.duplicate).toBe(true);
    });

    it('refuses to complete when the gateway amount differs from the expected amount', async () => {
      const { sessionId, paymentId } = await pendingStripePayment('50.00');
      const body = stripeEvent(sessionId, paymentId, { amountMinor: 100 });
      const res = await post(body, signTimestamped(body, 'whsec_delta_secret')).expect(200);
      expect(res.body).toMatchObject({ processed: false, reason: 'AMOUNT_MISMATCH' });
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('PENDING');
      expect(await t.sys.securityEvent.count({ where: { type: 'WEBHOOK_AMOUNT_MISMATCH', tenantId: delta.id } })).toBe(1);
    });

    it('expired sessions fail the payment; unrelated Stripe events are acknowledged without verification', async () => {
      const { sessionId, paymentId } = await pendingStripePayment('20.00');
      const body = stripeEvent(sessionId, paymentId, { type: 'checkout.session.expired', amountMinor: 2000 });
      await post(body, signTimestamped(body, 'whsec_delta_secret')).expect(200);
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('FAILED');
      const foreign = stripeEvent('cs_test_not_ours', '00000000-0000-4000-8000-000000000000');
      const res = await post(foreign, signTimestamped(foreign, 'whsec_whatever')).expect(200);
      expect(res.body).toMatchObject({ received: true, processed: false, reason: 'UNKNOWN_REFERENCE' });
    });
  });
});

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
