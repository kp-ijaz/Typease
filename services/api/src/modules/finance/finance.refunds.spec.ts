import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { listen } from './fixtures';
import { createCustomer, createRequest, createService, enableSandbox, issueInvoice, key, line, outbox, recordPayment } from './fixtures';

const sandboxPath = (checkoutUrl: string) => new URL(checkoutUrl).pathname;

describe('Finance: refunds, credit notes, expenses, liabilities and reconciliation', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let manager: Actor;
  let accountant: Actor;
  let operator: Actor;
  let customer: Actor;
  let otherCustomer: Actor;
  let serviceId: string;

  const invoiceRow = (id: string) => t.sys.invoice.findUniqueOrThrow({ where: { id } });
  const paymentRow = (id: string) => t.sys.payment.findUniqueOrThrow({ where: { id } });
  const ledger = async (invoiceId: string) =>
    (await t.sys.liabilityEntry.findMany({ where: { invoiceId }, orderBy: { occurredAt: 'asc' } })).map((l) => `${l.component}:${l.direction}:${l.amount.toFixed(2)}`);
  const requestRefund = (actor: Actor, body: Record<string, unknown>, k: string = key()) => t.as(actor).post('/refunds', body).set('Idempotency-Key', k);

  /** An issued invoice (service 100 + 5 tax, government 200 = 305) linked to a request, fully paid in cash. */
  async function paidInvoice(opts: { assignedToId?: string | null; amount?: string } = {}) {
    const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId, assignedToId: opts.assignedToId });
    const invoice = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });
    const amount = opts.amount ?? '305.00';
    const payment = (await recordPayment(t, receptionist, { method: 'CASH', amount, branchId: alpha.headOfficeId, allocations: [{ invoiceId: invoice.id, amount }] }).expect(201)).body;
    return { request, invoice, payment };
  }

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    manager = await t.addStaff(alpha, 'manager');
    accountant = await t.addStaff(alpha, 'accountant');
    operator = await t.addStaff(alpha, 'operator');
    customer = await t.addCustomer(alpha, { fullName: 'Aisha Khan' });
    otherCustomer = await t.addCustomer(alpha, { fullName: 'Omar Said' });
    serviceId = (await createService(t, alpha)).id;
    await enableSandbox(t, alpha);
  });
  afterAll(() => t.close());

  // ---------------------------------------------------------------- refunds
  describe('refunds (request, then approval by a different person)', () => {
    it('a refund is requested against a completed payment, idempotently', async () => {
      const { payment, invoice, request } = await paidInvoice();
      const body = { paymentId: payment.id, amount: '152.50', reason: 'Customer cancelled half of the service' };
      expect((await t.as(manager).post('/refunds', body)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const k = key();
      const res = await requestRefund(manager, body, k).expect(201);
      expect(res.body.refundNo).toMatch(/^RFD-\d{6}$/);
      expect(res.body).toMatchObject({ status: 'REQUESTED', amount: '152.50', currency: 'AED', paymentId: payment.id, invoiceId: invoice.id, requestId: request.id, requestedById: manager.userId, method: 'CASH' });
      const replay = await requestRefund(manager, body, k).expect(201);
      expect(replay.body.id).toBe(res.body.id);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await t.sys.refund.count({ where: { paymentId: payment.id } })).toBe(1);
      // Nothing has moved yet.
      expect((await paymentRow(payment.id)).refundedAmount.toFixed(2)).toBe('0.00');
      expect((await outbox(t, alpha.id, 'refund.requested')).some((e) => (e.payload as any).refundId === res.body.id && (e.payload as any).amount === '152.50' && (e.payload as any).requestId === request.id)).toBe(true);
    });

    it('an operator cannot approve their own refund, and a role without refund.approve gets 403', async () => {
      const { payment } = await paidInvoice({ assignedToId: operator.membershipId });
      // Operators may request refunds on requests assigned to them...
      const refund = (await requestRefund(operator, { paymentId: payment.id, amount: '50.00', reason: 'Wrong service chosen' }).expect(201)).body;
      // ...but have no refund.approve permission at all:
      await t.as(operator).post(`/refunds/${refund.id}/approve`, { reference: 'CASH-1' }).expect(403);
      await t.as(operator).post(`/refunds/${refund.id}/complete`, { reference: 'CASH-1' }).expect(403);
      await t.as(operator).post(`/refunds/${refund.id}/reject`, { reason: 'changed my mind' }).expect(403);
      await t.as(manager).post(`/refunds/${refund.id}/approve`, {}).expect(403); // managers request, they do not approve
      await t.as(receptionist).post(`/refunds/${refund.id}/approve`, {}).expect(403);
      await t.as(customer).post(`/refunds/${refund.id}/approve`, {}).expect(403);
      expect((await t.sys.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('REQUESTED');

      // Someone who holds BOTH permissions still cannot approve what they requested themselves.
      const own = (await requestRefund(accountant, { paymentId: payment.id, amount: '20.00', reason: 'Overcharged by mistake' }).expect(201)).body;
      const self = await t.as(accountant).post(`/refunds/${own.id}/approve`, { reference: 'CASH-2' });
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      // Not even the owner may approve their own request.
      const ownerOwn = (await requestRefund(alpha.owner, { paymentId: payment.id, amount: '10.00', reason: 'Goodwill gesture' }).expect(201)).body;
      expect((await t.as(alpha.owner).post(`/refunds/${ownerOwn.id}/approve`, { reference: 'CASH-3' })).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      // Approved by someone else, the requester still cannot pay it out to themselves.
      await t.as(alpha.owner).post(`/refunds/${own.id}/approve`, {}).expect(200);
      expect((await t.as(accountant).post(`/refunds/${own.id}/complete`, { reference: 'CASH-2' })).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await paymentRow(payment.id)).refundedAmount.toFixed(2)).toBe('0.00');
      // The operator's refund is approved and paid out by the accountant.
      const done = await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'Cash voucher 17' }).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', decidedById: accountant.userId, gatewayRefundRef: 'Cash voucher 17' });
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'refund.completed', resourceId: refund.id } });
      expect(audit!.after).toMatchObject({ requestedById: operator.userId, paidOutBy: accountant.userId, manual: true });
    });

    it('completion without cancelling the charge re-opens the balance and reverses the pass-through share', async () => {
      const { payment, invoice, request } = await paidInvoice();
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:200.00']);
      const refund = (await requestRefund(manager, { paymentId: payment.id, amount: '152.50', reason: 'Half of the work was not needed' }).expect(201)).body;
      const res = await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'Bank transfer TRF-771' }).expect(200);
      expect(res.body).toMatchObject({ status: 'COMPLETED', amount: '152.50' });
      expect(res.body.processedAt).toBeTruthy();
      // 152.50 of 305 leaves 152.50 collected -> government share 100.00, so 100.00 is reversed; the rest is service fee.
      expect(res.body.breakdown).toMatchObject({ SERVICE_FEE: '52.50', GOVERNMENT_FEE: '100.00', THIRD_PARTY_FEE: '0.00', cancelCharge: false });
      expect(await paymentRow(payment.id)).toMatchObject({ status: 'PARTIALLY_REFUNDED' });
      expect((await paymentRow(payment.id)).refundedAmount.toFixed(2)).toBe('152.50');
      const inv = await invoiceRow(invoice.id);
      expect(inv.status).toBe('PARTIALLY_PAID');
      expect([inv.amountPaid, inv.amountRefunded, inv.amountCredited, inv.balanceDue].map((d) => d.toFixed(2))).toEqual(['305.00', '152.50', '0.00', '152.50']);
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:200.00', 'GOVERNMENT_FEE:REVERSAL:100.00']);
      const event = (await outbox(t, alpha.id, 'refund.completed')).find((e) => (e.payload as any).refundId === refund.id)!;
      expect(event.payload).toMatchObject({ paymentId: payment.id, invoiceId: invoice.id, requestId: request.id, amount: '152.50', currency: 'AED' });
      expect(await t.sys.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(0);
      // The customer pays the re-opened balance again: the liability is accrued again, exactly.
      await recordPayment(t, receptionist, { method: 'CASH', amount: '152.50', branchId: alpha.headOfficeId, allocations: [{ invoiceId: invoice.id, amount: '152.50' }] }).expect(201);
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:200.00', 'GOVERNMENT_FEE:REVERSAL:100.00', 'GOVERNMENT_FEE:ACCRUAL:100.00']);
      expect((await invoiceRow(invoice.id)).status).toBe('PAID');
    });

    it('completion with cancelCharge issues a matching credit note so the balance stays closed', async () => {
      const { payment, invoice } = await paidInvoice();
      const refund = (await requestRefund(manager, { paymentId: payment.id, amount: '305.00', reason: 'Application withdrawn', cancelCharge: true }).expect(201)).body;
      const res = await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'Cash voucher 31' }).expect(200);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.breakdown).toMatchObject({ SERVICE_FEE: '105.00', GOVERNMENT_FEE: '200.00', cancelCharge: true });
      expect((await paymentRow(payment.id)).status).toBe('REFUNDED');
      const inv = await invoiceRow(invoice.id);
      expect(inv.status).toBe('CREDITED');
      expect([inv.amountPaid, inv.amountRefunded, inv.amountCredited, inv.balanceDue].map((d) => d.toFixed(2))).toEqual(['305.00', '305.00', '305.00', '0.00']);
      const notes = await t.sys.creditNote.findMany({ where: { invoiceId: invoice.id } });
      expect(notes).toHaveLength(1);
      expect(notes[0].creditNoteNo).toMatch(/^CN-\d{6}$/);
      expect(notes[0].amount.toFixed(2)).toBe('305.00');
      expect(notes[0].breakdown).toEqual({ SERVICE_FEE: '105.00', GOVERNMENT_FEE: '200.00', THIRD_PARTY_FEE: '0.00' });
      expect(notes[0].reason).toContain(refund.refundNo);
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:200.00', 'GOVERNMENT_FEE:REVERSAL:200.00']);
      // Fully refunded: nothing more can be requested.
      expect((await requestRefund(manager, { paymentId: payment.id, amount: '1.00', reason: 'one more' })).body.code).toBe('PAYMENT_NOT_REFUNDABLE');
    });

    it('the approver can override cancelCharge, and a partial cancellation keeps the invoice PAID', async () => {
      const { payment, invoice } = await paidInvoice();
      const refund = (await requestRefund(manager, { paymentId: payment.id, amount: '61.00', reason: 'One document dropped' }).expect(201)).body;
      await t.as(accountant).post(`/refunds/${refund.id}/approve`, { cancelCharge: true, reference: 'V-9' }).expect(200);
      const inv = await invoiceRow(invoice.id);
      expect(inv.status).toBe('PAID');
      expect([inv.amountRefunded, inv.amountCredited, inv.balanceDue].map((d) => d.toFixed(2))).toEqual(['61.00', '61.00', '0.00']);
      // 61 of 305 = one fifth: 40.00 government, 21.00 service
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:200.00', 'GOVERNMENT_FEE:REVERSAL:40.00']);
    });

    it('an explicit component breakdown is validated and drives the liability reversal', async () => {
      const { payment, invoice } = await paidInvoice();
      const bad = await requestRefund(manager, { paymentId: payment.id, amount: '50.00', reason: 'Service fee only', breakdown: { SERVICE_FEE: '40.00' } });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('BREAKDOWN_MISMATCH');
      const tooMuch = await requestRefund(manager, { paymentId: payment.id, amount: '250.00', reason: 'All government fee', breakdown: { GOVERNMENT_FEE: '250.00' } });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.code).toBe('BREAKDOWN_EXCEEDS_COLLECTED');
      const refund = (await requestRefund(manager, { paymentId: payment.id, amount: '50.00', reason: 'Service fee goodwill', breakdown: { SERVICE_FEE: '47.62', TAX: '2.38' } }).expect(201)).body;
      const done = await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'V-10' }).expect(200);
      expect(done.body.breakdown).toMatchObject({ SERVICE_FEE: '50.00', GOVERNMENT_FEE: '0.00', TAX: '2.38', explicit: true });
      // The government fee stays fully held.
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:200.00']);
    });

    it('never lets requests exceed what is left of the payment', async () => {
      const { payment } = await paidInvoice();
      expect((await requestRefund(manager, { paymentId: payment.id, amount: '305.01', reason: 'too much' })).body.code).toBe('REFUND_EXCEEDS_PAYMENT');
      await requestRefund(manager, { paymentId: payment.id, amount: '200.00', reason: 'first request' }).expect(201);
      const second = await requestRefund(manager, { paymentId: payment.id, amount: '105.01', reason: 'second request' });
      expect(second.status).toBe(422);
      expect(second.body.code).toBe('REFUND_EXCEEDS_PAYMENT');
      expect(second.body.message).toMatch(/waiting in other refund requests/);
      await requestRefund(manager, { paymentId: payment.id, amount: '105.00', reason: 'second request' }).expect(201);
    });

    it('can be rejected with a reason; approval and completion follow the state machine', async () => {
      const { payment } = await paidInvoice();
      const a = (await requestRefund(manager, { paymentId: payment.id, amount: '10.00', reason: 'not justified' }).expect(201)).body;
      await t.as(accountant).post(`/refunds/${a.id}/reject`, {}).expect(400);
      const rejected = await t.as(accountant).post(`/refunds/${a.id}/reject`, { reason: 'Service was delivered' }).expect(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'Service was delivered' });
      expect((await t.as(accountant).post(`/refunds/${a.id}/approve`, {})).body.code).toBe('REFUND_NOT_PENDING');
      expect((await t.as(accountant).post(`/refunds/${a.id}/complete`, { reference: 'x' })).body.code).toBe('REFUND_NOT_APPROVED');

      const b = (await requestRefund(manager, { paymentId: payment.id, amount: '10.00', reason: 'two-step' }).expect(201)).body;
      expect((await t.as(accountant).post(`/refunds/${b.id}/complete`, { reference: 'x' })).body.code).toBe('REFUND_NOT_APPROVED');
      const approved = await t.as(accountant).post(`/refunds/${b.id}/approve`, {}).expect(200);
      expect(approved.body.status).toBe('APPROVED'); // manual method: waits for the pay-out reference
      expect((await paymentRow(payment.id)).refundedAmount.toFixed(2)).toBe('0.00');
      expect((await t.as(accountant).post(`/refunds/${b.id}/process`)).body.code).toBe('MANUAL_REFUND');
      const completed = await t.as(alpha.owner).post(`/refunds/${b.id}/complete`, { reference: 'Cash voucher 44' }).expect(200);
      expect(completed.body.status).toBe('COMPLETED');
      expect((await t.as(alpha.owner).post(`/refunds/${b.id}/complete`, { reference: 'again' })).status).toBe(409);
      expect((await paymentRow(payment.id)).refundedAmount.toFixed(2)).toBe('10.00');
      // The refund amount is immutable in the database.
      await expect(t.sys.refund.update({ where: { id: b.id }, data: { amount: '99.00' } })).rejects.toThrow(/immutable/);
    });

    it('gateway payments are refunded through the gateway adapter on approval', async () => {
      const invoice = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${invoice.id}/pay`, {}).expect(201);
      await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      const refund = (await requestRefund(manager, { paymentId: start.body.paymentId, amount: '305.00', reason: 'Paid twice', cancelCharge: true }).expect(201)).body;
      expect(refund.method).toBe('GATEWAY');
      const done = await t.as(accountant).post(`/refunds/${refund.id}/approve`, {}).expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.gatewayRefundRef).toMatch(/^sbx_re_/);
      expect((await paymentRow(start.body.paymentId)).status).toBe('REFUNDED');
      expect((await invoiceRow(invoice.id)).status).toBe('CREDITED');
    });

    it('a gateway failure leaves the money untouched; the refund can be retried or completed manually', async () => {
      const invoice = await issueInvoice(t, accountant, customer.customerId!);
      const start = await t.as(customer).post(`/invoices/${invoice.id}/pay`, {}).expect(201);
      await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      const refund = (await requestRefund(manager, { paymentId: start.body.paymentId, amount: '100.00', reason: 'Declined on purpose [sandbox:fail]' }).expect(201)).body;
      const failed = await t.as(accountant).post(`/refunds/${refund.id}/approve`, {}).expect(200);
      expect(failed.body.status).toBe('FAILED');
      expect(failed.body.rejectionReason).toMatch(/declined/i);
      expect((await paymentRow(start.body.paymentId)).refundedAmount.toFixed(2)).toBe('0.00');
      expect((await invoiceRow(invoice.id)).status).toBe('PAID');
      expect((await t.as(accountant).post(`/refunds/${refund.id}/process`).expect(200)).body.status).toBe('FAILED');
      expect((await t.as(manager).post(`/refunds/${refund.id}/process`)).status).toBe(403);
      const manual = await t.as(accountant).post(`/refunds/${refund.id}/complete`, { reference: 'Refunded in the gateway dashboard, ref 5521' }).expect(200);
      expect(manual.body).toMatchObject({ status: 'COMPLETED', rejectionReason: null });
      expect((await paymentRow(start.body.paymentId)).refundedAmount.toFixed(2)).toBe('100.00');
      expect((await invoiceRow(invoice.id)).status).toBe('PARTIALLY_PAID');
    });

    it('is scoped: operators to their assigned requests, tenants to themselves, customers not at all', async () => {
      const mine = await paidInvoice({ assignedToId: operator.membershipId });
      const notMine = await paidInvoice();
      const res = await requestRefund(operator, { paymentId: notMine.payment.id, amount: '5.00', reason: 'not my request' });
      expect(res.status).toBe(404);
      const refund = (await requestRefund(operator, { paymentId: mine.payment.id, amount: '5.00', reason: 'my request' }).expect(201)).body;
      await t.as(operator).get(`/refunds/${refund.id}`).expect(200);
      const other = (await requestRefund(manager, { paymentId: notMine.payment.id, amount: '5.00', reason: 'manager request' }).expect(201)).body;
      await t.as(operator).get(`/refunds/${other.id}`).expect(404);
      const visible = (await t.as(operator).get('/refunds?pageSize=100').expect(200)).body.data.map((r: any) => r.id);
      expect(visible).toContain(refund.id);
      expect(visible).not.toContain(other.id);
      await t.as(receptionist).get('/refunds').expect(403);
      await t.as(customer).get('/refunds').expect(403);
      await requestRefund(receptionist, { paymentId: mine.payment.id, amount: '5.00', reason: 'no permission' }).expect(403);
      // Tenant isolation
      await t.as(beta.owner).get(`/refunds/${refund.id}`).expect(404);
      await t.as(beta.owner).post(`/refunds/${refund.id}/approve`, { reference: 'x' }).expect(404);
      await t.as(beta.owner).post(`/refunds/${refund.id}/reject`, { reason: 'hijack' }).expect(404);
      await requestRefund(beta.owner, { paymentId: mine.payment.id, amount: '5.00', reason: 'cross tenant' }).expect(404);
      expect((await t.as(beta.owner).get('/refunds').expect(200)).body.data).toHaveLength(0);
      expect((await t.sys.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('REQUESTED');
      const filtered = await t.as(accountant).get(`/refunds?status=REQUESTED&paymentId=${mine.payment.id}`).expect(200);
      expect(filtered.body.data.map((r: any) => r.id)).toEqual([refund.id]);
    });
  });

  // ---------------------------------------------------------------- credit notes
  describe('credit notes', () => {
    it('reduce the balance of an issued invoice; fully credited with nothing paid becomes CREDITED', async () => {
      const invoice = await issueInvoice(t, accountant, customer.customerId!);
      const first = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '55.00', reason: 'Price correction' }).expect(201);
      expect(first.body.creditNoteNo).toMatch(/^CN-\d{6}$/);
      expect(first.body).toMatchObject({ amount: '55.00', status: 'ISSUED', invoiceStatus: 'ISSUED', invoiceBalanceDue: '250.00', issuedById: accountant.userId });
      // Spread over the components in proportion (remainder on the service fee): 55 * 200/305 = 36.07
      expect(first.body.breakdown).toEqual({ SERVICE_FEE: '18.93', GOVERNMENT_FEE: '36.07', THIRD_PARTY_FEE: '0.00' });
      let inv = await invoiceRow(invoice.id);
      expect([inv.amountCredited, inv.balanceDue].map((d) => d.toFixed(2))).toEqual(['55.00', '250.00']);
      const tooMuch = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '250.01', reason: 'too much' });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.code).toBe('CREDIT_EXCEEDS_BALANCE');
      const rest = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '250.00', reason: 'Service cancelled before work started' }).expect(201);
      expect(rest.body).toMatchObject({ invoiceStatus: 'CREDITED', invoiceBalanceDue: '0.00' });
      inv = await invoiceRow(invoice.id);
      expect(inv.status).toBe('CREDITED');
      expect((await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '1.00', reason: 'nothing left' })).body.code).toBe('NOTHING_TO_CREDIT');
      // A credited invoice cannot take payments or be voided.
      expect((await recordPayment(t, receptionist, { method: 'CASH', amount: '1.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: invoice.id, amount: '1.00' }] })).status).toBe(409);
      expect((await t.as(accountant).post(`/invoices/${invoice.id}/void`, { reason: 'try to void' })).body.code).toBe('INVOICE_HAS_CREDITS');
      const detail = (await t.as(accountant).get(`/invoices/${invoice.id}`)).body;
      expect(detail.creditNotes.map((c: any) => c.amount)).toEqual(['55.00', '250.00']);
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'creditnote.issued', resourceId: first.body.id } });
      expect(audit!.after).toMatchObject({ amount: '55.00', balanceDue: '250.00' });
    });

    it('crediting the unpaid remainder of a part-paid invoice settles it without disturbing the liability', async () => {
      const { invoice } = await paidInvoice({ amount: '100.00' });
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:65.57']);
      const res = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '205.00', reason: 'Remaining work cancelled' }).expect(201);
      expect(res.body).toMatchObject({ invoiceStatus: 'PAID', invoiceBalanceDue: '0.00' });
      expect(res.body.breakdown).toEqual({ SERVICE_FEE: '70.57', GOVERNMENT_FEE: '134.43', THIRD_PARTY_FEE: '0.00' });
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:65.57']);
    });

    it('crediting only the service fee re-classifies money already collected as government fee', async () => {
      const { invoice } = await paidInvoice({ amount: '200.00' }); // government share so far: 131.15
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:131.15']);
      const wrong = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '105.00', reason: 'bad split', breakdown: { SERVICE_FEE: '100.00' } });
      expect(wrong.body.code).toBe('BREAKDOWN_MISMATCH');
      const tooMuch = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '105.00', reason: 'bad split', breakdown: { SERVICE_FEE: '0.00', THIRD_PARTY_FEE: '105.00' } });
      expect(tooMuch.body.code).toBe('BREAKDOWN_EXCEEDS_COMPONENT');
      // The whole service fee (105 incl. tax) is waived: what the customer owes is now only the 200 government fee, all of it collected.
      await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '105.00', reason: 'Service fee waived', breakdown: { SERVICE_FEE: '105.00' } }).expect(201);
      expect((await invoiceRow(invoice.id)).status).toBe('PAID');
      expect(await ledger(invoice.id)).toEqual(['GOVERNMENT_FEE:ACCRUAL:131.15', 'GOVERNMENT_FEE:ACCRUAL:68.85']);
    });

    it('cannot credit a paid, draft or void invoice', async () => {
      const { invoice } = await paidInvoice();
      const paid = await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '10.00', reason: 'after payment' });
      expect(paid.status).toBe(409);
      expect(paid.body.code).toBe('NOTHING_TO_CREDIT');
      expect(paid.body.message).toMatch(/refund the payment/i);
      const draft = (await t.as(accountant).post('/invoices', { customerId: customer.customerId, items: [line('SERVICE_FEE', '10.00')] }).expect(201)).body;
      expect((await t.as(accountant).post('/credit-notes', { invoiceId: draft.id, amount: '1.00', reason: 'on a draft' })).body.code).toBe('INVOICE_NOT_ISSUED');
      const voided = await issueInvoice(t, accountant, customer.customerId!);
      await t.as(accountant).post(`/invoices/${voided.id}/void`, { reason: 'Issued by mistake' }).expect(200);
      expect((await t.as(accountant).post('/credit-notes', { invoiceId: voided.id, amount: '1.00', reason: 'on a void invoice' })).body.code).toBe('INVOICE_VOID');
    });

    it('enforces permissions, own-rows access, PDF and tenant isolation', async () => {
      const invoice = await issueInvoice(t, accountant, customer.customerId!);
      const body = { invoiceId: invoice.id, amount: '5.00', reason: 'Small correction' };
      await t.as(manager).post('/credit-notes', body).expect(403);
      await t.as(receptionist).post('/credit-notes', body).expect(403);
      await t.as(customer).post('/credit-notes', body).expect(403);
      await t.as(beta.owner).post('/credit-notes', body).expect(404);
      const cn = (await t.as(accountant).post('/credit-notes', body).expect(201)).body;
      const mine = await t.as(customer).get(`/credit-notes/${cn.id}`).expect(200);
      expect(mine.body.issuedById).toBeUndefined();
      expect((await t.as(customer).get('/credit-notes').expect(200)).body.data.map((c: any) => c.id)).toContain(cn.id);
      await t.as(otherCustomer).get(`/credit-notes/${cn.id}`).expect(404);
      expect((await t.as(otherCustomer).get('/credit-notes').expect(200)).body.data).toHaveLength(0);
      await t.as(beta.owner).get(`/credit-notes/${cn.id}`).expect(404);
      await t.as(beta.owner).get(`/credit-notes/${cn.id}/pdf`).expect(404);
      const pdf = await t.as(customer).get(`/credit-notes/${cn.id}/pdf`).buffer(true).parse(binary).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await expect(t.sys.creditNote.update({ where: { id: cn.id }, data: { amount: '500.00' } })).rejects.toThrow(/immutable/);
    });
  });

  // ---------------------------------------------------------------- expenses and liabilities
  // ---------------------------------------------------------------- request payment status
  describe('request payment status after voids, credit notes and refunds', () => {
    const statusOf = async (requestId: string) => (await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).paymentStatus;
    const pay = (invoiceId: string, amount: string) => recordPayment(t, receptionist, { method: 'CASH', amount, branchId: alpha.headOfficeId, allocations: [{ invoiceId, amount }] }).expect(201);
    const eventFor = async (type: string, match: (p: any) => boolean) => (await outbox(t, alpha.id, type)).map((e) => e.payload as any).find(match);

    it('a credit note on the open balance settles the request; crediting everything means nothing is owed', async () => {
      const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId });
      const invoice = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });
      expect(await statusOf(request.id)).toBe('UNPAID');
      await pay(invoice.id, '100.00');
      expect(await statusOf(request.id)).toBe('PARTIALLY_PAID');
      // The unpaid remainder is waived: what was invoiced is now covered by what was paid.
      const note = (await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '205.00', reason: 'Remaining work cancelled' }).expect(201)).body;
      expect(note.invoiceStatus).toBe('PAID');
      expect(await statusOf(request.id)).toBe('PAID');
      const event = await eventFor('creditnote.issued', (p) => p.creditNoteId === note.id);
      expect(event).toMatchObject({ creditNoteNo: note.creditNoteNo, invoiceId: invoice.id, requestId: request.id, customerId: customer.customerId, amount: '205.00', currency: 'AED', _actor: { userId: accountant.userId, type: 'STAFF' } });
      expect(event).not.toHaveProperty('refundId');

      // Nothing paid and the whole charge credited: no payment is required any more.
      const waived = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId });
      const waivedInvoice = await issueInvoice(t, accountant, customer.customerId!, { requestId: waived.id });
      await t.as(accountant).post('/credit-notes', { invoiceId: waivedInvoice.id, amount: '100.00', reason: 'Goodwill discount' }).expect(201);
      expect(await statusOf(waived.id)).toBe('UNPAID');
      await t.as(accountant).post('/credit-notes', { invoiceId: waivedInvoice.id, amount: '205.00', reason: 'Service withdrawn' }).expect(201);
      expect((await invoiceRow(waivedInvoice.id)).status).toBe('CREDITED');
      expect(await statusOf(waived.id)).toBe('NOT_REQUIRED');
    });

    it('voiding an unpaid invoice stops it counting towards the request', async () => {
      const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId });
      const first = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });
      await pay(first.id, '305.00');
      expect(await statusOf(request.id)).toBe('PAID');
      // A second invoice issued by mistake re-opens a balance on the request ...
      const mistake = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id, serviceFee: '50.00', governmentFee: '0' });
      expect(await statusOf(request.id)).toBe('PARTIALLY_PAID');
      // ... and voiding it restores the truth.
      await t.as(accountant).post(`/invoices/${mistake.id}/void`, { reason: 'Issued twice by mistake' }).expect(200);
      expect(await statusOf(request.id)).toBe('PAID');
      const event = await eventFor('invoice.voided', (p) => p.invoiceId === mistake.id);
      expect(event).toMatchObject({ requestId: request.id, customerId: customer.customerId, total: '52.50', currency: 'AED', reason: 'Issued twice by mistake', _actor: { userId: accountant.userId } });

      // The only invoice of a request is voided: the request is back to "nothing invoiced".
      const single = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId });
      const only = await issueInvoice(t, accountant, customer.customerId!, { requestId: single.id });
      await t.sys.serviceRequest.update({ where: { id: single.id }, data: { paymentStatus: 'PARTIALLY_PAID' } }); // a stale value must be corrected, not trusted
      await t.as(accountant).post(`/invoices/${only.id}/void`, { reason: 'Customer changed their mind' }).expect(200);
      expect(await statusOf(single.id)).toBe('UNPAID');

      // A draft was never announced to other modules: discarding it announces nothing.
      const draft = (await t.as(accountant).post('/invoices', { customerId: customer.customerId!, requestId: request.id, items: [line('SERVICE_FEE', '10.00')] }).expect(201)).body;
      await t.as(accountant).post(`/invoices/${draft.id}/void`, { reason: 'Draft not needed' }).expect(200);
      expect(await eventFor('invoice.voided', (p) => p.invoiceId === draft.id)).toBeUndefined();
      expect(await statusOf(request.id)).toBe('PAID');
    });

    it('pay, refund part, refund the rest with the charge cancelled: correct at every step', async () => {
      const { request, invoice, payment } = await paidInvoice();
      expect(await statusOf(request.id)).toBe('PAID');
      const partial = (await requestRefund(manager, { paymentId: payment.id, amount: '105.00', reason: 'Service fee returned' }).expect(201)).body;
      await t.as(accountant).post(`/refunds/${partial.id}/approve`, { reference: 'Cash voucher 40' }).expect(200);
      expect(await statusOf(request.id)).toBe('PARTIALLY_REFUNDED');

      const rest = (await requestRefund(manager, { paymentId: payment.id, amount: '200.00', reason: 'Application withdrawn', cancelCharge: true }).expect(201)).body;
      await t.as(accountant).post(`/refunds/${rest.id}/approve`, { reference: 'Cash voucher 41' }).expect(200);
      expect(await statusOf(request.id)).toBe('REFUNDED');
      // The credit note that came with the refund is announced too, and says which refund it belongs to.
      const note = await t.sys.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      expect(await eventFor('creditnote.issued', (p) => p.creditNoteId === note.id)).toMatchObject({ invoiceId: invoice.id, requestId: request.id, amount: '200.00', refundId: rest.id });
      expect((await outbox(t, alpha.id, 'creditnote.issued')).filter((e) => (e.payload as any).invoiceId === invoice.id)).toHaveLength(1);

      // A credit note on the re-opened balance of a part-refunded invoice keeps the refund visible.
      const other = await paidInvoice();
      const refund = (await requestRefund(manager, { paymentId: other.payment.id, amount: '100.00', reason: 'Overcharged' }).expect(201)).body;
      await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'Cash voucher 42' }).expect(200);
      expect(await statusOf(other.request.id)).toBe('PARTIALLY_REFUNDED');
      await t.as(accountant).post('/credit-notes', { invoiceId: other.invoice.id, amount: '100.00', reason: 'Charge reduced to match the refund' }).expect(201);
      expect((await invoiceRow(other.invoice.id)).status).toBe('PAID');
      expect(await statusOf(other.request.id)).toBe('PARTIALLY_REFUNDED');
    });

    it('a completed request keeps a correct payment status too, and other tenants see none of it', async () => {
      const request = await createRequest(t, alpha, { customerId: customer.customerId!, serviceId, status: 'COMPLETED' });
      const invoice = await issueInvoice(t, accountant, customer.customerId!, { requestId: request.id });
      await pay(invoice.id, '300.00');
      expect(await statusOf(request.id)).toBe('PARTIALLY_PAID');
      await t.as(accountant).post('/credit-notes', { invoiceId: invoice.id, amount: '5.00', reason: 'Rounding waived' }).expect(201);
      expect(await statusOf(request.id)).toBe('PAID');
      expect((await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('COMPLETED');
      await t.as(beta.owner).post('/credit-notes', { invoiceId: invoice.id, amount: '1.00', reason: 'cross tenant' }).expect(404);
      await t.as(beta.owner).post(`/invoices/${invoice.id}/void`, { reason: 'cross tenant' }).expect(404);
      expect(await t.sys.outboxEvent.count({ where: { tenantId: beta.id, type: { in: ['invoice.voided', 'creditnote.issued'] } } })).toBe(0);
    });
  });

  describe('expenses and pass-through liabilities', () => {
    it('records, edits, lists and soft-deletes ordinary expenses', async () => {
      const created = await t
        .as(accountant)
        .post('/expenses', { branchId: alpha.headOfficeId, category: 'RENT', description: 'Shop rent June', amount: '4500.00', paidOn: '2026-06-01', payee: 'Al Futtaim Properties', reference: 'CHQ 000431', method: 'CHEQUE' })
        .expect(201);
      expect(created.body).toMatchObject({ category: 'RENT', amount: '4500.00', currency: 'AED', recordedById: accountant.userId, liabilitySettled: false });
      const updated = await t.as(accountant).patch(`/expenses/${created.body.id}`, { amount: '4600.00', description: 'Shop rent June (incl. service charge)' }).expect(200);
      expect(updated.body.amount).toBe('4600.00');
      const list = await t.as(accountant).get('/expenses?category=RENT&from=2026-06-01&to=2026-06-30').expect(200);
      expect(list.body.data.map((e: any) => e.id)).toContain(created.body.id);
      expect(Number(list.body.totalAmount)).toBeGreaterThanOrEqual(4600);
      expect((await t.as(accountant).delete(`/expenses/${created.body.id}`).expect(200)).body).toMatchObject({ status: 'DELETED', remittanceReversed: false });
      await t.as(accountant).get(`/expenses/${created.body.id}`).expect(404);
      expect((await t.as(accountant).get('/expenses?category=RENT').expect(200)).body.data.map((e: any) => e.id)).not.toContain(created.body.id);
      // Soft delete: the row is still there for the auditors.
      expect((await t.sys.expense.findUniqueOrThrow({ where: { id: created.body.id } })).deletedAt).toBeTruthy();
      await t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category: 'BRIBES', description: 'nope', amount: '1.00', paidOn: '2026-06-01' }).expect(400);
      await t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category: 'OTHER', description: 'zero', amount: '0', paidOn: '2026-06-01' }).expect(400);
    });

    it('a remittance linked to a request settles the liability, never more than was collected', async () => {
      const { request } = await paidInvoice(); // government fee collected: 200.00
      const remit = (amount: string, category = 'GOVERNMENT_FEE_REMITTANCE') =>
        t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category, requestId: request.id, description: 'Paid on the authority portal', amount, paidOn: '2026-06-10', reference: 'E-DIRHAM 99812' });
      const first = await remit('150.00').expect(201);
      expect(first.body.liabilitySettled).toBe(true);
      const state = async () => (await t.as(accountant).get(`/finance/liabilities?requestId=${request.id}`).expect(200)).body;
      let s = await state();
      expect(s.components.find((c: any) => c.component === 'GOVERNMENT_FEE')).toMatchObject({ accrued: '200.00', reversed: '0.00', remitted: '150.00', outstanding: '50.00', treatment: 'PASS_THROUGH_LIABILITY' });
      expect(s.requests.data).toHaveLength(1);
      expect(s.requests.data[0]).toMatchObject({ requestId: request.id, requestNo: request.requestNo, outstanding: '50.00', governmentFee: { accrued: '200.00', remitted: '150.00', outstanding: '50.00' } });

      const over = await remit('50.01');
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('REMITTANCE_EXCEEDS_LIABILITY');
      expect(over.body.details).toMatchObject({ outstanding: '50.00', component: 'GOVERNMENT_FEE' });
      // Nothing was collected as third-party charge for this request.
      expect((await remit('1.00', 'THIRD_PARTY_PAYMENT')).body.code).toBe('REMITTANCE_EXCEEDS_LIABILITY');
      const second = await remit('50.00').expect(201);
      s = await state();
      expect(s.totalOutstanding).toBe('0.00');

      // A recorded remittance cannot be silently edited...
      const edit = await t.as(accountant).patch(`/expenses/${second.body.id}`, { amount: '40.00' });
      expect(edit.status).toBe(409);
      expect(edit.body.code).toBe('REMITTANCE_RECORDED');
      await t.as(accountant).patch(`/expenses/${second.body.id}`, { payee: 'ICP', reference: 'E-DIRHAM 99813' }).expect(200);
      // ...and deleting it puts the liability back (the ledger itself is append-only).
      expect((await t.as(accountant).delete(`/expenses/${second.body.id}`).expect(200)).body.remittanceReversed).toBe(true);
      s = await state();
      expect(s.components.find((c: any) => c.component === 'GOVERNMENT_FEE')).toMatchObject({ accrued: '200.00', remitted: '150.00', outstanding: '50.00' });
      expect(await t.sys.liabilityEntry.count({ where: { requestId: request.id } })).toBe(4); // accrual, 2 remittances, 1 compensating entry
    });

    it('two simultaneous remittances cannot both pay out the same liability', async () => {
      const { request } = await paidInvoice();
      const body = { branchId: alpha.headOfficeId, category: 'GOVERNMENT_FEE_REMITTANCE', requestId: request.id, description: 'Portal payment', amount: '200.00', paidOn: '2026-06-10' };
      const [a, b] = await Promise.all([t.as(accountant).post('/expenses', body), t.as(alpha.owner).post('/expenses', body)]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect(await t.sys.liabilityEntry.count({ where: { requestId: request.id, direction: 'REMITTANCE' } })).toBe(1);
    });

    it('a remittance without a request is an ordinary expense and does not touch the ledger', async () => {
      const before = await t.sys.liabilityEntry.count({ where: { tenantId: alpha.id } });
      const res = await t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category: 'GOVERNMENT_FEE_REMITTANCE', description: 'e-Dirham wallet top-up', amount: '5000.00', paidOn: '2026-06-02' }).expect(201);
      expect(res.body.liabilitySettled).toBe(false);
      expect(await t.sys.liabilityEntry.count({ where: { tenantId: alpha.id } })).toBe(before);
    });

    it('refunds reduce the outstanding liability; the report adds up per component', async () => {
      const { request, payment } = await paidInvoice();
      const refund = (await requestRefund(manager, { paymentId: payment.id, amount: '305.00', reason: 'Cancelled', cancelCharge: true }).expect(201)).body;
      await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'V-77' }).expect(200);
      const s = (await t.as(accountant).get(`/finance/liabilities?requestId=${request.id}`).expect(200)).body;
      expect(s.components.find((c: any) => c.component === 'GOVERNMENT_FEE')).toMatchObject({ accrued: '200.00', reversed: '200.00', remitted: '0.00', outstanding: '0.00' });
      const open = (await t.as(accountant).get('/finance/liabilities?outstandingOnly=true&pageSize=100').expect(200)).body;
      expect(open.requests.data.map((r: any) => r.requestId)).not.toContain(request.id);
      expect(open.requests.data.every((r: any) => Number(r.outstanding) !== 0)).toBe(true);
      const all = (await t.as(accountant).get('/finance/liabilities?pageSize=100').expect(200)).body;
      const sumOf = (rows: any[], f: (r: any) => string) => rows.reduce((a, r) => a + Math.round(Number(f(r)) * 100), 0);
      expect(sumOf(all.requests.data, (r) => r.governmentFee.outstanding)).toBe(Math.round(Number(all.components.find((c: any) => c.component === 'GOVERNMENT_FEE').outstanding) * 100));
      expect(all.requests.meta.total).toBe(all.requests.data.length);
      // Per branch: everything in this suite was collected at the head office.
      const headOffice = (await t.as(accountant).get(`/finance/liabilities?branchId=${alpha.headOfficeId}&pageSize=100`).expect(200)).body;
      expect(headOffice.totalOutstanding).toBe(all.totalOutstanding);
      const elsewhere = (await t.as(alpha.owner).post('/branches', { code: 'AUH', name: 'Abu Dhabi' }).expect(201)).body;
      expect((await t.as(accountant).get(`/finance/liabilities?branchId=${elsewhere.id}`).expect(200)).body).toMatchObject({ totalOutstanding: '0.00', requests: { data: [] } });
      const limited = await t.addStaff(alpha, 'accountant', { branchIds: [elsewhere.id] });
      expect((await t.as(limited).get('/finance/liabilities').expect(200)).body.totalOutstanding).toBe('0.00');
      expect((await t.as(limited).get(`/finance/liabilities?branchId=${alpha.headOfficeId}`)).status).toBe(403);
      const governmentOnly = (await t.as(accountant).get('/finance/liabilities?component=GOVERNMENT_FEE').expect(200)).body;
      expect(governmentOnly.components.map((c: any) => c.component)).toEqual(['GOVERNMENT_FEE']);
    });

    it('enforces permissions and tenant isolation', async () => {
      const { request } = await paidInvoice();
      const body = { branchId: alpha.headOfficeId, category: 'OTHER', description: 'Printer toner', amount: '120.00', paidOn: '2026-06-03' };
      await t.as(receptionist).post('/expenses', body).expect(403);
      await t.as(receptionist).get('/expenses').expect(403);
      await t.as(customer).get('/expenses').expect(403);
      await t.as(receptionist).get('/finance/liabilities').expect(403);
      await t.as(customer).get('/finance/liabilities').expect(403);
      await t.as(manager).get('/finance/liabilities').expect(200); // report.financial
      const expense = (await t.as(accountant).post('/expenses', body).expect(201)).body;
      await t.as(beta.owner).get(`/expenses/${expense.id}`).expect(404);
      await t.as(beta.owner).patch(`/expenses/${expense.id}`, { description: 'hijack' }).expect(404);
      await t.as(beta.owner).delete(`/expenses/${expense.id}`).expect(404);
      // Beta cannot book against Alpha's branch or request.
      await t.as(beta.owner).post('/expenses', body).expect(404);
      await t.as(beta.owner).post('/expenses', { ...body, branchId: beta.headOfficeId, category: 'GOVERNMENT_FEE_REMITTANCE', requestId: request.id }).expect(404);
      const betaView = (await t.as(beta.owner).get('/finance/liabilities').expect(200)).body;
      expect(betaView.totalOutstanding).toBe('0.00');
      expect(betaView.requests.data).toHaveLength(0);
      expect((await t.as(beta.owner).get('/expenses').expect(200)).body.data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- reconciliation
  describe('reconciliation', () => {
    let rec: TenantFixture;
    let cashIds: string[];
    let onlineId: string;
    const period = { periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() };

    beforeAll(async () => {
      rec = await t.createTenant({ name: 'Recon Typing' });
      await enableSandbox(t, rec);
      const c = await createCustomer(t, rec);
      cashIds = [];
      for (const amount of ['100.00', '205.00', '305.00']) {
        const inv = await issueInvoice(t, rec.owner, c.id);
        cashIds.push((await recordPayment(t, rec.owner, { method: 'CASH', amount, branchId: rec.headOfficeId, allocations: [{ invoiceId: inv.id, amount }] }).expect(201)).body.id);
      }
      const inv = await issueInvoice(t, rec.owner, c.id);
      const start = await t.as(rec.owner).post(`/invoices/${inv.id}/pay`, {}).expect(201);
      await t.http.post(`${sandboxPath(start.body.checkoutUrl)}/complete`).expect(200);
      onlineId = start.body.paymentId;
    });

    it('computes the expected amount from completed, un-reconciled payments of the method and period', async () => {
      const res = await t.as(rec.owner).post('/reconciliations', { method: 'CASH', ...period, settledAmount: '610.00', statementReference: 'Till count 10 June' }).expect(201);
      expect(res.body).toMatchObject({ status: 'OPEN', method: 'CASH', expectedAmount: '610.00', settledAmount: '610.00', feeAmount: '0.00', difference: '0.00', reconciledById: rec.owner.userId });
      expect(res.body.candidates).toMatchObject({ count: 3, total: '610.00' });
      expect(res.body.attached.count).toBe(0);

      // Attach two of the three: the statement no longer matches.
      const partial = await t.as(rec.owner).post(`/reconciliations/${res.body.id}/payments`, { paymentIds: cashIds.slice(0, 2) }).expect(200);
      expect(partial.body).toMatchObject({ status: 'DISCREPANCY', expectedAmount: '305.00', difference: '305.00' });
      expect(partial.body.attached).toMatchObject({ count: 2, total: '305.00' });
      expect(partial.body.candidates.count).toBe(1);
      const attached = await t.sys.payment.findUniqueOrThrow({ where: { id: cashIds[0] } });
      expect(attached.reconciliationId).toBe(res.body.id);
      expect(attached.reconciledAt).toBeTruthy();

      // A payment belongs to one reconciliation only; other methods do not belong at all.
      expect((await t.as(rec.owner).post(`/reconciliations/${res.body.id}/payments`, { paymentIds: [cashIds[0]] })).body.code).toBe('ALREADY_RECONCILED');
      expect((await t.as(rec.owner).post(`/reconciliations/${res.body.id}/payments`, { paymentIds: [onlineId] })).body.code).toBe('PAYMENT_METHOD_MISMATCH');

      const matched = await t.as(rec.owner).post(`/reconciliations/${res.body.id}/payments`, { paymentIds: [cashIds[2]] }).expect(200);
      expect(matched.body).toMatchObject({ status: 'MATCHED', expectedAmount: '610.00', difference: '0.00' });
      // Detach and correct the statement amount instead.
      const detached = await t.as(rec.owner).post(`/reconciliations/${res.body.id}/payments/remove`, { paymentIds: [cashIds[2]] }).expect(200);
      expect(detached.body.status).toBe('DISCREPANCY');
      expect((await t.sys.payment.findUniqueOrThrow({ where: { id: cashIds[2] } })).reconciliationId).toBeNull();
      const corrected = await t.as(rec.owner).patch(`/reconciliations/${res.body.id}`, { settledAmount: '300.00' }).expect(200);
      expect(corrected.body).toMatchObject({ status: 'DISCREPANCY', difference: '-5.00' });

      // A discrepancy needs an explanation before it can be closed; a closed record is final.
      const close = await t.as(rec.owner).post(`/reconciliations/${res.body.id}/close`, {});
      expect(close.status).toBe(422);
      expect(close.body.code).toBe('EXPLANATION_REQUIRED');
      const closed = await t.as(rec.owner).post(`/reconciliations/${res.body.id}/close`, { notes: 'AED 5 short in the till, written off by the owner' }).expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', difference: '-5.00' });
      expect((await t.as(rec.owner).patch(`/reconciliations/${res.body.id}`, { settledAmount: '305.00' })).body.code).toBe('RECONCILIATION_CLOSED');
      expect((await t.as(rec.owner).post(`/reconciliations/${res.body.id}/payments/remove`, { paymentIds: [cashIds[0]] })).body.code).toBe('RECONCILIATION_CLOSED');
      // Reconciled payments are no longer candidates for the next record.
      const next = await t.as(rec.owner).post('/reconciliations', { method: 'CASH', ...period, settledAmount: '305.00', attachAll: true }).expect(201);
      expect(next.body).toMatchObject({ status: 'MATCHED', expectedAmount: '305.00', difference: '0.00' });
      expect(next.body.attached.payments.map((p: any) => p.id)).toEqual([cashIds[2]]);
      const reconciled = await t.as(rec.owner).get('/payments?reconciled=true&pageSize=100').expect(200);
      expect(reconciled.body.data.map((p: any) => p.id).sort()).toEqual([...cashIds].sort());
    });

    it('accounts for gateway fees: settled + fees must equal the payments', async () => {
      const missingGateway = await t.as(rec.owner).post('/reconciliations', { method: 'ONLINE_GATEWAY', ...period, settledAmount: '295.00' });
      expect(missingGateway.status).toBe(400);
      const res = await t.as(rec.owner).post('/reconciliations', { method: 'ONLINE_GATEWAY', gateway: 'sandbox', ...period, settledAmount: '295.00', feeAmount: '9.00', attachAll: true }).expect(201);
      expect(res.body).toMatchObject({ status: 'DISCREPANCY', expectedAmount: '305.00', difference: '-1.00' });
      const fixed = await t.as(rec.owner).patch(`/reconciliations/${res.body.id}`, { feeAmount: '10.00' }).expect(200);
      expect(fixed.body).toMatchObject({ status: 'MATCHED', difference: '0.00' });
      await t.as(rec.owner).post(`/reconciliations/${res.body.id}/close`, {}).expect(200);
      const list = await t.as(rec.owner).get('/reconciliations?status=CLOSED').expect(200);
      expect(list.body.data).toHaveLength(2);
      const audit = await t.sys.auditLog.count({ where: { tenantId: rec.id, action: { startsWith: 'reconciliation.' } } });
      expect(audit).toBeGreaterThanOrEqual(8);
    });

    it('cannot be closed empty, and validates the period', async () => {
      const empty = await t.as(rec.owner).post('/reconciliations', { method: 'CHEQUE', ...period, settledAmount: '0' }).expect(201);
      expect(empty.body).toMatchObject({ status: 'OPEN', expectedAmount: '0.00' });
      expect((await t.as(rec.owner).post(`/reconciliations/${empty.body.id}/close`, {})).body.code).toBe('NOTHING_ATTACHED');
      await t.as(rec.owner).post('/reconciliations', { method: 'CASH', periodStart: period.periodEnd, periodEnd: period.periodStart, settledAmount: '1.00' }).expect(400);
    });

    it('enforces permissions and tenant isolation', async () => {
      const body = { method: 'CASH', ...period, settledAmount: '10.00' };
      await t.as(receptionist).post('/reconciliations', body).expect(403);
      await t.as(manager).post('/reconciliations', body).expect(403);
      await t.as(manager).get('/reconciliations').expect(403);
      await t.as(customer).get('/reconciliations').expect(403);
      const mine = (await t.as(accountant).post('/reconciliations', body).expect(201)).body;
      await t.as(rec.owner).get(`/reconciliations/${mine.id}`).expect(404);
      await t.as(rec.owner).patch(`/reconciliations/${mine.id}`, { settledAmount: '1.00' }).expect(404);
      await t.as(rec.owner).post(`/reconciliations/${mine.id}/close`, {}).expect(404);
      // Alpha cannot attach another tenant's payment to its own record.
      await t.as(accountant).post(`/reconciliations/${mine.id}/payments`, { paymentIds: [cashIds[0]] }).expect(404);
      expect((await t.as(accountant).get('/reconciliations').expect(200)).body.data.every((r: any) => r.tenantId === alpha.id)).toBe(true);
    });
  });
});

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
