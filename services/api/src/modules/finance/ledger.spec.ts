import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { localYmd } from '../reports/time';
import { createCustomer, issueInvoice, key, listen, recordPayment } from './fixtures';

describe('Finance: double-entry accounting', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountant: Actor;
  let manager: Actor;
  let operator: Actor;
  let customerId: string;
  const today = () => localYmd(new Date(), 'Asia/Dubai');
  const period = () => ({ from: '2020-01-01', to: today() });

  /** Journal lines of one document as `CODE:debit:credit`. */
  const posting = async (sourceType: string, sourceId: string) => {
    const entries = await t.sys.journalEntry.findMany({ where: { sourceType, sourceId }, include: { lines: { include: { account: true } } } });
    return entries.flatMap((e) => e.lines.map((l) => `${l.account.systemKey ?? l.account.code}:${l.debit.toFixed(2)}:${l.credit.toFixed(2)}`)).sort();
  };
  const balance = async (actor: Actor, systemKey: string) => {
    const accounts = (await t.as(actor).get('/accounting/accounts').expect(200)).body as Array<{ systemKey: string | null; balance: string }>;
    return accounts.find((a) => a.systemKey === systemKey)!.balance;
  };

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    accountant = await t.addStaff(alpha, 'accountant');
    manager = await t.addStaff(alpha, 'manager');
    operator = await t.addStaff(alpha, 'operator');
    customerId = (await createCustomer(t, alpha)).id;
  });
  afterAll(() => t.close());

  it('gives every centre the standard chart of accounts; access follows the role', async () => {
    const accounts = (await t.as(accountant).get('/accounting/accounts').expect(200)).body;
    expect(accounts.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['1000', '1100', '2000', '2100', '4000', '5040']));
    await t.as(operator).get('/accounting/accounts').expect(403);
    await t.as(manager).get('/accounting/reports/trial-balance').query({ asOf: today() }).expect(200);
    await t.as(manager).post('/accounting/journal', { date: today(), memo: 'x', lines: [] }).expect(403);
  });

  let invoiceId: string;
  it('posts an issued invoice: receivable against service revenue, VAT and the government fee held for the customer', async () => {
    const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '100.00', governmentFee: '200.00' });
    invoiceId = inv.id;
    expect(await posting('INVOICE_ISSUED', inv.id)).toEqual(['AR:305.00:0.00', 'GOV_PAYABLE:0.00:200.00', 'SERVICE_REVENUE:0.00:100.00', 'VAT_PAYABLE:0.00:5.00']);
  });

  it('posts payments to the till or bank account of their method', async () => {
    const paid = await recordPayment(t, alpha.owner, { method: 'CARD_POS', amount: '305.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId, amount: '305.00' }] }, key()).expect(201);
    expect(await posting('PAYMENT', paid.body.id)).toEqual(['AR:0.00:305.00', 'CARD_CLEARING:305.00:0.00']);
    expect(await balance(accountant, 'AR')).toBe('0.00');
  });

  it('reverses a voided invoice', async () => {
    const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '40.00', governmentFee: '0' });
    await t.as(alpha.owner).post(`/invoices/${inv.id}/void`, { reason: 'Issued by mistake' }).expect(200);
    expect(await posting('INVOICE_VOIDED', inv.id)).toEqual(['AR:0.00:42.00', 'SERVICE_REVENUE:40.00:0.00', 'VAT_PAYABLE:2.00:0.00']);
    expect(await balance(accountant, 'AR')).toBe('0.00');
  });

  it('a refund that cancels the charge posts the credit note and the money paid back', async () => {
    const inv = await issueInvoice(t, alpha.owner, customerId, { serviceFee: '100.00', governmentFee: '200.00' });
    const paid = (await recordPayment(t, alpha.owner, { method: 'CASH', amount: inv.total, branchId: alpha.headOfficeId, allocations: [{ invoiceId: inv.id, amount: inv.total }] }, key()).expect(201)).body;
    const refund = (await t.as(manager).post('/refunds', { paymentId: paid.id, amount: '305.00', reason: 'Application withdrawn', cancelCharge: true }).set('Idempotency-Key', key()).expect(201)).body;
    await t.as(accountant).post(`/refunds/${refund.id}/approve`, { reference: 'Cash voucher 1' }).expect(200);
    const note = await t.sys.creditNote.findFirstOrThrow({ where: { invoiceId: inv.id } });
    expect(await posting('CREDIT_NOTE', note.id)).toEqual(['AR:0.00:305.00', 'GOV_PAYABLE:200.00:0.00', 'SERVICE_REVENUE:100.00:0.00', 'VAT_PAYABLE:5.00:0.00']);
    expect(await posting('REFUND', refund.id)).toEqual(['AR:305.00:0.00', 'CASH:0.00:305.00']);
    expect(await balance(accountant, 'AR')).toBe('0.00');
    expect(await balance(accountant, 'CASH')).toBe('0.00');
  });

  let expenseId: string;
  it('posts expenses, and re-posts them when changed or deleted', async () => {
    const e = await t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category: 'RENT', description: 'October rent', amount: '1000.00', paidOn: today(), method: 'BANK_TRANSFER' }).expect(201);
    expenseId = e.body.id;
    expect(await posting('EXPENSE', expenseId)).toEqual(['BANK:0.00:1000.00', 'EXP_RENT:1000.00:0.00']);
    await t.as(accountant).patch(`/expenses/${expenseId}`, { amount: '1200.00' }).expect(200);
    expect(await balance(accountant, 'EXP_RENT')).toBe('1200.00');
    const temp = await t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category: 'SUPPLIES', description: 'Paper', amount: '30.00', paidOn: today(), method: 'CASH' }).expect(201);
    await t.as(accountant).delete(`/expenses/${temp.body.id}`).expect(200);
    expect(await balance(accountant, 'EXP_SUPPLIES')).toBe('0.00');
  });

  it('profit and loss, trial balance and balance sheet agree', async () => {
    const pl = (await t.as(accountant).get('/accounting/reports/profit-and-loss').query(period()).expect(200)).body;
    // 100 kept from the first invoice (the other was voided, the third credited) less 1200 rent.
    expect(pl).toMatchObject({ totalRevenue: '100.00', totalExpenses: '1200.00', netProfit: '-1100.00' });
    const tb = (await t.as(accountant).get('/accounting/reports/trial-balance').query({ asOf: today() }).expect(200)).body;
    expect(tb.balanced).toBe(true);
    const bs = (await t.as(accountant).get('/accounting/reports/balance-sheet').query({ asOf: today() }).expect(200)).body;
    expect(bs).toMatchObject({ balanced: true, currentEarnings: '-1100.00' });
    const vat = (await t.as(accountant).get('/accounting/reports/vat').query(period()).expect(200)).body;
    expect(vat).toMatchObject({ outputVat: '12.00', reversed: '7.00', netOutputVat: '5.00' });
  });

  it('manual journals must balance; they are reversed, never edited', async () => {
    const accounts = (await t.as(accountant).get('/accounting/accounts').expect(200)).body as Array<{ id: string; systemKey: string | null }>;
    const id = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const unbalanced = await t.as(accountant).post('/accounting/journal', { date: today(), memo: 'Owner investment', lines: [{ accountId: id('BANK'), debit: '5000.00' }, { accountId: id('OWNER_EQUITY'), credit: '4000.00' }] });
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.code).toBe('JOURNAL_NOT_BALANCED');
    await t.as(accountant).post('/accounting/journal', { date: today(), memo: 'Both sides', lines: [{ accountId: id('BANK'), debit: '1', credit: '1' }, { accountId: id('OWNER_EQUITY'), credit: '1' }] }).expect(400);
    const posted = await t.as(accountant).post('/accounting/journal', { date: today(), memo: 'Owner investment', lines: [{ accountId: id('BANK'), debit: '5000.00' }, { accountId: id('OWNER_EQUITY'), credit: '5000.00' }] }).expect(201);
    expect(await balance(accountant, 'OWNER_EQUITY')).toBe('5000.00');
    const entry = await t.sys.journalEntry.findUniqueOrThrow({ where: { id: posted.body.id } });
    expect(entry.entryNo).toMatch(/^JE-\d{6}$/);
    await expect(t.sys.journalLine.updateMany({ where: { entryId: entry.id }, data: { memo: 'changed' } })).rejects.toThrow(/never changed/);
    await t.as(accountant).post(`/accounting/journal/${entry.id}/reverse`, { reason: 'Wrong amount' }).expect(200);
    expect(await balance(accountant, 'OWNER_EQUITY')).toBe('0.00');
    expect((await t.as(accountant).post(`/accounting/journal/${entry.id}/reverse`, { reason: 'again' })).body.code).toBe('ALREADY_REVERSED');
    const auto = await t.sys.journalEntry.findFirstOrThrow({ where: { sourceType: 'INVOICE_ISSUED', sourceId: invoiceId } });
    expect((await t.as(accountant).post(`/accounting/journal/${auto.id}/reverse`, { reason: 'no' })).body.code).toBe('AUTOMATIC_JOURNAL');
  });

  it('builds the books from history once; centres never see each other\'s', async () => {
    // An expense recorded before accounting existed: written straight to the table, without a posting.
    const old = await t.sys.expense.create({ data: { tenantId: beta.id, branchId: beta.headOfficeId, category: 'UTILITIES', description: 'DEWA September', amount: '450.00', currency: 'AED', paidOn: new Date('2026-09-30T00:00:00.000Z'), method: 'BANK_TRANSFER', recordedById: beta.owner.userId! } });
    const first = (await t.as(beta.owner).post('/accounting/rebuild').expect(200)).body;
    expect(first.posted.EXPENSE).toBe(1);
    expect(await posting('EXPENSE', old.id)).toEqual(['BANK:0.00:450.00', 'EXP_UTILITIES:450.00:0.00']);
    expect((await t.as(beta.owner).post('/accounting/rebuild').expect(200)).body.posted.EXPENSE).toBe(0);
    const betaJournal = (await t.as(beta.owner).get('/accounting/journal').expect(200)).body;
    expect(betaJournal.data).toHaveLength(1);
    expect(betaJournal.data[0].date).toBe('2026-09-30');
    expect((await t.as(accountant).get('/accounting/journal').query({ pageSize: 100 }).expect(200)).body.data.some((e: { sourceId: string }) => e.sourceId === old.id)).toBe(false);
  });
});
