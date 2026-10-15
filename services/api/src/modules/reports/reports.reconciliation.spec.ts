import { Prisma } from '@typease/database';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { addBranch, creditNote, dubaiDay, dubaiDayStart, expense, issueInvoice, line, pay, refund, seedCorporate, seedCustomer, seedIssuedInvoice, seedRequest, seedService, voidInvoice } from './fixtures';

/**
 * "Reports match underlying financial records."
 *
 * A fixture with mixed fee components, discounts, tax, partial payments,
 * refunds with and without cancelling the charge, credit notes, a void invoice,
 * a draft, remittances, two branches and two centres is created through the
 * real finance API. Each financial report is then compared with
 *   (a) figures worked out by hand from the fixture (the literals below), and
 *   (b) sums computed here, independently, from the raw tables with exact decimals.
 */
type Dec = Prisma.Decimal;
const D = (v: unknown) => new Prisma.Decimal((v as any) ?? 0);
const m = (v: unknown) => D(v).toFixed(2);
const sum = (values: unknown[]) => values.reduce<Dec>((a, b) => a.plus(D(b)), D(0));
const round2 = (v: Dec) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const ISSUED = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED'];
const SETTLED = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const COMPONENTS = ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const;

describe('Financial reports reconcile with the financial records', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountant: Actor;
  let b1: string;
  let b2: string;
  const ref: Record<string, string> = {};
  const today = () => dubaiDay(0);
  const yesterday = () => dubaiDay(-1);

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant();
    beta = await t.createTenant();
    accountant = await t.addStaff(alpha, 'accountant');
    b1 = alpha.headOfficeId;
    b2 = (await addBranch(t, alpha)).id;
    const owner = alpha.owner;

    const s1 = await seedService(t, alpha, { name: 'Residence visa', categoryKey: 'visa' });
    const s2 = await seedService(t, alpha, { name: 'Tenancy contract typing' });
    const corp = await seedCorporate(t, alpha, 'Gulf Trading LLC');
    const c1 = await seedCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' });
    const c2 = await seedCustomer(t, alpha, { fullName: 'Omar Khalid' });
    const c3 = await seedCustomer(t, alpha, { fullName: 'Gulf Trading employee', corporateAccountId: corp.id });
    const r1 = await seedRequest(t, alpha, { customerId: c1.id, serviceId: s1.id, branchId: b1, status: 'IN_PREPARATION' });
    const r2 = await seedRequest(t, alpha, { customerId: c2.id, serviceId: s2.id, branchId: b2, status: 'IN_PREPARATION' });
    const r3 = await seedRequest(t, alpha, { customerId: c3.id, serviceId: s1.id, branchId: b1, status: 'IN_PREPARATION', corporateAccountId: corp.id });
    Object.assign(ref, { s1: s1.id, s2: s2.id, corp: corp.id, c1: c1.id, c2: c2.id, c3: c3.id, r1: r1.id, r2: r2.id, r3: r3.id });

    // A (b1, request 1 -> service 1): service 150.00 + tax 7.50, government 300.00, third party 25.00 = 482.50
    //   paid 200.00 + 282.50; then 48.25 refunded, charge kept (split by the finance module: 15.75 / 30.00 / 2.50)
    const a = await issueInvoice(t, accountant, { customerId: c1.id, branchId: b1, requestId: r1.id, items: [line('SERVICE_FEE', '150.00', { taxRatePercent: 5 }), line('GOVERNMENT_FEE', '300.00', { taxRatePercent: 0 }), line('THIRD_PARTY_FEE', '25.00', { taxRatePercent: 0 })] });
    await pay(t, accountant, { invoiceId: a.id, amount: '200.00', branchId: b1, customerId: c1.id });
    const payA2 = await pay(t, accountant, { invoiceId: a.id, amount: '282.50', branchId: b1, customerId: c1.id, method: 'CARD_POS' });
    await refund(t, accountant, owner, { paymentId: payA2.id, invoiceId: a.id, amount: '48.25' });

    // B (b2, request 2 -> service 2): service 2 x 80.00 - 10.00 discount = 150.00 + tax 7.50, government 120.00 = 277.50
    //   paid 100.00; credit note 31.50 on the service fee (30.00 + 1.50 tax)
    const b = await issueInvoice(t, accountant, {
      customerId: c2.id, branchId: b2, requestId: r2.id, issuer: owner,
      items: [line('SERVICE_FEE', '80.00', { quantity: 2, discountAmount: '10.00', taxRatePercent: 5 }), line('GOVERNMENT_FEE', '120.00', { taxRatePercent: 0 })],
    });
    await pay(t, accountant, { invoiceId: b.id, amount: '100.00', branchId: b2, customerId: c2.id });
    await creditNote(t, accountant, { invoiceId: b.id, amount: '31.50', breakdown: { SERVICE_FEE: '31.50' } });

    // C (b1, request 3 -> service 1, corporate): service 400.00 + tax 20.00, government 1000.00 = 1420.00
    //   paid in full by bank transfer; 105.00 refunded AND the charge cancelled (credit note 100.00 + 5.00 tax on the service fee)
    const c = await issueInvoice(t, accountant, { customerId: c3.id, branchId: b1, requestId: r3.id, corporateAccountId: corp.id, items: [line('SERVICE_FEE', '400.00', { taxRatePercent: 5 }), line('GOVERNMENT_FEE', '1000.00', { taxRatePercent: 0 })] });
    const payC = await pay(t, accountant, { invoiceId: c.id, amount: '1420.00', branchId: b1, customerId: c3.id, method: 'BANK_TRANSFER' });
    await refund(t, accountant, owner, { paymentId: payC.id, invoiceId: c.id, amount: '105.00', cancelCharge: true, breakdown: { SERVICE_FEE: '105.00' } });

    // D (b1, no request, no service): service 60.00 + tax 3.00 = 63.00, paid, 21.00 refunded, charge kept
    const d = await issueInvoice(t, accountant, { customerId: c1.id, branchId: b1, items: [line('SERVICE_FEE', '60.00', { taxRatePercent: 5 })] });
    const payD = await pay(t, accountant, { invoiceId: d.id, amount: '63.00', branchId: b1, customerId: c1.id });
    await refund(t, accountant, owner, { paymentId: payD.id, invoiceId: d.id, amount: '21.00' });

    // E (b2): issued and then voided  -> never counted.     F (b1): a draft -> never counted.
    const e = await issueInvoice(t, accountant, { customerId: c2.id, branchId: b2, items: [line('SERVICE_FEE', '90.00', { taxRatePercent: 5 })] });
    await voidInvoice(t, accountant, e.id);
    const f = await t.as(accountant).post('/invoices', { customerId: c1.id, branchId: b1, items: [{ description: 'Draft only', component: 'SERVICE_FEE', quantity: 1, unitAmount: '777.00' }] });
    expect(f.status).toBe(201);

    // G (b1, request 1, but its lines name service 2): service 200.00 + tax 10.00, third party 40.00 + tax 2.00 = 252.00, unpaid
    //   credit note 25.20 without a breakdown: the finance module spreads it 21.00 service / 4.20 third party
    const g = await issueInvoice(t, accountant, {
      customerId: c1.id, branchId: b1, requestId: r1.id,
      items: [line('SERVICE_FEE', '200.00', { taxRatePercent: 5, serviceId: s2.id }), line('THIRD_PARTY_FEE', '40.00', { taxRatePercent: 5, serviceId: s2.id })],
    });
    await creditNote(t, accountant, { invoiceId: g.id, amount: '25.20' });

    // H (b1): issued YESTERDAY: service 500.00 + tax 25.00, government 100.00 = 625.00, paid yesterday
    const h = await seedIssuedInvoice(t, alpha, { customerId: c1.id, branchId: b1, issuedAt: new Date(dubaiDayStart(-1).getTime() + 12 * 3_600_000), serviceFee: '500.00', governmentFee: '100.00' });
    await pay(t, accountant, { invoiceId: h.id, amount: '625.00', branchId: b1, customerId: c1.id, receivedAt: new Date(dubaiDayStart(-1).getTime() + 13 * 3_600_000) });
    Object.assign(ref, { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id, g: g.id, h: h.id });

    // Expenses: remittances of pass-through fees, costs linked to requests, and an overhead.
    await expense(t, accountant, { branchId: b1, category: 'GOVERNMENT_FEE_REMITTANCE', amount: '250.00', paidOn: today(), requestId: r1.id });
    await expense(t, accountant, { branchId: b1, category: 'THIRD_PARTY_PAYMENT', amount: '20.00', paidOn: today(), requestId: r1.id });
    await expense(t, accountant, { branchId: b1, category: 'GOVERNMENT_FEE_REMITTANCE', amount: '500.00', paidOn: today(), requestId: r3.id });
    await expense(t, accountant, { branchId: b1, category: 'SUPPLIES', amount: '35.00', paidOn: today(), requestId: r1.id });
    await expense(t, accountant, { branchId: b2, category: 'OTHER', amount: '12.00', paidOn: today(), requestId: r2.id });
    await expense(t, accountant, { branchId: b1, category: 'RENT', amount: '3000.00', paidOn: today() });

    // Another centre, with money of its own.
    const bc = await seedCustomer(t, beta);
    const bi = await issueInvoice(t, beta.owner, { customerId: bc.id, items: [line('SERVICE_FEE', '999.00', { taxRatePercent: 5 }), line('GOVERNMENT_FEE', '111.00', { taxRatePercent: 0 })] });
    await pay(t, beta.owner, { invoiceId: bi.id, amount: '1159.95', branchId: beta.headOfficeId, customerId: bc.id });
    await t.settle();
  });
  afterAll(() => t.close());

  // ====================================================================== independent computation from the raw tables
  interface Filter {
    start: Date;
    end: Date;
    branchId?: string;
  }
  const day = (offset = 0): Filter => ({ start: dubaiDayStart(offset), end: dubaiDayStart(offset + 1) });
  const within = (at: Date | null, f: Filter) => !!at && at >= f.start && at < f.end;

  async function raw(tenantId: string) {
    const [invoices, credits, payments, refunds, ledger, expenses, fees, requests] = await Promise.all([
      t.sys.invoice.findMany({ where: { tenantId }, include: { invoiceItems: true, request: { select: { serviceId: true } } } }),
      t.sys.creditNote.findMany({ where: { tenantId }, include: { invoice: { include: { invoiceItems: true, request: { select: { serviceId: true } } } } } }),
      t.sys.payment.findMany({ where: { tenantId } }),
      t.sys.refund.findMany({ where: { tenantId }, include: { payment: true } }),
      t.sys.liabilityEntry.findMany({ where: { tenantId } }),
      t.sys.expense.findMany({ where: { tenantId, deletedAt: null } }),
      t.sys.feeComponent.findMany({ where: { tenantId } }),
      t.sys.serviceRequest.findMany({ where: { tenantId }, select: { id: true, serviceId: true } }),
    ]);
    return { invoices, credits, payments, refunds, ledger, expenses, fees, requests };
  }
  type Raw = Awaited<ReturnType<typeof raw>>;
  type Movement = { net: Dec; tax: Dec; component: string; serviceId: string | null; branchId: string; corporateAccountId: string | null; kind: 'INVOICE' | 'CREDIT' };

  /** Every invoice line and credited component of the period, by the rules stated in the reports' notes. */
  function movements(data: Raw, f: Filter): Movement[] {
    const out: Movement[] = [];
    for (const inv of data.invoices) {
      if (!ISSUED.includes(inv.status) || !within(inv.issuedAt, f) || (f.branchId && inv.branchId !== f.branchId)) continue;
      for (const it of inv.invoiceItems) {
        out.push({ kind: 'INVOICE', net: D(it.lineTotal).minus(it.taxAmount), tax: D(it.taxAmount), component: it.component, serviceId: it.serviceId ?? inv.request?.serviceId ?? null, branchId: inv.branchId, corporateAccountId: inv.corporateAccountId });
      }
    }
    for (const cn of data.credits) {
      if (cn.status !== 'ISSUED' || !within(cn.issuedAt, f) || (f.branchId && cn.invoice.branchId !== f.branchId)) continue;
      const lineServices = [...new Set(cn.invoice.invoiceItems.map((i) => i.serviceId).filter((v): v is string => !!v))];
      const serviceId = lineServices.length === 1 ? lineServices[0] : (cn.invoice.request?.serviceId ?? null);
      for (const component of COMPONENTS) {
        const part = D((cn.breakdown as Record<string, string>)[component]);
        if (part.isZero()) continue;
        const lines = cn.invoice.invoiceItems.filter((i) => i.component === component);
        const gross = sum(lines.map((l) => l.lineTotal));
        const net = sum(lines.map((l) => D(l.lineTotal).minus(l.taxAmount)));
        const creditedNet = gross.gt(0) ? round2(part.mul(net).div(gross)) : part;
        out.push({ kind: 'CREDIT', net: creditedNet.neg(), tax: part.minus(creditedNet).neg(), component, serviceId, branchId: cn.invoice.branchId, corporateAccountId: cn.invoice.corporateAccountId });
      }
    }
    return out;
  }
  function revenue(data: Raw, f: Filter, pick: (mv: Movement) => boolean = () => true) {
    const isRevenue = (component: string) => component === 'SERVICE_FEE' || data.fees.find((x) => x.type === component)?.treatment === 'REVENUE';
    const rows = movements(data, f).filter(pick);
    return {
      serviceFeeInvoiced: m(sum(rows.filter((r) => r.kind === 'INVOICE' && r.component === 'SERVICE_FEE').map((r) => r.net))),
      serviceFeeCredited: m(sum(rows.filter((r) => r.kind === 'CREDIT' && r.component === 'SERVICE_FEE').map((r) => r.net)).neg()),
      serviceFeeRevenue: m(sum(rows.filter((r) => r.component === 'SERVICE_FEE').map((r) => r.net))),
      otherRevenue: m(sum(rows.filter((r) => r.component !== 'SERVICE_FEE' && isRevenue(r.component)).map((r) => r.net))),
      passThroughInvoiced: m(sum(rows.filter((r) => !isRevenue(r.component)).map((r) => r.net))),
      tax: m(sum(rows.map((r) => r.tax))),
      totalInvoiced: m(sum(rows.map((r) => r.net.plus(r.tax)))),
    };
  }
  /** The revenue columns every invoiced-amount report shares. */
  function columns(data: Raw, f: Filter, pick: (mv: Movement) => boolean = () => true) {
    const { serviceFeeRevenue, otherRevenue, passThroughInvoiced, tax, totalInvoiced } = revenue(data, f, pick);
    return { serviceFeeRevenue, otherRevenue, passThroughInvoiced, tax, totalInvoiced };
  }
  function cash(data: Raw, f: Filter) {
    const paid = sum(data.payments.filter((p) => SETTLED.includes(p.status) && within(p.receivedAt, f) && (!f.branchId || p.branchId === f.branchId)).map((p) => p.amount));
    const back = sum(data.refunds.filter((r) => r.status === 'COMPLETED' && within(r.processedAt, f) && (!f.branchId || r.payment.branchId === f.branchId)).map((r) => r.amount));
    return { payments: m(paid), refunds: m(back), grossCollections: m(paid.minus(back)) };
  }
  function receivable(data: Raw, branchId?: string) {
    return m(sum(data.invoices.filter((i) => ['ISSUED', 'PARTIALLY_PAID'].includes(i.status) && (!branchId || i.branchId === branchId)).map((i) => i.balanceDue)));
  }
  function ledger(data: Raw, component: string, f: Filter) {
    const rows = data.ledger.filter((e) => e.component === component && (!f.branchId || e.branchId === f.branchId));
    const inPeriod = rows.filter((e) => within(e.occurredAt, f));
    const signed = (e: (typeof rows)[number]) => (e.direction === 'ACCRUAL' ? D(e.amount) : D(e.amount).neg());
    return {
      opening: m(sum(rows.filter((e) => e.occurredAt < f.start).map(signed))),
      accrued: m(sum(inPeriod.filter((e) => e.direction === 'ACCRUAL' && e.sourceType !== 'EXPENSE_VOID').map((e) => e.amount))),
      reversed: m(sum(inPeriod.filter((e) => e.direction === 'REVERSAL').map((e) => e.amount))),
      remitted: m(sum(inPeriod.filter((e) => e.direction === 'REMITTANCE').map((e) => e.amount)).minus(sum(inPeriod.filter((e) => e.sourceType === 'EXPENSE_VOID').map((e) => e.amount)))),
      outstanding: m(sum(rows.filter((e) => e.occurredAt < f.end).map(signed))),
    };
  }
  const report = async (key: string, query: string, actor: Actor = accountant) => (await t.as(actor).get(`/reports/${key}?${query}`).expect(200)).body;
  const todayQuery = () => `from=${today()}&to=${today()}`;

  // ====================================================================== the checks
  it('the fixture is what the comments say (guards the hand calculation)', async () => {
    const data = await raw(alpha.id);
    const inv = (id: string) => data.invoices.find((i) => i.id === id)!;
    expect([m(inv(ref.a).total), m(inv(ref.b).total), m(inv(ref.c).total), m(inv(ref.d).total), m(inv(ref.g).total), m(inv(ref.h).total)]).toEqual(['482.50', '277.50', '1420.00', '63.00', '252.00', '625.00']);
    expect([inv(ref.a).status, inv(ref.b).status, inv(ref.c).status, inv(ref.d).status, inv(ref.e).status, inv(ref.g).status]).toEqual(['PARTIALLY_PAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_PAID', 'VOID', 'ISSUED']);
    expect(m(inv(ref.b).discountTotal)).toBe('10.00');
    expect(data.credits.map((c) => m(c.amount)).sort()).toEqual(['105.00', '25.20', '31.50']);
    expect(data.credits.find((c) => c.invoiceId === ref.g)!.breakdown).toMatchObject({ SERVICE_FEE: '21.00', THIRD_PARTY_FEE: '4.20' });
    expect(data.refunds.map((r) => m(r.amount)).sort()).toEqual(['105.00', '21.00', '48.25']);
    expect(data.refunds.find((r) => r.invoiceId === ref.a)!.breakdown).toMatchObject({ SERVICE_FEE: '15.75', GOVERNMENT_FEE: '30.00', THIRD_PARTY_FEE: '2.50', cancelCharge: false });
  });

  it('daily sales: totals equal the hand calculation and the raw tables, to the fils', async () => {
    const data = await raw(alpha.id);
    const r = await report('daily-sales', todayQuery());
    // service fees invoiced 150 + 150 + 400 + 60 + 200 = 960.00; credited 30 + 100 + 20 = 150.00  -> earned 810.00
    // pass-through 325 + 120 + 1000 + 40 - 4 = 1481.00;  tax 7.50 + 7.50 + 20 + 3 + 12 - (1.50 + 5.00 + 1.20) = 42.30
    // payments 200 + 282.50 + 100 + 1420 + 63 = 2065.50;  refunds 48.25 + 105 + 21 = 174.25
    const byHand = { serviceFeeRevenue: '810.00', otherRevenue: '0.00', passThroughInvoiced: '1481.00', tax: '42.30', totalInvoiced: '2333.30', payments: '2065.50', refunds: '174.25', grossCollections: '1891.25' };
    expect(r.totals).toMatchObject(byHand);
    expect(r.totals).toMatchObject({ ...columns(data, day()), ...cash(data, day()) });
    expect(r.totals.invoices).toBe(5); // A, B, C, D, G - not the void one, not the draft, not yesterday's
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ date: today(), ...byHand });
    // Total invoiced equals invoice totals minus credit notes: 2495.00 - 161.70
    const invoiced = sum(data.invoices.filter((i) => [ref.a, ref.b, ref.c, ref.d, ref.g].includes(i.id)).map((i) => i.total)).minus(sum(data.credits.map((c) => c.amount)));
    expect(r.totals.totalInvoiced).toBe(m(invoiced));
    expect(r.notes.join(' ')).toMatch(/accrual basis/);
    expect(r.notes.join(' ')).toMatch(/cash basis/);
    expect(r.notes.join(' ')).toMatch(/never counted as revenue/);
  });

  it('daily sales over two days adds yesterday, day by day', async () => {
    const data = await raw(alpha.id);
    const r = await report('daily-sales', `from=${yesterday()}&to=${today()}`);
    expect(r.rows.map((x: any) => x.date)).toEqual([yesterday(), today()]);
    expect(r.rows[0]).toMatchObject({ invoices: 1, serviceFeeRevenue: '500.00', passThroughInvoiced: '100.00', tax: '25.00', totalInvoiced: '625.00', payments: '625.00', refunds: '0.00', grossCollections: '625.00' });
    expect(r.rows[0]).toMatchObject({ ...columns(data, day(-1)), ...cash(data, day(-1)) });
    expect(r.totals).toMatchObject({ serviceFeeRevenue: '1310.00', grossCollections: '2516.25', totalInvoiced: '2958.30' });
    const both = { start: dubaiDayStart(-1), end: dubaiDayStart(1) };
    expect(r.totals).toMatchObject({ ...columns(data, both), ...cash(data, both) });
  });

  it('branch filters split the same figures without losing or duplicating a fils', async () => {
    const data = await raw(alpha.id);
    const one = await report('daily-sales', `${todayQuery()}&branchId=${b1}`);
    const two = await report('daily-sales', `${todayQuery()}&branchId=${b2}`);
    // b2 holds invoice B only: 150 - 30 = 120.00 earned, 120.00 government fee, tax 7.50 - 1.50, 100.00 received
    expect(two.totals).toMatchObject({ invoices: 1, serviceFeeRevenue: '120.00', passThroughInvoiced: '120.00', tax: '6.00', totalInvoiced: '246.00', payments: '100.00', refunds: '0.00', grossCollections: '100.00' });
    expect(one.totals).toMatchObject({ invoices: 4, serviceFeeRevenue: '690.00', passThroughInvoiced: '1361.00', tax: '36.30', payments: '1965.50', refunds: '174.25', grossCollections: '1791.25' });
    expect(one.totals).toMatchObject({ ...columns(data, { ...day(), branchId: b1 }), ...cash(data, { ...day(), branchId: b1 }) });
    expect(two.totals).toMatchObject({ ...columns(data, { ...day(), branchId: b2 }), ...cash(data, { ...day(), branchId: b2 }) });
    for (const key of ['serviceFeeRevenue', 'passThroughInvoiced', 'tax', 'totalInvoiced', 'grossCollections']) expect(m(D(one.totals[key]).plus(two.totals[key]))).toBe((await report('daily-sales', todayQuery())).totals[key]);
  });

  it('monthly service revenue separates invoiced, credited and earned, next to gross collections', async () => {
    const data = await raw(alpha.id);
    const r = await report('monthly-service-revenue', `from=${today()}&to=${today()}`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].month).toBe(today().slice(0, 7));
    expect(r.totals).toMatchObject({ invoices: 5, serviceFeeInvoiced: '960.00', serviceFeeCredited: '150.00', serviceFeeRevenue: '810.00', otherRevenue: '0.00', tax: '42.30', grossCollections: '1891.25' });
    const expected = revenue(data, day());
    expect(r.totals).toMatchObject({ serviceFeeInvoiced: expected.serviceFeeInvoiced, serviceFeeCredited: expected.serviceFeeCredited, serviceFeeRevenue: expected.serviceFeeRevenue, tax: expected.tax, grossCollections: cash(data, day()).grossCollections });
    // The default period is the last twelve months: this month's row then carries both days.
    const year = await report('monthly-service-revenue', '');
    expect(year.rows).toHaveLength(12);
    const whole = { start: dubaiDayStart(-400), end: dubaiDayStart(1) };
    expect(year.totals.serviceFeeRevenue).toBe(revenue(data, whole).serviceFeeRevenue);
    expect(year.totals.serviceFeeRevenue).toBe('1310.00');
    expect(year.totals.grossCollections).toBe(cash(data, whole).grossCollections);
  });

  it('transactions by service attribute every line and credit note to a service', async () => {
    const data = await raw(alpha.id);
    const r = await report('transactions-by-service', todayQuery());
    const row = (serviceId: string | null) => r.rows.find((x: any) => x.serviceId === serviceId);
    // service 1: A 150 + C 400 - 100 = 450.00; pass-through 325 + 1000.  service 2: B 150 - 30 + G 200 - 20 = 300.00; pass-through 120 + 36.
    expect(row(ref.s1)).toMatchObject({ service: 'Residence visa', invoices: 2, serviceFeeRevenue: '450.00', passThroughInvoiced: '1325.00' });
    expect(row(ref.s2)).toMatchObject({ service: 'Tenancy contract typing', invoices: 2, serviceFeeRevenue: '300.00', passThroughInvoiced: '156.00' });
    expect(row(null)).toMatchObject({ service: 'Not linked to a service', invoices: 1, serviceFeeRevenue: '60.00', passThroughInvoiced: '0.00' });
    for (const id of [ref.s1, ref.s2, null]) expect(row(id)).toMatchObject(columns(data, day(), (mv) => mv.serviceId === id));
    expect(r.totals).toMatchObject({ serviceFeeRevenue: '810.00', passThroughInvoiced: '1481.00', tax: '42.30', totalInvoiced: '2333.30' });

    const drill = (await t.as(accountant).get(`/reports/transactions-by-service/drilldown?${todayQuery()}&serviceId=${ref.s2}`).expect(200)).body;
    expect(drill.meta.total).toBe(4); // invoice B, its credit note, invoice G, its credit note
    expect(m(sum(drill.rows.map((x: any) => x.serviceFee)))).toBe('300.00');
    expect(drill.rows.every((x: any) => x.id && ['Invoice', 'CreditNote'].includes(x.resourceType))).toBe(true);
  });

  it('outstanding payments equal the open balances of the invoices, per ageing bucket', async () => {
    const data = await raw(alpha.id);
    const r = await report('outstanding-payments', '');
    // A 48.25 (refunded, charge kept) + B 277.50 - 100 - 31.50 = 146.00 + D 21.00 + G 252.00 - 25.20 = 226.80
    expect(r.totals.total).toBe('442.05');
    expect(r.totals.total).toBe(receivable(data));
    expect(r.totals.invoices).toBe(4);
    expect(r.period).toMatchObject({ from: null, to: null });
    const fatima = r.rows.find((x: any) => x.customerId === ref.c1);
    expect(fatima).toMatchObject({ customer: 'Fatima Al Mansoori', invoices: 3, total: '296.05' });
    expect(r.rows.find((x: any) => x.customerId === ref.c2)).toMatchObject({ invoices: 1, total: '146.00' });
    // Invoices issued through the API are due at once, so everything open is in the first overdue bucket or not yet due.
    expect(m(D(r.totals.current).plus(r.totals.days1to30).plus(r.totals.days31to60).plus(r.totals.days61to90).plus(r.totals.days90plus))).toBe('442.05');
    expect((await report('outstanding-payments', `branchId=${b2}`)).totals.total).toBe(receivable(data, b2));

    // Make one invoice 44.5 days late (45 days overdue, counted in whole days): it moves to the 31-60 bucket and nothing else changes.
    await t.sys.invoice.update({ where: { id: ref.g }, data: { dueAt: new Date(Date.now() - 44.5 * 86_400_000) } });
    const aged = await report('outstanding-payments', '');
    expect(aged.totals).toMatchObject({ days31to60: '226.80', total: '442.05' });
    const drill = (await t.as(accountant).get('/reports/outstanding-payments/drilldown?bucket=days31to60').expect(200)).body;
    expect(drill.rows).toHaveLength(1);
    expect(drill.rows[0]).toMatchObject({ id: ref.g, resourceType: 'Invoice', balanceDue: '226.80', daysOverdue: 45, bucket: 'days31to60' });
  });

  it('refunds: every completed refund, split by component', async () => {
    const data = await raw(alpha.id);
    const r = await report('refunds', todayQuery());
    expect(r.rows).toHaveLength(3);
    expect(r.totals).toMatchObject({ amount: '174.25', serviceFee: '141.75', governmentFee: '30.00', thirdParty: '2.50' });
    expect(r.totals.amount).toBe(m(sum(data.refunds.filter((x) => x.status === 'COMPLETED').map((x) => x.amount))));
    for (const [key, part] of [['serviceFee', 'SERVICE_FEE'], ['governmentFee', 'GOVERNMENT_FEE'], ['thirdParty', 'THIRD_PARTY_FEE']] as const) {
      expect(r.totals[key]).toBe(m(sum(data.refunds.map((x) => (x.breakdown as Record<string, string>)[part]))));
    }
    expect(r.rows.find((x: any) => x.invoiceId === ref.c)).toMatchObject({ amount: '105.00', chargeCancelled: 'Yes', method: 'BANK_TRANSFER' });
    expect(r.rows.find((x: any) => x.invoiceId === ref.a)).toMatchObject({ amount: '48.25', chargeCancelled: 'No', governmentFee: '30.00' });
    expect((await report('refunds', `from=${yesterday()}&to=${yesterday()}`)).rows).toHaveLength(0);
    expect((await report('refunds', `${todayQuery()}&branchId=${b2}`)).totals.amount).toBe('0.00');
  });

  it('liabilities equal the ledger: accrued, reversed, remitted and outstanding per component and per request', async () => {
    const data = await raw(alpha.id);
    const r = await report('liabilities', todayQuery());
    const gov = r.rows.find((x: any) => x.component === 'GOVERNMENT_FEE');
    const third = r.rows.find((x: any) => x.component === 'THIRD_PARTY_FEE');
    // government: A 300.00 + B 48.78 (100.00 of 246.00 after the credit note, x 120.00) + C 1000.00 + H 100.00 = 1448.78 accrued;
    //             30.00 reversed with the refund on A; 250.00 + 500.00 remitted  -> 668.78 still owed
    expect(gov).toMatchObject({ treatment: 'PASS_THROUGH_LIABILITY', opening: '0.00', accrued: '1448.78', reversed: '30.00', remitted: '750.00', outstanding: '668.78' });
    // third party: A 25.00 accrued, 2.50 reversed, 20.00 remitted -> 2.50
    expect(third).toMatchObject({ opening: '0.00', accrued: '25.00', reversed: '2.50', remitted: '20.00', outstanding: '2.50' });
    expect(gov).toMatchObject(ledger(data, 'GOVERNMENT_FEE', day()));
    expect(third).toMatchObject(ledger(data, 'THIRD_PARTY_FEE', day()));
    expect(r.totals).toMatchObject({ accrued: '1473.78', reversed: '32.50', remitted: '770.00', outstanding: '671.28' });
    // Opening balance of the next period = closing balance of this one.
    const tomorrow = await report('liabilities', `from=${dubaiDay(1)}&to=${dubaiDay(1)}`);
    expect(tomorrow.rows.find((x: any) => x.component === 'GOVERNMENT_FEE')).toMatchObject({ opening: '668.78', accrued: '0.00', outstanding: '668.78' });

    const drill = (await t.as(accountant).get(`/reports/liabilities/drilldown?${todayQuery()}&component=GOVERNMENT_FEE`).expect(200)).body;
    const perRequest = Object.fromEntries(drill.rows.map((x: any) => [x.requestId, x]));
    expect(perRequest[ref.r1]).toMatchObject({ accrued: '300.00', reversed: '30.00', remitted: '250.00', outstanding: '20.00', resourceType: 'ServiceRequest' });
    expect(perRequest[ref.r3]).toMatchObject({ accrued: '1000.00', remitted: '500.00', outstanding: '500.00' });
    expect(perRequest[ref.r2]).toMatchObject({ accrued: '48.78', outstanding: '48.78' });
    expect(m(sum(drill.rows.map((x: any) => x.outstanding)))).toBe('668.78');
    for (const row of drill.rows.filter((x: any) => x.requestId)) {
      const entries = data.ledger.filter((e) => e.requestId === row.requestId && e.component === 'GOVERNMENT_FEE');
      expect(row.outstanding).toBe(m(sum(entries.map((e) => (e.direction === 'ACCRUAL' ? D(e.amount) : D(e.amount).neg())))));
    }
    // The finance module's own liability endpoint agrees.
    const own = (await t.as(accountant).get('/finance/liabilities').expect(200)).body;
    expect(m(own.totalOutstanding)).toBe(r.totals.outstanding);
  });

  it('corporate revenue: per company, with collections on its invoices', async () => {
    const data = await raw(alpha.id);
    const r = await report('corporate-revenue', todayQuery());
    expect(r.rows).toHaveLength(1);
    // C: 400 - 100 = 300.00 earned; 1000.00 government; tax 20 - 5; 1420 received - 105 refunded
    expect(r.rows[0]).toMatchObject({ corporateAccountId: ref.corp, company: 'Gulf Trading LLC', invoices: 1, serviceFeeRevenue: '300.00', passThroughInvoiced: '1000.00', tax: '15.00', totalInvoiced: '1315.00', collected: '1315.00', outstanding: '0.00' });
    expect(r.rows[0]).toMatchObject(columns(data, day(), (mv) => mv.corporateAccountId === ref.corp));
    expect(r.totals.serviceFeeRevenue).toBe('300.00');
    const drill = (await t.as(accountant).get(`/reports/corporate-revenue/drilldown?${todayQuery()}&corporateAccountId=${ref.corp}`).expect(200)).body;
    expect(drill.rows).toEqual([expect.objectContaining({ id: ref.c, resourceType: 'Invoice', serviceFee: '400.00', total: '1420.00', balanceDue: '0.00' })]);
  });

  it('service profitability: earned revenue minus the expenses linked to requests, overheads stated and left out', async () => {
    const data = await raw(alpha.id);
    const r = await report('service-profitability', todayQuery());
    const row = (id: string) => r.rows.find((x: any) => x.serviceId === id);
    // service 1: 450.00 - supplies 35.00 = 415.00; remittances 250 + 20 + 500 are pass-through, not a cost
    expect(row(ref.s1)).toMatchObject({ serviceFeeRevenue: '450.00', otherRevenue: '0.00', directExpenses: '35.00', margin: '415.00', marginPercent: 92.2, passThroughRemitted: '770.00' });
    // service 2: 300.00 - 12.00 = 288.00
    expect(row(ref.s2)).toMatchObject({ serviceFeeRevenue: '300.00', directExpenses: '12.00', margin: '288.00', marginPercent: 96, passThroughRemitted: '0.00' });
    expect(r.totals).toMatchObject({ serviceFeeRevenue: '750.00', directExpenses: '47.00', margin: '703.00', passThroughRemitted: '770.00' });
    const serviceOf = (requestId: string | null) => data.requests.find((q) => q.id === requestId)?.serviceId ?? null;
    const direct = (id: string) => m(sum(data.expenses.filter((e) => serviceOf(e.requestId) === id && !['GOVERNMENT_FEE_REMITTANCE', 'THIRD_PARTY_PAYMENT'].includes(e.category)).map((e) => e.amount)));
    expect(row(ref.s1).directExpenses).toBe(direct(ref.s1));
    expect(row(ref.s2).directExpenses).toBe(direct(ref.s2));
    const notes = r.notes.join(' ');
    expect(notes).toMatch(/Unallocated overheads are NOT included/);
    expect(notes).toContain('AED 3000.00');
    expect(notes).toContain('AED 60.00 is not linked to any service');
    const drill = (await t.as(accountant).get(`/reports/service-profitability/drilldown?${todayQuery()}&serviceId=${ref.s1}`).expect(200)).body;
    expect(drill.meta.total).toBe(4);
    expect(drill.rows.filter((x: any) => x.countedAsCost === 'Yes').map((x: any) => x.amount)).toEqual(['35.00']);
  });

  it('branch performance and the dashboard show the same money as the financial reports', async () => {
    const data = await raw(alpha.id);
    const r = await report('branch-performance', todayQuery());
    const row = (id: string) => r.rows.find((x: any) => x.branchId === id);
    expect(row(b1)).toMatchObject({ serviceFeeRevenue: '690.00', grossCollections: '1791.25', outstanding: receivable(data, b1) });
    expect(row(b2)).toMatchObject({ serviceFeeRevenue: '120.00', grossCollections: '100.00', outstanding: '146.00' });
    expect(r.totals).toMatchObject({ serviceFeeRevenue: '810.00', grossCollections: '1891.25', outstanding: '442.05' });
    const dash = (await t.as(accountant).get('/dashboard').expect(200)).body.finance;
    expect(dash).toMatchObject({ serviceRevenueToday: '810.00', taxInvoicedToday: '42.30', grossCollectionsToday: '1891.25', outstandingReceivables: '442.05' });
  });

  it('another centre has its own books', async () => {
    const data = await raw(beta.id);
    const r = (await t.as(beta.owner).get(`/reports/daily-sales?${todayQuery()}`).expect(200)).body;
    expect(r.totals).toMatchObject({ invoices: 1, serviceFeeRevenue: '999.00', passThroughInvoiced: '111.00', tax: '49.95', totalInvoiced: '1159.95', payments: '1159.95', refunds: '0.00' });
    expect(r.totals).toMatchObject({ ...columns(data, day()), ...cash(data, day()) });
    const liabilities = (await t.as(beta.owner).get(`/reports/liabilities?${todayQuery()}`).expect(200)).body;
    expect(liabilities.totals).toMatchObject({ accrued: '111.00', outstanding: '111.00' });
    // A branch, service or company of another centre is unknown.
    await t.as(beta.owner).get(`/reports/daily-sales?branchId=${b1}`).expect(404);
    expect((await t.as(beta.owner).get(`/reports/transactions-by-service/drilldown?${todayQuery()}&serviceId=${ref.s1}`).expect(200)).body.rows).toEqual([]);
    expect((await t.as(beta.owner).get(`/reports/corporate-revenue/drilldown?${todayQuery()}&corporateAccountId=${ref.corp}`).expect(200)).body.rows).toEqual([]);
  });

  it('honours a centre that treats a fee component as revenue', async () => {
    const res = await t.as(alpha.owner).put('/finance/fee-components', { components: [{ type: 'THIRD_PARTY_FEE', treatment: 'REVENUE' }] });
    expect(res.status).toBe(200);
    const data = await raw(alpha.id);
    const r = await report('daily-sales', todayQuery());
    // third-party lines: A 25.00 + G 40.00 - 4.00 credited = 61.00 are now "other revenue"; the service-fee figure does not move
    expect(r.totals).toMatchObject({ serviceFeeRevenue: '810.00', otherRevenue: '61.00', passThroughInvoiced: '1420.00', tax: '42.30', totalInvoiced: '2333.30' });
    expect(r.totals).toMatchObject(columns(data, day()));
    const profit = await report('service-profitability', todayQuery());
    // The third-party payment of 20.00 for request 1 is now a real cost of service 1; its 25.00 third-party fee is revenue.
    expect(profit.rows.find((x: any) => x.serviceId === ref.s1)).toMatchObject({ serviceFeeRevenue: '450.00', otherRevenue: '25.00', directExpenses: '55.00', margin: '420.00', passThroughRemitted: '750.00' });
    expect(profit.rows.find((x: any) => x.serviceId === ref.s2)).toMatchObject({ otherRevenue: '36.00', margin: '324.00' });
    // The liability ledger keeps what was already accrued.
    expect((await report('liabilities', todayQuery())).rows.find((x: any) => x.component === 'THIRD_PARTY_FEE')).toMatchObject({ treatment: 'REVENUE', accrued: '25.00', outstanding: '2.50' });
  });
  it('"by customer": records that were merged are one row under the customer that was kept, and no total moves', async () => {
    const before = await report('outstanding-payments', '');
    const data = await raw(alpha.id);
    const rowOf = (r: any, id: string) => r.rows.filter((x: any) => x.customerId === id);
    const c1 = rowOf(before, ref.c1)[0];
    const c2 = rowOf(before, ref.c2)[0];
    expect(c1 && c2).toBeTruthy();
    const drillBefore = (await t.as(accountant).get('/reports/outstanding-payments/drilldown?pageSize=100').expect(200)).body;

    // The duplicate (c2) is merged into the record that is kept (c1). Issued invoices stay on the retired record.
    const source = await t.sys.customer.findUniqueOrThrow({ where: { id: ref.c2 } });
    await t.as(alpha.owner).post('/customers/merge', { targetId: ref.c1, sourceId: ref.c2, confirmSourceCustomerNo: source.customerNo, reason: 'Same person registered twice' }).expect(200);
    expect(await t.sys.invoice.count({ where: { tenantId: alpha.id, customerId: ref.c2, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, balanceDue: { gt: 0 } } })).toBe(c2.invoices);

    const after = await report('outstanding-payments', '');
    // Totals: unchanged to the fils, and still equal to the raw open balances.
    expect(after.totals).toEqual(before.totals);
    expect(after.totals.total).toBe(receivable(data));
    // One row for the survivor that carries both, none for the retired record.
    expect(rowOf(after, ref.c2)).toEqual([]);
    expect(rowOf(after, ref.c1)).toHaveLength(1);
    const merged = rowOf(after, ref.c1)[0];
    expect(merged).toMatchObject({ customer: c1.customer, invoices: c1.invoices + c2.invoices, total: m(D(c1.total).plus(c2.total)) });
    for (const bucket of ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus']) expect([bucket, merged[bucket]]).toEqual([bucket, m(D(c1[bucket]).plus(c2[bucket]))]);
    expect(after.rows).toHaveLength(before.rows.length - 1);
    expect(m(sum(after.rows.map((x: any) => x.total)))).toBe(before.totals.total);
    // Every other row is exactly what it was.
    const others = (r: any) => r.rows.filter((x: any) => ![ref.c1, ref.c2].includes(x.customerId));
    expect(others(after)).toEqual(others(before));
    expect(after.notes.join(' ')).toMatch(/merged are one customer/);

    // The drill-down of the survivor's row lists the invoices of both records; asking with the retired id gives the same.
    const drill = (await t.as(accountant).get(`/reports/outstanding-payments/drilldown?customerId=${ref.c1}&pageSize=100`).expect(200)).body;
    expect(drill.rows).toHaveLength(c1.invoices + c2.invoices);
    expect(m(sum(drill.rows.map((x: any) => x.balanceDue)))).toBe(merged.total);
    expect(drill.rows.every((x: any) => x.customerId === ref.c1 && x.customer === c1.customer)).toBe(true);
    const viaRetired = (await t.as(accountant).get(`/reports/outstanding-payments/drilldown?customerId=${ref.c2}&pageSize=100`).expect(200)).body;
    expect(viaRetired.rows.map((x: any) => x.id).sort()).toEqual(drill.rows.map((x: any) => x.id).sort());
    // The unfiltered drill-down still lists every open invoice once, with the same balances.
    const drillAfter = (await t.as(accountant).get('/reports/outstanding-payments/drilldown?pageSize=100').expect(200)).body;
    expect(drillAfter.rows.map((x: any) => [x.id, x.balanceDue]).sort()).toEqual(drillBefore.rows.map((x: any) => [x.id, x.balanceDue]).sort());
    // The export says the same as the screen.
    const csv = (await t.as(accountant).get('/reports/outstanding-payments/export?format=csv').expect(200)).text;
    expect(csv.split('\n').filter((l: string) => l.includes(c1.customer))).toHaveLength(1);
    // Another centre is not affected, and a customer id of this centre means nothing there.
    expect((await t.as(beta.owner).get(`/reports/outstanding-payments/drilldown?customerId=${ref.c1}`).expect(200)).body.rows).toEqual([]);
  });
});
