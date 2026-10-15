import {
  Actor,
  aed,
  api,
  Books,
  Centre,
  Company,
  createCompany,
  createService,
  CreatedService,
  Crew,
  dubaiDay,
  enableSandboxGateway,
  expectRefused,
  fils,
  finishCheckout,
  idempotencyKey,
  inviteStaff,
  onePercent,
  printCash,
  printRevenue,
  registerPortalCustomer,
  registerWalkInCustomer,
  runCase,
  signUpCentre,
  startCheckout,
  sum,
  TestApp,
  uniq,
} from '../support';

/**
 * Scenario 30: reports match the underlying financial records.
 *
 * A centre with two branches, two services and a corporate customer does a
 * day's business through the API: a request from counter to completion, direct
 * invoices (one with a discount, one in a quantity that rounds), part payments,
 * a payment that was received yesterday, a refund that cancels the charge and
 * one that does not, a credit note, a voided invoice, a draft, an abandoned and
 * a declined online payment, a pending refund, expenses and a remittance.
 *
 * The test keeps its OWN books (tests/support/books.ts: integer fils, the
 * documented rules, no code of the API) and every financial figure the API
 * reports - eight financial reports, their drill-downs, the money columns of the
 * branch report, the dashboard, the liability ledger, the corporate statement,
 * the cash reconciliation and a CSV export - must equal what those books say.
 */
describe('Reports match the underlying financial records (scenario 30)', () => {
  let t: TestApp;
  let centre: Centre;
  let crew: Crew;
  let accountant: Actor;
  let visa: CreatedService; // service A: service fee + government fee + third-party fee
  let translation: CreatedService; // service B: service fee only
  let secondBranchId: string;
  let company: Company;
  const books = new Books();
  const id = uniq();
  const TODAY = dubaiDay(0);
  const YESTERDAY = dubaiDay(-1);
  const DAYS = [YESTERDAY, TODAY];
  const RANGE = `from=${YESTERDAY}&to=${TODAY}`;
  const TAX = 5;

  const ids: Record<string, string> = {};
  let caseRequestId: string;
  let caseRequestNo: string;

  const report = (key: string, query = RANGE) => api(t, accountant).get(`/reports/${key}${query ? `?${query}` : ''}`);
  const rowOf = (rows: any[], field: string, value: unknown) => rows.find((r) => r[field] === value);

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Ledger Typing ${id}` });
    const owner = api(t, centre.owner);
    await owner.patch('/tenant', { taxRatePercent: TAX });
    await enableSandboxGateway(t, centre.owner);
    secondBranchId = (await owner.post('/branches', { code: 'B2', name: 'Second Branch' }, 201)).id;
    visa = await createService(t, centre.owner, { name: 'Visa application typing', categoryKey: 'visa', price: { serviceFee: '200.00', governmentFeeEstimate: '350.00', thirdPartyFeeEstimate: '30.00' }, requirements: [{ documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true }] });
    translation = await createService(t, centre.owner, { name: 'Legal translation', price: { serviceFee: '100.00' } });
    crew = { owner: centre.owner, receptionist: await inviteStaff(t, centre, 'receptionist'), reviewer: await inviteStaff(t, centre, 'reviewer'), operator: await inviteStaff(t, centre, 'operator') };
    accountant = await inviteStaff(t, centre, 'accountant');
    company = await createCompany(t, centre, { companyName: `Falcon Trading ${id} LLC`, credit: { limit: '5000.00', termsDays: 30 } });
    const acc = api(t, accountant);
    const HO = centre.headOfficeId;

    const c1 = await registerWalkInCustomer(t, crew.receptionist, { fullName: `Aisha Khan ${id}` });
    const c2 = await registerWalkInCustomer(t, crew.receptionist, { fullName: `Bilal Saeed ${id}` });
    const c3 = await registerPortalCustomer(t, centre, { fullName: `Chitra Nair ${id}` });
    const ck = await owner.post('/customers', { type: 'BUSINESS', fullName: company.companyName, corporateAccountId: company.id, confirmNotDuplicate: true }, 201);
    Object.assign(ids, { c1: c1.id, c2: c2.id, c3: c3.customerId!, ck: ck.id });
    const pay = (invoiceKey: string, key: string, body: Record<string, unknown>) =>
      api(t, crew.receptionist).with({ 'Idempotency-Key': idempotencyKey() }).post('/payments', { ...body, allocations: [{ invoiceId: ids[invoiceKey], amount: body.amount }] }, 201).then((p: any) => (ids[key] = p.id));
    const refund = async (key: string, paymentKey: string, invoiceKey: string, body: Record<string, unknown>) => {
      const requested = await acc.with({ 'Idempotency-Key': idempotencyKey() }).post('/refunds', { paymentId: ids[paymentKey], invoiceId: ids[invoiceKey], ...body }, 201);
      const approved = await owner.post(`/refunds/${requested.id}/approve`, { reference: `Returned at the counter (${key})` });
      if (approved.status !== 'COMPLETED') throw new Error(`refund ${key} ended as ${approved.status}`);
      ids[key] = requested.id;
    };

    // --- I1: a request of the visa service from counter to completion, paid in cash at the head office
    const done = await runCase(t, crew, { serviceId: visa.id, branchId: HO, customerId: c1.id });
    caseRequestId = done.requestId;
    caseRequestNo = done.requestNo;
    Object.assign(ids, { I1: done.invoiceId!, P1: done.paymentId! });
    books.invoice({ key: 'I1', id: done.invoiceId!, day: TODAY, branchId: HO, customerId: c1.id, corporateAccountId: null, serviceId: visa.id, lines: [{ component: 'SERVICE_FEE', unitAmount: '200.00', taxRatePercent: TAX }, { component: 'GOVERNMENT_FEE', unitAmount: '350.00' }, { component: 'THIRD_PARTY_FEE', unitAmount: '30.00' }] });
    books.payment({ key: 'P1', id: done.paymentId!, invoiceKey: 'I1', amount: aed(books.total('I1')), method: 'CASH', branchId: HO, day: TODAY });

    // --- I2: translation with a discount, at the second branch; drafted by the accountant, the discount approved by the owner; part paid by card
    const d2 = await acc.post('/invoices', { customerId: c2.id, branchId: secondBranchId, items: [{ description: 'Legal translation', component: 'SERVICE_FEE', quantity: 1, unitAmount: '100.00', discountAmount: '20.00', taxRatePercent: TAX, serviceId: translation.id }, { description: 'Attestation fee', component: 'GOVERNMENT_FEE', quantity: 1, unitAmount: '200.00', serviceId: translation.id }] }, 201);
    ids.I2 = d2.id;
    expectRefused(await acc.req('POST', `/invoices/${d2.id}/issue`), 403); // segregation of duties: the author of a discount cannot issue it
    await owner.post(`/invoices/${d2.id}/issue`);
    books.invoice({ key: 'I2', id: d2.id, day: TODAY, branchId: secondBranchId, customerId: c2.id, corporateAccountId: null, serviceId: translation.id, lines: [{ component: 'SERVICE_FEE', unitAmount: '100.00', discountAmount: '20.00', taxRatePercent: TAX }, { component: 'GOVERNMENT_FEE', unitAmount: '200.00' }] });
    await pay('I2', 'P2', { method: 'CARD_POS', amount: '100.00', reference: 'POS slip 000777', branchId: secondBranchId, customerId: c2.id });
    books.payment({ key: 'P2', id: ids.P2, invoiceKey: 'I2', amount: '100.00', method: 'CARD_POS', branchId: secondBranchId, day: TODAY });

    // --- I3: a free-form invoice whose quantity makes the tax round (3 x 333.33); unpaid; then a credit note on it
    const d3 = await acc.post('/invoices', { customerId: c3.customerId, branchId: HO, items: [{ description: 'Document set', component: 'SERVICE_FEE', quantity: 3, unitAmount: '333.33', taxRatePercent: TAX }] }, 201);
    ids.I3 = d3.id;
    await acc.post(`/invoices/${d3.id}/issue`);
    books.invoice({ key: 'I3', id: d3.id, day: TODAY, branchId: HO, customerId: c3.customerId!, corporateAccountId: null, serviceId: null, lines: [{ component: 'SERVICE_FEE', unitAmount: '333.33', quantity: 3, taxRatePercent: TAX }] });
    await acc.post('/credit-notes', { invoiceId: d3.id, amount: '49.99', reason: 'Price correction', breakdown: { SERVICE_FEE: '49.99' } }, 201);
    books.credit({ invoiceKey: 'I3', day: TODAY, parts: { SERVICE_FEE: '49.99' } });
    // Online attempts on it that never became money: one abandoned, one declined.
    await startCheckout(t, c3, d3.id, '500.00');
    await finishCheckout(t, await startCheckout(t, c3, d3.id, '500.00'), 'fail');

    // --- I4: the corporate customer, on account; part paid by a bank transfer that was received yesterday
    const d4 = await acc.post('/invoices', { customerId: ck.id, corporateAccountId: company.id, branchId: HO, items: [{ description: 'Visa typing for employees', component: 'SERVICE_FEE', quantity: 1, unitAmount: '500.00', taxRatePercent: TAX, serviceId: visa.id }, { description: 'Government fees', component: 'GOVERNMENT_FEE', quantity: 1, unitAmount: '1000.00', serviceId: visa.id }] }, 201);
    ids.I4 = d4.id;
    await acc.post(`/invoices/${d4.id}/issue`);
    books.invoice({ key: 'I4', id: d4.id, day: TODAY, branchId: HO, customerId: ck.id, corporateAccountId: company.id, serviceId: visa.id, lines: [{ component: 'SERVICE_FEE', unitAmount: '500.00', taxRatePercent: TAX }, { component: 'GOVERNMENT_FEE', unitAmount: '1000.00' }] });
    await pay('I4', 'P4', { method: 'BANK_TRANSFER', amount: '525.00', reference: 'Transfer ref 4401', branchId: HO, customerId: ck.id, receivedAt: `${YESTERDAY}T08:00:00.000Z` });
    books.payment({ key: 'P4', id: ids.P4, invoiceKey: 'I4', amount: '525.00', method: 'BANK_TRANSFER', branchId: HO, day: YESTERDAY });

    // --- I5: issued by mistake and voided; I6: a draft that is never issued. Neither may appear anywhere.
    const d5 = await acc.post('/invoices', { customerId: c2.id, branchId: HO, items: [{ description: 'Raised by mistake', component: 'SERVICE_FEE', quantity: 1, unitAmount: '80.00', taxRatePercent: TAX }] }, 201);
    await acc.post(`/invoices/${d5.id}/issue`);
    await acc.post(`/invoices/${d5.id}/void`, { reason: 'Raised for the wrong customer' }, [200, 201]);
    ids.I5 = d5.id;
    ids.I6 = (await acc.post('/invoices', { customerId: c3.customerId, branchId: HO, items: [{ description: 'Still being prepared', component: 'SERVICE_FEE', quantity: 1, unitAmount: '777.00', taxRatePercent: TAX }] }, 201)).id;

    // --- I7: translation at the second branch, paid in cash, then partly refunded WITHOUT cancelling the charge (the amount is due again)
    const d7 = await acc.post('/invoices', { customerId: c3.customerId, branchId: secondBranchId, items: [{ description: 'Legal translation, 4 pages', component: 'SERVICE_FEE', quantity: 1, unitAmount: '400.00', taxRatePercent: TAX, serviceId: translation.id }] }, 201);
    ids.I7 = d7.id;
    await acc.post(`/invoices/${d7.id}/issue`);
    books.invoice({ key: 'I7', id: d7.id, day: TODAY, branchId: secondBranchId, customerId: c3.customerId!, corporateAccountId: null, serviceId: translation.id, lines: [{ component: 'SERVICE_FEE', unitAmount: '400.00', taxRatePercent: TAX }] });
    await pay('I7', 'P7', { method: 'CASH', amount: '420.00', branchId: secondBranchId, customerId: c3.customerId });
    books.payment({ key: 'P7', id: ids.P7, invoiceKey: 'I7', amount: '420.00', method: 'CASH', branchId: secondBranchId, day: TODAY });
    await refund('R7', 'P7', 'I7', { amount: '120.00', reason: 'Paid twice by mistake', cancelCharge: false, breakdown: { SERVICE_FEE: '120.00' } });
    books.refund({ key: 'R7', invoiceKey: 'I7', paymentKey: 'P7', amount: '120.00', cancelCharge: false, day: TODAY });

    // --- R1: part of the visa case is refunded and the charge cancelled (a credit note comes with it): 105.00 service fee incl. tax, 50.00 government fee
    await refund('R1', 'P1', 'I1', { amount: '155.00', reason: 'One dependant withdrawn', cancelCharge: true, breakdown: { SERVICE_FEE: '105.00', GOVERNMENT_FEE: '50.00' } });
    books.refund({ key: 'R1', invoiceKey: 'I1', paymentKey: 'P1', amount: '155.00', governmentFee: '50.00', cancelCharge: true, day: TODAY });
    // A refund that was asked for but not approved is not money out yet.
    await acc.with({ 'Idempotency-Key': idempotencyKey() }).post('/refunds', { paymentId: ids.P2, invoiceId: ids.I2, amount: '10.00', reason: 'Waiting for approval' }, 201);

    // --- expenses: rent (overhead), courier for the visa case (a cost of that service), the government fee paid out for it (not a cost), a bill paid yesterday
    await acc.post('/expenses', { branchId: HO, category: 'RENT', description: 'Office rent', amount: '1000.00', paidOn: TODAY }, 201);
    books.expense({ amount: '1000.00', category: 'RENT', day: TODAY });
    await acc.post('/expenses', { branchId: HO, category: 'SUPPLIES', requestId: caseRequestId, description: 'Courier for the visa file', amount: '40.00', paidOn: TODAY }, 201);
    books.expense({ amount: '40.00', category: 'SUPPLIES', serviceId: visa.id, day: TODAY });
    await acc.post('/expenses', { branchId: HO, category: 'GOVERNMENT_FEE_REMITTANCE', requestId: caseRequestId, description: 'Government fee paid on behalf of the customer', amount: '250.00', paidOn: TODAY, payee: 'Sample authority (fictional)' }, 201);
    books.expense({ amount: '250.00', category: 'GOVERNMENT_FEE_REMITTANCE', serviceId: visa.id, day: TODAY });
    await acc.post('/expenses', { branchId: HO, category: 'UTILITIES', description: 'Electricity', amount: '60.00', paidOn: YESTERDAY }, 201);
    books.expense({ amount: '60.00', category: 'UTILITIES', day: YESTERDAY });
    await t.settle();
  });
  afterAll(() => t.close());

  it('S30 the records themselves agree with the books: every invoice total, balance and status', async () => {
    const acc = api(t, accountant);
    const expectedStatus: Record<string, string> = { I1: 'PAID', I2: 'PARTIALLY_PAID', I3: 'ISSUED', I4: 'PARTIALLY_PAID', I7: 'PARTIALLY_PAID' };
    for (const key of ['I1', 'I2', 'I3', 'I4', 'I7']) {
      const invoice = await acc.get(`/invoices/${ids[key]}`);
      expect([key, invoice.total, invoice.taxTotal, invoice.amountPaid, invoice.amountRefunded, invoice.amountCredited, invoice.balanceDue, invoice.status]).toEqual([
        key, aed(books.total(key)), aed(books.taxOf(key)), aed(books.paid(key)), aed(books.refunded(key)), aed(books.credited(key)), aed(books.balance(key)), expectedStatus[key],
      ]);
    }
    // The interesting amounts, spelled out once so that a reader can check the books by hand.
    expect(aed(books.total('I1'))).toBe('590.00'); // 200 + 5% + 350 + 30
    expect(aed(books.total('I2'))).toBe('284.00'); // (100 - 20) + 5% + 200
    expect(aed(books.total('I3'))).toBe('1049.99'); // 3 x 333.33 = 999.99, tax 49.9995 -> 50.00
    expect(aed(books.balance('I3'))).toBe('1000.00'); // credit note 49.99
    expect(aed(books.balance('I7'))).toBe('120.00'); // paid 420, 120 refunded without cancelling the charge
    expect(aed(books.balance('I1'))).toBe('0.00'); // refund with cancelled charge: nothing becomes due again
    expect((await acc.get(`/invoices/${ids.I5}`)).status).toBe('VOID');
    expect((await acc.get(`/invoices/${ids.I6}`)).status).toBe('DRAFT');

    // Summing the API's own lists gives the books' totals: payments, refunds, open balances.
    const payments = (await acc.get('/payments?pageSize=100')).data as any[];
    const settled = payments.filter((p) => ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));
    expect(aed(sum(settled.map((p) => fils(p.amount))))).toBe(aed(books.cash(DAYS).payments));
    expect(payments.filter((p) => p.status === 'PENDING')).toHaveLength(1); // the abandoned checkout
    expect(payments.filter((p) => p.status === 'FAILED')).toHaveLength(1); // the declined one
    const refunds = (await acc.get('/refunds?pageSize=100')).data as any[];
    expect(aed(sum(refunds.filter((r) => r.status === 'COMPLETED').map((r) => fils(r.amount))))).toBe(aed(books.cash(DAYS).refunds));
    expect(refunds.filter((r) => r.status === 'REQUESTED')).toHaveLength(1);
    const invoices = (await acc.get('/invoices?pageSize=100')).data as any[];
    const open = invoices.filter((i) => ['ISSUED', 'PARTIALLY_PAID'].includes(i.status));
    expect(aed(sum(open.map((i) => fils(i.balanceDue))))).toBe(aed(books.outstanding()));
  });

  it('S30 daily sales: revenue (accrual) and collections (cash), day by day', async () => {
    const r = await report('daily-sales');
    expect(r.period).toEqual({ from: YESTERDAY, to: TODAY });
    expect(r.currency).toBe('AED');
    expect(r.rows.map((x: any) => x.date)).toEqual(DAYS);
    for (const day of DAYS) {
      const expected = { date: day, ...printRevenue(books.revenue([day]).get('all') ?? books.revenueTotal([])), ...printCash(books.cash([day])) };
      expect(rowOf(r.rows, 'date', day)).toEqual(expected);
    }
    expect(r.totals).toEqual({ date: 'Total', ...printRevenue(books.revenueTotal(DAYS)), ...printCash(books.cash(DAYS)) });
    // Spelled out: five invoices; the bank transfer counts on the day it was received; refunds on the day they were paid out.
    expect(r.totals.invoices).toBe(5);
    expect(rowOf(r.rows, 'date', YESTERDAY)).toMatchObject({ invoices: 0, payments: '525.00', refunds: '0.00', totalInvoiced: '0.00' });
    expect(rowOf(r.rows, 'date', TODAY)).toMatchObject({ payments: '1110.00', refunds: '275.00', grossCollections: '835.00' });
    // Revenue is not cash, and neither contains the other's figures.
    expect(r.totals.serviceFeeRevenue).not.toBe(r.totals.grossCollections);
    // The identity of the row: everything invoiced = revenue + pass-through + tax.
    const tt = r.totals;
    expect(aed(fils(tt.serviceFeeRevenue) + fils(tt.otherRevenue) + fils(tt.passThroughInvoiced) + fils(tt.tax))).toBe(tt.totalInvoiced);

    // Drill-down: the documents behind today's figures add up to today's row; the void and the draft are not among them.
    const drill = await api(t, accountant).get(`/reports/daily-sales/drilldown?${RANGE}&date=${TODAY}&pageSize=200`);
    const docs = drill.rows as any[];
    expect(drill.meta.total).toBe(docs.length);
    const ofType = (...types: string[]) => docs.filter((d) => types.includes(d.resourceType));
    expect(ofType('Invoice').map((d) => d.id).sort()).toEqual([ids.I1, ids.I2, ids.I3, ids.I4, ids.I7].sort());
    expect(docs.map((d) => d.id)).not.toContain(ids.I5);
    expect(docs.map((d) => d.id)).not.toContain(ids.I6);
    const todayRow = rowOf(r.rows, 'date', TODAY);
    expect(aed(sum(ofType('Invoice', 'CreditNote').map((d) => fils(d.amount))))).toBe(todayRow.totalInvoiced); // credit notes are negative rows
    expect(aed(sum(ofType('Payment', 'Refund').map((d) => fils(d.amount))))).toBe(todayRow.grossCollections); // refunds are negative rows
    expect(aed(sum(ofType('Invoice').map((d) => fils(d.serviceFee))))).toBe(aed(books.revenueTotal([TODAY]).serviceFeeInvoiced));
    expect(ofType('Payment').map((d) => d.id).sort()).toEqual([ids.P1, ids.P2, ids.P7].sort()); // not the pending or the declined attempt, not yesterday's transfer
    // A single day and a single branch are consistent with the whole.
    const todayOnly = await report('daily-sales', `from=${TODAY}&to=${TODAY}`);
    expect(todayOnly.totals).toEqual({ ...rowOf(r.rows, 'date', TODAY), date: 'Total' });
    const b2 = await report('daily-sales', `${RANGE}&branchId=${secondBranchId}`);
    expect(b2.totals).toMatchObject({ ...printRevenue(books.revenue(DAYS, (i) => i.branchId).get(secondBranchId)!), ...printCash(books.cash(DAYS, secondBranchId)) });
  });

  it('S30 monthly service revenue', async () => {
    const r = await report('monthly-service-revenue');
    const months = [...new Set(DAYS.map((d) => d.slice(0, 7)))];
    expect(r.rows.map((x: any) => x.month)).toEqual(months);
    for (const month of months) {
      const days = DAYS.filter((d) => d.startsWith(month));
      const rev = books.revenue(days).get('all') ?? books.revenueTotal([]);
      expect(rowOf(r.rows, 'month', month)).toEqual({ month, invoices: rev.invoices, serviceFeeInvoiced: aed(rev.serviceFeeInvoiced), serviceFeeCredited: aed(rev.serviceFeeCredited), serviceFeeRevenue: aed(rev.serviceFeeRevenue), otherRevenue: '0.00', tax: aed(rev.tax), grossCollections: aed(books.cash(days).grossCollections) });
    }
    const all = books.revenueTotal(DAYS);
    expect(r.totals).toEqual({ month: 'Total', invoices: 5, serviceFeeInvoiced: aed(all.serviceFeeInvoiced), serviceFeeCredited: aed(all.serviceFeeCredited), serviceFeeRevenue: aed(all.serviceFeeRevenue), otherRevenue: '0.00', tax: aed(all.tax), grossCollections: aed(books.cash(DAYS).grossCollections) });
    // Spelled out: 2179.99 invoiced; credited 100.00 (105.00 x 200/210) + 47.61 (49.99 x 999.99/1049.99).
    expect(r.totals.serviceFeeInvoiced).toBe('2179.99');
    expect(r.totals.serviceFeeCredited).toBe('147.61');
    expect(r.totals.serviceFeeRevenue).toBe('2032.38');
    // The same figure as in the daily report.
    expect(r.totals.serviceFeeRevenue).toBe((await report('daily-sales')).totals.serviceFeeRevenue);
  });

  it('S30 transactions by service', async () => {
    const r = await report('transactions-by-service');
    const byService = books.revenue(DAYS, (i) => i.serviceId);
    expect(r.rows).toHaveLength(3);
    expect(rowOf(r.rows, 'serviceId', visa.id)).toMatchObject({ service: 'Visa application typing', requestsSubmitted: 1, requestsCompleted: 1, ...printRevenue(byService.get(visa.id)!) });
    expect(rowOf(r.rows, 'serviceId', translation.id)).toMatchObject({ service: 'Legal translation', requestsSubmitted: 0, requestsCompleted: 0, ...printRevenue(byService.get(translation.id)!) });
    expect(rowOf(r.rows, 'serviceId', null)).toMatchObject({ requestsSubmitted: 0, ...printRevenue(byService.get(null)!) });
    expect(r.totals).toMatchObject({ requestsSubmitted: 1, requestsCompleted: 1, ...printRevenue(books.revenueTotal(DAYS)) });
    // Spelled out for the visa service: 200 + 500 invoiced, 100 credited; pass-through 350 + 30 + 1000 - 50.
    expect(rowOf(r.rows, 'serviceId', visa.id)).toMatchObject({ invoices: 2, serviceFeeRevenue: '600.00', passThroughInvoiced: '1330.00', tax: '30.00', totalInvoiced: '1960.00' });
    const drill = await api(t, accountant).get(`/reports/transactions-by-service/drilldown?${RANGE}&serviceId=${visa.id}&pageSize=200`);
    expect(aed(sum((drill.rows as any[]).map((d) => fils(d.serviceFee))))).toBe('600.00');
    expect(aed(sum((drill.rows as any[]).map((d) => fils(d.tax))))).toBe('30.00');
  });

  it('S30 outstanding payments', async () => {
    const r = await report('outstanding-payments', '');
    const perCustomer = (customerId: string) => ({ invoices: books.open((i) => i.customerId === customerId).length, total: aed(books.outstanding((i) => i.customerId === customerId)) });
    expect(r.rows).toHaveLength(3);
    for (const key of ['c2', 'c3', 'ck']) {
      const expected = perCustomer(ids[key]);
      // Nothing is overdue: every open balance is "not yet due".
      expect(rowOf(r.rows, 'customerId', ids[key])).toMatchObject({ ...expected, current: expected.total, days1to30: '0.00', days31to60: '0.00', days61to90: '0.00', days90plus: '0.00' });
    }
    expect(rowOf(r.rows, 'customerId', ids.c1)).toBeUndefined(); // fully settled
    expect(rowOf(r.rows, 'customerId', ids.ck).company).toBe(company.companyName);
    expect(r.totals).toMatchObject({ invoices: 4, total: aed(books.outstanding()), current: aed(books.outstanding()) });
    expect(r.totals.total).toBe('2304.00'); // 184.00 + 1000.00 + 1000.00 + 120.00
    const drill = await api(t, accountant).get(`/reports/outstanding-payments/drilldown?customerId=${ids.c3}&pageSize=200`);
    expect((drill.rows as any[]).map((d) => [d.id, d.balanceDue]).sort()).toEqual([[ids.I3, '1000.00'], [ids.I7, '120.00']].sort());
    // By branch.
    expect((await report('outstanding-payments', `branchId=${secondBranchId}`)).totals.total).toBe(aed(books.outstanding((i) => i.branchId === secondBranchId)));
  });

  it('S30 refunds', async () => {
    const r = await report('refunds');
    expect(r.rows).toHaveLength(2); // the pending refund is not money out
    for (const refund of books.refunds) {
      expect(rowOf(r.rows, 'refundId', ids[refund.key])).toMatchObject({
        date: refund.day, amount: aed(refund.amount), serviceFee: aed(refund.parts.SERVICE_FEE), governmentFee: aed(refund.parts.GOVERNMENT_FEE), thirdParty: aed(refund.parts.THIRD_PARTY_FEE),
        chargeCancelled: refund.cancelCharge ? 'Yes' : 'No', paymentId: ids[refund.paymentKey], invoiceId: ids[refund.invoiceKey],
      });
    }
    expect(r.totals).toMatchObject({ amount: '275.00', serviceFee: '225.00', governmentFee: '50.00', thirdParty: '0.00' });
    expect(r.totals.amount).toBe(aed(books.cash(DAYS).refunds));
    expect(r.totals.amount).toBe((await report('daily-sales')).totals.refunds);
    expect(JSON.stringify(r.notes)).toContain('10.00'); // the pending one is mentioned, not counted
  });

  it('S30 liabilities: money held for authorities and third parties', async () => {
    const expected = books.liabilities();
    const r = await report('liabilities');
    for (const component of ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const) {
      const e = expected[component];
      expect(rowOf(r.rows, 'component', component)).toMatchObject({ treatment: 'PASS_THROUGH_LIABILITY', opening: '0.00', accrued: aed(e.accrued), reversed: aed(e.reversed), remitted: aed(e.remitted), outstanding: aed(e.outstanding) });
    }
    // Spelled out: accrued 350.00 + 70.42 (100 x 200/284) + 344.26 (525 x 1000/1525); 50.00 refunded; 250.00 remitted.
    expect(rowOf(r.rows, 'component', 'GOVERNMENT_FEE')).toMatchObject({ accrued: '764.68', reversed: '50.00', remitted: '250.00', outstanding: '464.68' });
    expect(rowOf(r.rows, 'component', 'THIRD_PARTY_FEE')).toMatchObject({ accrued: '30.00', reversed: '0.00', remitted: '0.00', outstanding: '30.00' });
    expect(r.totals.outstanding).toBe('494.68');
    // opening + accrued - reversed - remitted = owed at the end, for every row.
    for (const row of r.rows as any[]) expect(aed(fils(row.opening) + fils(row.accrued) - fils(row.reversed) - fils(row.remitted))).toBe(row.outstanding);
    // The finance module's own view of the ledger says the same, and so does the balance of the visa case.
    const ledger = await api(t, accountant).get('/finance/liabilities');
    expect(ledger.totalOutstanding).toBe(r.totals.outstanding);
    expect(ledger.components.find((c: any) => c.component === 'GOVERNMENT_FEE')).toMatchObject({ accrued: '764.68', reversed: '50.00', remitted: '250.00', outstanding: '464.68' });
    const visaCase = ledger.requests.data.find((x: any) => x.requestId === caseRequestId);
    expect(visaCase).toMatchObject({ requestNo: caseRequestNo, outstanding: '80.00' }); // 350 - 50 - 250 government + 30 third party
    // More cannot be remitted than is held for the case.
    expectRefused(await api(t, accountant).req('POST', '/expenses', { branchId: centre.headOfficeId, category: 'GOVERNMENT_FEE_REMITTANCE', requestId: caseRequestId, description: 'Too much', amount: '50.01', paidOn: TODAY }), 422, 'REMITTANCE_EXCEEDS_LIABILITY');
    // Pass-through money is never revenue: no revenue figure of any report contains it.
    const sales = (await report('daily-sales')).totals;
    expect(sales.otherRevenue).toBe('0.00');
    expect(fils(sales.serviceFeeRevenue) + fils(sales.passThroughInvoiced) + fils(sales.tax)).toBe(fils(sales.totalInvoiced));
  });

  it('S30 corporate revenue and the company statement', async () => {
    const r = await report('corporate-revenue');
    const rev = books.revenue(DAYS, (i) => i.corporateAccountId).get(company.id)!;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ corporateAccountId: company.id, company: company.companyName, accountNo: company.accountNo, ...printRevenue(rev), collected: aed(books.paid('I4') - books.refunded('I4')), outstanding: aed(books.balance('I4')) });
    expect(r.rows[0]).toMatchObject({ invoices: 1, serviceFeeRevenue: '500.00', passThroughInvoiced: '1000.00', tax: '25.00', totalInvoiced: '1525.00', collected: '525.00', outstanding: '1000.00' });
    expect(r.totals).toMatchObject({ collected: '525.00', outstanding: '1000.00' });
    // The payment was received yesterday: a report for today alone shows the invoice but not that money.
    expect((await report('corporate-revenue', `from=${TODAY}&to=${TODAY}`)).rows[0]).toMatchObject({ totalInvoiced: '1525.00', collected: '0.00', outstanding: '1000.00' });
    // The statement the centre sends and the one the company sees in its portal agree with the report.
    const statement = await api(t, accountant).get(`/finance/corporate-accounts/${company.id}/statement`);
    expect(statement).toMatchObject({ openBalance: '1000.00', availableCredit: '4000.00' });
    expect(statement.invoices.map((i: any) => [i.id, i.balanceDue])).toEqual([[ids.I4, '1000.00']]);
    const own = await api(t, company.admin).get('/corporate/invoices/statement');
    expect(own).toMatchObject({ openBalance: statement.openBalance, availableCredit: statement.availableCredit });
  });

  it('S30 service profitability', async () => {
    const r = await report('service-profitability');
    const revenue = books.revenue(DAYS, (i) => i.serviceId);
    expect(r.rows).toHaveLength(2); // revenue that belongs to no service has no row (the notes say so)
    for (const service of [visa, translation]) {
      const earned = revenue.get(service.id)!.serviceFeeRevenue;
      const cost = books.directExpenses(DAYS, service.id);
      const row = rowOf(r.rows, 'serviceId', service.id);
      expect(row).toMatchObject({ serviceFeeRevenue: aed(earned), otherRevenue: '0.00', directExpenses: aed(cost), margin: aed(earned - cost), passThroughRemitted: aed(books.remittances(DAYS, service.id)) });
      expect(Number(row.marginPercent)).toBe(onePercent(earned - cost, earned));
    }
    // Spelled out: the visa service earned 600.00, the courier cost 40.00; the 250.00 paid to the authority is not a cost; rent is an overhead.
    expect(rowOf(r.rows, 'serviceId', visa.id)).toMatchObject({ serviceFeeRevenue: '600.00', directExpenses: '40.00', margin: '560.00', passThroughRemitted: '250.00' });
    expect(Number(rowOf(r.rows, 'serviceId', visa.id).marginPercent)).toBe(93.3);
    expect(rowOf(r.rows, 'serviceId', translation.id)).toMatchObject({ serviceFeeRevenue: '480.00', directExpenses: '0.00', margin: '480.00' });
    expect(r.totals).toMatchObject({ serviceFeeRevenue: '1080.00', directExpenses: '40.00', margin: '1040.00', passThroughRemitted: '250.00' });
    expect(Number(r.totals.marginPercent)).toBe(96.3);
    expect(JSON.stringify(r.notes)).toContain('1060.00'); // rent 1000.00 + electricity 60.00 are overheads, named but not allocated
    // The expense list of the finance module adds up to the same money.
    const expenses = await api(t, accountant).get(`/expenses?from=${YESTERDAY}&to=${TODAY}&pageSize=100`);
    expect(aed(sum((expenses.data as any[]).map((e) => fils(e.amount))))).toBe('1350.00');
    expect(expenses.totalAmount).toBe('1350.00');
  });

  it('S30 branch performance, dashboard, cash reconciliation and export show the same money', async () => {
    // --- branch report (money columns for a viewer with the financial permission)
    const branches = await report('branch-performance');
    const revenueByBranch = books.revenue(DAYS, (i) => i.branchId);
    for (const branchId of [centre.headOfficeId, secondBranchId]) {
      expect(rowOf(branches.rows, 'branchId', branchId)).toMatchObject({
        serviceFeeRevenue: aed(revenueByBranch.get(branchId)!.serviceFeeRevenue),
        grossCollections: aed(books.cash(DAYS, branchId).grossCollections),
        outstanding: aed(books.outstanding((i) => i.branchId === branchId)),
      });
    }
    expect(rowOf(branches.rows, 'branchId', secondBranchId)).toMatchObject({ serviceFeeRevenue: '480.00', grossCollections: '400.00', outstanding: '304.00' });
    expect(rowOf(branches.rows, 'branchId', centre.headOfficeId)).toMatchObject({ requestsSubmitted: 1, requestsCompleted: 1, grossCollections: '960.00', outstanding: '2000.00' });
    // The same report for somebody without the financial permission has no money in it.
    const manager = await inviteStaff(t, centre, 'reviewer');
    expectRefused(await api(t, manager).req('GET', `/reports/branch-performance?${RANGE}`), 403);
    expectRefused(await api(t, crew.receptionist).req('GET', `/reports/daily-sales?${RANGE}`), 403);

    // --- dashboard: today's tiles
    const today = books.revenue([TODAY]).get('all')!;
    const dashboard = await api(t, accountant).get('/dashboard');
    expect(dashboard.finance).toMatchObject({
      serviceRevenueToday: aed(today.serviceFeeRevenue),
      otherRevenueToday: '0.00',
      taxInvoicedToday: aed(today.tax),
      paymentsToday: aed(books.cash([TODAY]).payments),
      refundsToday: aed(books.cash([TODAY]).refunds),
      grossCollectionsToday: aed(books.cash([TODAY]).grossCollections),
      outstandingReceivables: aed(books.outstanding()),
      openInvoices: books.open().length,
    });
    const trends = await api(t, accountant).get(`/dashboard/trends?from=${YESTERDAY}&to=${TODAY}`);
    expect(trends.days.map((d: any) => [d.date, d.serviceRevenue, d.grossCollections])).toEqual(DAYS.map((d) => [d, aed((books.revenue([d]).get('all') ?? books.revenueTotal([])).serviceFeeRevenue), aed(books.cash([d]).grossCollections)]));

    // --- cash reconciliation: what the till should hold from today's cash payments, net of the cash refunds
    const cashPayments = books.payments.filter((p) => p.method === 'CASH');
    const expectedTill = sum(cashPayments.map((p) => p.amount)) - sum(books.refunds.filter((r) => cashPayments.some((p) => p.key === r.paymentKey)).map((r) => r.amount));
    const reconciliation = await api(t, accountant).post('/reconciliations', { method: 'CASH', periodStart: `${YESTERDAY}T00:00:00.000Z`, periodEnd: new Date(Date.now() + 60_000).toISOString(), settledAmount: aed(expectedTill), attachAll: true }, 201);
    expect(reconciliation).toMatchObject({ expectedAmount: aed(expectedTill), difference: '0.00', status: 'MATCHED' });
    expect(reconciliation.attached.count).toBe(cashPayments.length);
    expect(aed(expectedTill)).toBe('735.00'); // 590.00 - 155.00 + 420.00 - 120.00

    // --- export: the file carries the figures that are on the screen
    const screen = (await report('daily-sales')).totals;
    const csv = await api(t, accountant).download(`/reports/daily-sales/export?format=csv&${RANGE}`);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.toString('utf8').trim().split(/\r?\n/);
    const totalsLine = lines.at(-1)!;
    for (const figure of [screen.serviceFeeRevenue, screen.passThroughInvoiced, screen.tax, screen.totalInvoiced, screen.payments, screen.refunds, screen.grossCollections]) expect(totalsLine).toContain(figure);
    // Exporting is a permission of its own, and it is audited.
    expectRefused(await api(t, crew.receptionist).req('GET', `/reports/daily-sales/export?format=csv&${RANGE}`), 403);
    const audit = await api(t, centre.owner).get('/audit-logs?action=report.exported&pageSize=10');
    expect(audit.data.length).toBeGreaterThanOrEqual(1);
  });

  it('S30 the figures do not move when the reports are asked again, and no financial report is left out', async () => {
    const list = await api(t, accountant).get('/reports');
    const financial = (list.reports as any[]).filter((r) => r.permission === 'report.financial').map((r) => r.key).sort();
    // Every financial report the module offers is compared above. A new one must be added to this spec.
    expect(financial).toEqual(['corporate-revenue', 'daily-sales', 'liabilities', 'monthly-service-revenue', 'outstanding-payments', 'refunds', 'service-profitability', 'transactions-by-service']);
    for (const key of financial) {
      const query = key === 'outstanding-payments' ? '' : RANGE;
      const first = await report(key, query);
      const second = await report(key, query);
      expect(second.totals).toEqual(first.totals);
      expect(second.rows).toEqual(first.rows);
    }
  });
});
