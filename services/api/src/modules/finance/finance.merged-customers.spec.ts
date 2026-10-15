import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { createCustomer, enableSandbox, issueInvoice, line, recordPayment } from './fixtures';

/**
 * After a customer merge, issued invoices and completed payments stay on the
 * retired record (they are immutable). Finance lists must still find them
 * through the record that was kept.
 */
describe('Finance: lists after a customer merge', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountant: Actor;
  let receptionist: Actor;
  let kept: Actor; // portal customer: the record that survives
  let stranger: Actor;
  let retired: { id: string; customerNo: string };
  let older: { id: string; customerNo: string };
  const ids: Record<string, string> = {};

  const pay = async (invoiceId: string, amount: string) => (await recordPayment(t, receptionist, { method: 'CASH', amount, branchId: alpha.headOfficeId, allocations: [{ invoiceId, amount }] }).expect(201)).body;
  const merge = (sourceId: string, sourceNo: string, targetId: string) =>
    t.as(alpha.owner).post('/customers/merge', { targetId, sourceId, confirmSourceCustomerNo: sourceNo, reason: 'Same person registered twice' });
  const idsOf = async (actor: Actor, path: string) => ((await t.as(actor).get(path).expect(200)).body.data as Array<{ id: string }>).map((r) => r.id).sort();
  const sorted = (...names: string[]) => names.map((n) => ids[n]).sort();

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    accountant = await t.addStaff(alpha, 'accountant');
    receptionist = await t.addStaff(alpha, 'receptionist');
    kept = await t.addCustomer(alpha, { fullName: 'Aisha Khan' });
    stranger = await t.addCustomer(alpha, { fullName: 'Omar Said' });
    retired = await createCustomer(t, alpha, { fullName: 'Aisha Khan' });
    older = await createCustomer(t, alpha, { fullName: 'Aisha  Khan' });
    await enableSandbox(t, alpha);

    // On the oldest record: one paid invoice.
    ids.olderInvoice = (await issueInvoice(t, accountant, older.id)).id;
    ids.olderPayment = (await pay(ids.olderInvoice, '305.00')).id;
    // On the record that will be retired: a paid invoice, an open one, a draft and a quotation.
    ids.paidInvoice = (await issueInvoice(t, accountant, retired.id)).id;
    ids.retiredPayment = (await pay(ids.paidInvoice, '305.00')).id;
    ids.openInvoice = (await issueInvoice(t, accountant, retired.id, { serviceFee: '50.00', governmentFee: '0' })).id;
    ids.draftInvoice = (await t.as(accountant).post('/invoices', { customerId: retired.id, items: [line('SERVICE_FEE', '10.00')] }).expect(201)).body.id;
    ids.quotation = (await t.as(receptionist).post('/quotations', { customerId: retired.id, items: [line('SERVICE_FEE', '80.00')] }).expect(201)).body.id;
    // On the record that is kept, and on an unrelated customer.
    ids.keptInvoice = (await issueInvoice(t, accountant, kept.customerId!)).id;
    ids.keptPayment = (await pay(ids.keptInvoice, '100.00')).id;
    ids.strangerInvoice = (await issueInvoice(t, accountant, stranger.customerId!)).id;
    ids.strangerPayment = (await pay(ids.strangerInvoice, '305.00')).id;

    // First the oldest record into the one in the middle, then that one into the record that is kept.
    await merge(older.id, older.customerNo, retired.id).expect(200);
    const merged = await merge(retired.id, retired.customerNo, kept.customerId!).expect(200);
    expect(merged.body.retainedOnSource).toEqual({ invoices: 2, payments: 1 });
  });
  afterAll(() => t.close());

  it('the premise: issued invoices and completed payments stayed on the retired records', async () => {
    const owner = async (model: 'invoice' | 'payment', id: string) => ((await (t.sys[model] as any).findUniqueOrThrow({ where: { id } })) as { customerId: string }).customerId;
    expect(await owner('invoice', ids.paidInvoice)).toBe(retired.id);
    expect(await owner('invoice', ids.openInvoice)).toBe(retired.id);
    expect(await owner('payment', ids.retiredPayment)).toBe(retired.id);
    expect(await owner('invoice', ids.olderInvoice)).toBe(older.id);
    expect(await owner('payment', ids.olderPayment)).toBe(older.id);
    // Drafts moved; both retired records point straight at the kept one.
    expect(await owner('invoice', ids.draftInvoice)).toBe(kept.customerId);
    const rows = await t.sys.customer.findMany({ where: { id: { in: [retired.id, older.id] } }, select: { status: true, mergedIntoId: true } });
    expect(rows).toEqual([{ status: 'MERGED', mergedIntoId: kept.customerId }, { status: 'MERGED', mergedIntoId: kept.customerId }]);
  });

  it('staff: a customerId filter on the kept record finds everything, whichever record it was written under', async () => {
    const everyInvoice = sorted('olderInvoice', 'paidInvoice', 'openInvoice', 'draftInvoice', 'keptInvoice');
    expect(await idsOf(accountant, `/invoices?customerId=${kept.customerId}&pageSize=100`)).toEqual(everyInvoice);
    expect(await idsOf(accountant, `/payments?customerId=${kept.customerId}&pageSize=100`)).toEqual(sorted('olderPayment', 'retiredPayment', 'keptPayment'));
    expect(await idsOf(receptionist, `/quotations?customerId=${kept.customerId}&pageSize=100`)).toEqual([ids.quotation]);
    // A link that still carries a retired id (an old bookmark, an audit entry) shows the same customer.
    for (const old of [retired.id, older.id]) {
      expect(await idsOf(accountant, `/invoices?customerId=${old}&pageSize=100`)).toEqual(everyInvoice);
      expect(await idsOf(accountant, `/payments?customerId=${old}&pageSize=100`)).toEqual(sorted('olderPayment', 'retiredPayment', 'keptPayment'));
    }
    // The total is right as well, and other filters still narrow the result.
    const page = (await t.as(accountant).get(`/invoices?customerId=${kept.customerId}&pageSize=2`).expect(200)).body;
    expect(page.meta).toMatchObject({ total: 5, totalPages: 3 });
    expect(await idsOf(accountant, `/invoices?customerId=${kept.customerId}&status=PAID`)).toEqual(sorted('olderInvoice', 'paidInvoice'));
    expect(await idsOf(accountant, `/invoices?customerId=${kept.customerId}&status=ISSUED`)).toEqual([ids.openInvoice]);
    expect(await idsOf(accountant, `/payments?customerId=${kept.customerId}&invoiceId=${ids.paidInvoice}`)).toEqual([ids.retiredPayment]);
    // Nobody else's rows come along, and an unrelated customer is unaffected.
    expect(await idsOf(accountant, `/invoices?customerId=${stranger.customerId}`)).toEqual([ids.strangerInvoice]);
    expect(await idsOf(accountant, `/payments?customerId=${stranger.customerId}`)).toEqual([ids.strangerPayment]);
    expect(await idsOf(accountant, '/invoices?customerId=00000000-0000-4000-8000-000000000001')).toEqual([]);
  });

  it('the customer sees - and can pay - the invoices that stayed on the retired records; nobody else gains anything', async () => {
    // Own list: every issued invoice of the person, never the draft.
    expect(await idsOf(kept, '/invoices?pageSize=100')).toEqual(sorted('olderInvoice', 'paidInvoice', 'openInvoice', 'keptInvoice'));
    expect(await idsOf(kept, '/payments?pageSize=100')).toEqual(sorted('olderPayment', 'retiredPayment', 'keptPayment'));
    expect((await t.as(kept).get(`/invoices/${ids.openInvoice}`).expect(200)).body).toMatchObject({ status: 'ISSUED', balanceDue: '52.50' });
    await t.as(kept).get(`/payments/${ids.retiredPayment}`).expect(200);
    await t.as(kept).get(`/invoices/${ids.draftInvoice}`).expect(404);
    // The open invoice can be paid online by the person it belongs to.
    const start = await t.as(kept).post(`/invoices/${ids.openInvoice}/pay`, {}).expect(201);
    expect(start.body.checkoutUrl).toContain('/public/payments/sandbox/checkout/');
    await t.http.post(`${new URL(start.body.checkoutUrl).pathname}/complete`).expect(200);
    await t.settle();
    expect((await t.sys.invoice.findUniqueOrThrow({ where: { id: ids.openInvoice } })).status).toBe('PAID');

    // A filter cannot widen the scope: somebody else's id gives nothing, in either direction.
    expect(await idsOf(kept, `/invoices?customerId=${stranger.customerId}`)).toEqual([]);
    expect(await idsOf(stranger, '/invoices?pageSize=100')).toEqual([ids.strangerInvoice]);
    for (const id of [kept.customerId, retired.id, older.id]) {
      expect(await idsOf(stranger, `/invoices?customerId=${id}`)).toEqual([]);
      expect(await idsOf(stranger, `/payments?customerId=${id}`)).toEqual([]);
    }
    await t.as(stranger).get(`/invoices/${ids.paidInvoice}`).expect(404);
    await t.as(stranger).get(`/invoices/${ids.olderInvoice}`).expect(404);
    await t.as(stranger).get(`/payments/${ids.retiredPayment}`).expect(404);
    await t.as(stranger).post(`/invoices/${ids.openInvoice}/pay`, {}).expect(404);
    // Another centre sees nothing through any of the ids.
    for (const id of [kept.customerId, retired.id]) {
      expect(await idsOf(beta.owner, `/invoices?customerId=${id}`)).toEqual([]);
      expect(await idsOf(beta.owner, `/payments?customerId=${id}`)).toEqual([]);
      expect(await idsOf(beta.owner, `/quotations?customerId=${id}`)).toEqual([]);
    }
  });

  it('a record that merely points at another one without being MERGED is not treated as the same customer', async () => {
    // Data that claims a merge but was never completed must not open another customer's invoices.
    const impostor = await createCustomer(t, alpha, { fullName: 'Not Merged' });
    const invoice = await issueInvoice(t, accountant, impostor.id);
    await t.sys.customer.update({ where: { id: impostor.id }, data: { mergedIntoId: kept.customerId } }); // status stays ACTIVE
    expect(await idsOf(kept, '/invoices?pageSize=100')).not.toContain(invoice.id);
    expect(await idsOf(accountant, `/invoices?customerId=${kept.customerId}&pageSize=100`)).not.toContain(invoice.id);
    expect(await idsOf(accountant, `/invoices?customerId=${impostor.id}`)).toEqual([invoice.id]);
    await t.as(kept).get(`/invoices/${invoice.id}`).expect(404);
  });
});
