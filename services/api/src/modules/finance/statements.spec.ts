import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { createCorporate, issueInvoice, key, listen, recordPayment } from './fixtures';

describe('Finance: customer statement of account', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let customer: Actor;
  let other: Actor;
  let accountant: Actor;
  let operator: Actor;

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    customer = await t.addCustomer(alpha, { fullName: 'Aisha Khan' });
    other = await t.addCustomer(alpha, { fullName: 'Omar Said' });
    accountant = await t.addStaff(alpha, 'accountant');
    operator = await t.addStaff(alpha, 'operator');
    const id = customer.customerId!;
    // 305.00 invoice paid in full, 105.00 invoice open, 42.00 invoice voided, 55.00 credit on the open one.
    const paid = await issueInvoice(t, alpha.owner, id);
    await recordPayment(t, alpha.owner, { method: 'CASH', amount: paid.total, branchId: alpha.headOfficeId, allocations: [{ invoiceId: paid.id, amount: paid.total }] }, key()).expect(201);
    const open = await issueInvoice(t, alpha.owner, id, { governmentFee: '0' });
    const voided = await issueInvoice(t, alpha.owner, id, { serviceFee: '40.00', governmentFee: '0' });
    await t.as(alpha.owner).post(`/invoices/${voided.id}/void`, { reason: 'Issued twice' }).expect(200);
    await t.as(accountant).post('/credit-notes', { invoiceId: open.id, amount: '55.00', reason: 'Discount agreed' }).expect(201);
    // A company-billed invoice of the same person belongs to the company's statement.
    const company = await createCorporate(t, alpha, { creditApproved: true, creditLimit: '5000.00' });
    await issueInvoice(t, alpha.owner, id, { corporateAccountId: company.id });
    // Another customer's invoice never shows.
    await issueInvoice(t, alpha.owner, other.customerId!);
  });
  afterAll(() => t.close());

  it('lists every movement with a running balance and the ageing of what is open', async () => {
    const st = (await t.as(accountant).get(`/customers/${customer.customerId}/statement`).expect(200)).body;
    expect(st.customer).toMatchObject({ fullName: 'Aisha Khan' });
    expect(st.lines.map((l: { type: string; debit: string; credit: string }) => [l.type, l.debit, l.credit])).toEqual([
      ['INVOICE', '305.00', '0.00'],
      ['PAYMENT', '0.00', '305.00'],
      ['INVOICE', '105.00', '0.00'],
      ['INVOICE', '42.00', '0.00'],
      ['INVOICE_VOID', '0.00', '42.00'],
      ['CREDIT_NOTE', '0.00', '55.00'],
    ]);
    expect(st).toMatchObject({ openingBalance: '0.00', charged: '452.00', received: '402.00', closingBalance: '50.00' });
    expect(st.lines.at(-1).balance).toBe('50.00');
    // What is still owed equals the open invoices.
    expect(st.openInvoices.map((i: { balanceDue: string }) => i.balanceDue)).toEqual(['50.00']);
    expect(st.ageing.current).toBe('50.00');
  });

  it('carries earlier movements into the opening balance', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const later = (await t.as(accountant).get(`/customers/${customer.customerId}/statement`).query({ from: tomorrow, to: tomorrow }).expect(200)).body;
    expect(later).toMatchObject({ openingBalance: '50.00', charged: '0.00', received: '0.00', closingBalance: '50.00', lines: [] });
    await t.as(accountant).get(`/customers/${customer.customerId}/statement`).query({ from: '2026-12-01', to: '2026-01-01' }).expect(422);
  });

  it('customers see their own statement only; staff need finance access; centres are separate', async () => {
    const own = (await t.as(customer).get('/statement').expect(200)).body;
    expect(own.closingBalance).toBe('50.00');
    expect((await t.as(other).get('/statement').expect(200)).body.customer.fullName).toBe('Omar Said');
    await t.as(customer).get(`/customers/${other.customerId}/statement`).expect(403);
    await t.as(operator).get(`/customers/${customer.customerId}/statement`).expect(403);
    await t.as(beta.owner).get(`/customers/${customer.customerId}/statement`).expect(404);
  });

  it('prints a PDF', async () => {
    const pdf = await t.as(accountant).get(`/customers/${customer.customerId}/statement/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    await t.as(customer).get('/statement/pdf').expect(200);
  });
});
