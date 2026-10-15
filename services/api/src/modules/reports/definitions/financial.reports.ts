import { Prisma, Tx } from '../../../common/db/prisma.service';
import { D } from '../../../common/pagination';
import { BASIS, branchSql, CollectionRow, FinanceMetrics, ISSUED_SQL, RevenueRow, SETTLED_SQL, ZERO_COLLECTIONS, ZERO_REVENUE } from '../finance-metrics.service';
import { BRANCH_PARAMETER, DrilldownOutput, PERIOD_PARAMETERS, ReportContext, ReportDefinition, ReportOutput, ReportRow } from '../report.types';
import { addMonths, eachDay, eachMonth, firstOfMonth, lastOfMonth, localYmd, period as makePeriod } from '../time';
import { mergedCustomerIds } from '../../../common/merged-customers';
import { col, customerLabelSql, intTotal, MAX_LISTED_ROWS, money, moneyTotal, percent, scopeOf, serviceNames, survivorCtes } from './shared';

const REMITTANCE_COMPONENT: Record<string, 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'> = { GOVERNMENT_FEE_REMITTANCE: 'GOVERNMENT_FEE', THIRD_PARTY_PAYMENT: 'THIRD_PARTY_FEE' };
const AGEING = ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'] as const;

const financialNotes = (rc: ReportContext, ...extra: string[]) => [BASIS.revenue, BASIS.passThrough, BASIS.otherRevenue, BASIS.tax, ...extra, BASIS.timeZone(rc.timeZone)];
const byKey = <T extends { key: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.key ?? '', r]));
const revenueCells = (r: RevenueRow) => ({
  invoices: r.invoices,
  serviceFeeRevenue: money(r.serviceFeeRevenue),
  otherRevenue: money(r.otherRevenue),
  passThroughInvoiced: money(r.passThroughInvoiced),
  tax: money(r.tax),
  totalInvoiced: money(r.totalInvoiced),
});
const REVENUE_COLUMNS = [
  col('invoices', 'Invoices issued', 'number'),
  col('serviceFeeRevenue', 'Earned service revenue', 'money'),
  col('otherRevenue', 'Other revenue (fees treated as revenue)', 'money'),
  col('passThroughInvoiced', 'Government and third-party fees invoiced (not revenue)', 'money'),
  col('tax', 'Tax invoiced', 'money'),
  col('totalInvoiced', 'Total invoiced', 'money'),
];
const revenueTotals = (rows: ReportRow[]) => ({
  invoices: intTotal(rows, 'invoices'),
  serviceFeeRevenue: moneyTotal(rows, 'serviceFeeRevenue'),
  otherRevenue: moneyTotal(rows, 'otherRevenue'),
  passThroughInvoiced: moneyTotal(rows, 'passThroughInvoiced'),
  tax: moneyTotal(rows, 'tax'),
  totalInvoiced: moneyTotal(rows, 'totalInvoiced'),
});

/** Documents behind the revenue and collection figures of a period (drill-down of the sales reports). */
async function salesDocuments(tx: Tx, rc: ReportContext, start: Date, end: Date, page: { skip: number; take: number }): Promise<DrilldownOutput> {
  const t = rc.tenantId;
  const branchI = branchSql(Prisma.sql`i."branchId"`, rc.branchIds);
  const branchP = branchSql(Prisma.sql`p."branchId"`, rc.branchIds);
  const union = Prisma.sql`
    SELECT 'Invoice'::text AS type, i."id", i."invoiceNo" AS number, i."issuedAt" AS at, i."customerId" AS customer_id, i."total" AS amount,
           (SELECT COALESCE(SUM(it."lineTotal" - it."taxAmount"), 0) FROM "invoice_items" it WHERE it."invoiceId" = i."id" AND it."component" = 'SERVICE_FEE') AS service_fee
    FROM "invoices" i WHERE i."tenantId" = ${t}::uuid AND i."status" IN ${ISSUED_SQL} AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end} ${branchI}
    UNION ALL
    SELECT 'CreditNote', c."id", c."creditNoteNo", c."issuedAt", i."customerId", -c."amount", NULL::numeric
    FROM "credit_notes" c JOIN "invoices" i ON i."id" = c."invoiceId"
    WHERE c."tenantId" = ${t}::uuid AND c."status" = 'ISSUED' AND c."issuedAt" >= ${start} AND c."issuedAt" < ${end} ${branchI}
    UNION ALL
    SELECT 'Payment', p."id", p."paymentNo", p."receivedAt", p."customerId", p."amount", NULL::numeric
    FROM "payments" p WHERE p."tenantId" = ${t}::uuid AND p."status" IN ${SETTLED_SQL} AND p."receivedAt" >= ${start} AND p."receivedAt" < ${end} ${branchP}
    UNION ALL
    SELECT 'Refund', rf."id", rf."refundNo", rf."processedAt", p."customerId", -rf."amount", NULL::numeric
    FROM "refunds" rf JOIN "payments" p ON p."id" = rf."paymentId"
    WHERE rf."tenantId" = ${t}::uuid AND rf."status" = 'COMPLETED' AND rf."processedAt" >= ${start} AND rf."processedAt" < ${end} ${branchP}`;
  const rows = await tx.$queryRaw<Array<Record<string, any>>>`
    SELECT d.*, ${customerLabelSql(rc)} AS customer, COUNT(*) OVER ()::int AS full_count
    FROM (${union}) d LEFT JOIN "customers" cu ON cu."id" = d.customer_id
    ORDER BY d.at, d.number OFFSET ${page.skip} LIMIT ${page.take}`;
  return {
    columns: [col('type', 'Document'), col('number', 'Number'), col('date', 'Date', 'date'), col('customer', 'Customer'), col('amount', 'Amount', 'money'), col('serviceFee', 'Service fee (excl. tax)', 'money')],
    rows: rows.map((r) => ({ resourceType: r.type, id: r.id, type: r.type === 'CreditNote' ? 'Credit note' : r.type, number: r.number, date: localYmd(r.at, rc.timeZone), at: r.at.toISOString(), customer: r.customer ?? null, amount: money(r.amount), serviceFee: r.service_fee === null ? null : money(r.service_fee) })),
    total: rows[0]?.full_count ?? 0,
    notes: ['Credit notes and refunds are shown as negative amounts. Invoice and credit-note amounts include every fee component and tax.'],
  };
}

export function financialReports(metrics: FinanceMetrics): ReportDefinition[] {
  // ====================================================================== daily sales
  const dailySales: ReportDefinition = {
    key: 'daily-sales',
    title: 'Daily sales',
    description: 'What was invoiced and what was collected, day by day. Earned service revenue and gross collections are shown side by side and are not the same thing.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'date', label: 'Day', type: 'date', drilldownOnly: true }],
    maxDays: 366,
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const scope = scopeOf(rc);
      const [revenue, cash] = [byKey(await metrics.revenue(tx, scope, rc.period.start, rc.period.end, 'day')), byKey(await metrics.collections(tx, scope, rc.period.start, rc.period.end, 'day'))];
      const rows: ReportRow[] = eachDay(rc.period.from, rc.period.to).map((day) => {
        const r = revenue.get(day) ?? ZERO_REVENUE(day);
        const c: CollectionRow = cash.get(day) ?? ZERO_COLLECTIONS(day);
        return { date: day, ...revenueCells(r), payments: money(c.payments), refunds: money(c.refunds), grossCollections: money(c.grossCollections) };
      });
      return {
        columns: [col('date', 'Date', 'date'), ...REVENUE_COLUMNS, col('payments', 'Payments received', 'money'), col('refunds', 'Refunds paid', 'money'), col('grossCollections', 'Gross collections (cash)', 'money')],
        rows,
        totals: { date: 'Total', ...revenueTotals(rows), payments: moneyTotal(rows, 'payments'), refunds: moneyTotal(rows, 'refunds'), grossCollections: moneyTotal(rows, 'grossCollections') },
        chart: { type: 'bar', x: 'date', series: [{ key: 'serviceFeeRevenue', label: 'Earned service revenue' }, { key: 'grossCollections', label: 'Gross collections' }] },
        notes: financialNotes(rc, BASIS.collections),
      };
    },
    async drilldown(tx, rc, page) {
      const day = rc.filters.date;
      const p = day ? makePeriod(day, day, rc.timeZone) : rc.period;
      return salesDocuments(tx, rc, p.start, p.end, page);
    },
  };

  // ====================================================================== monthly service revenue
  const monthlyRevenue: ReportDefinition = {
    key: 'monthly-service-revenue',
    title: 'Monthly service revenue',
    description: 'Earned service revenue per month: service fees invoiced, minus credit notes, excluding tax and pass-through fees. Gross collections are shown for comparison.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'month', label: 'Month', type: 'month', drilldownOnly: true }],
    branchScoped: true,
    defaultPeriod: (today: string) => ({ from: addMonths(firstOfMonth(today), -11), to: today }),
    async run(tx, rc): Promise<ReportOutput> {
      const scope = scopeOf(rc);
      const [revenue, cash] = [byKey(await metrics.revenue(tx, scope, rc.period.start, rc.period.end, 'month')), byKey(await metrics.collections(tx, scope, rc.period.start, rc.period.end, 'month'))];
      const rows: ReportRow[] = eachMonth(rc.period.from, rc.period.to).map((month) => {
        const r = revenue.get(month) ?? ZERO_REVENUE(month);
        const c = cash.get(month) ?? ZERO_COLLECTIONS(month);
        return {
          month, invoices: r.invoices, serviceFeeInvoiced: money(r.serviceFeeInvoiced), serviceFeeCredited: money(r.serviceFeeCredited), serviceFeeRevenue: money(r.serviceFeeRevenue),
          otherRevenue: money(r.otherRevenue), tax: money(r.tax), grossCollections: money(c.grossCollections),
        };
      });
      return {
        columns: [
          col('month', 'Month'), col('invoices', 'Invoices issued', 'number'), col('serviceFeeInvoiced', 'Service fees invoiced', 'money'), col('serviceFeeCredited', 'Service fees credited', 'money'),
          col('serviceFeeRevenue', 'Earned service revenue', 'money'), col('otherRevenue', 'Other revenue (fees treated as revenue)', 'money'), col('tax', 'Tax invoiced', 'money'), col('grossCollections', 'Gross collections (cash)', 'money'),
        ],
        rows,
        totals: {
          month: 'Total', invoices: intTotal(rows, 'invoices'), serviceFeeInvoiced: moneyTotal(rows, 'serviceFeeInvoiced'), serviceFeeCredited: moneyTotal(rows, 'serviceFeeCredited'),
          serviceFeeRevenue: moneyTotal(rows, 'serviceFeeRevenue'), otherRevenue: moneyTotal(rows, 'otherRevenue'), tax: moneyTotal(rows, 'tax'), grossCollections: moneyTotal(rows, 'grossCollections'),
        },
        chart: { type: 'line', x: 'month', series: [{ key: 'serviceFeeRevenue', label: 'Earned service revenue' }, { key: 'grossCollections', label: 'Gross collections' }] },
        notes: financialNotes(rc, BASIS.collections, 'A month that is only partly inside the chosen period shows only the days inside it.'),
      };
    },
    async drilldown(tx, rc, page) {
      const month = rc.filters.month;
      if (!month) return salesDocuments(tx, rc, rc.period.start, rc.period.end, page);
      // The month, cut to the report period so the drill-down adds up to the row it was opened from.
      const from = `${month}-01` < rc.period.from ? rc.period.from : `${month}-01`;
      const to = lastOfMonth(`${month}-01`) > rc.period.to ? rc.period.to : lastOfMonth(`${month}-01`);
      const p = makePeriod(from, to < from ? from : to, rc.timeZone);
      return salesDocuments(tx, rc, p.start, p.end, page);
    },
  };

  // ====================================================================== transactions by service
  const byService: ReportDefinition = {
    key: 'transactions-by-service',
    title: 'Transactions by service',
    description: 'Requests and invoiced amounts per service.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'serviceId', label: 'Service', type: 'service', drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const revenue = await metrics.revenue(tx, scopeOf(rc), rc.period.start, rc.period.end, 'service');
      const counts = await tx.$queryRaw<Array<{ service_id: string; submitted: number; completed: number }>>`
        SELECT r."serviceId"::text AS service_id,
               (COUNT(*) FILTER (WHERE r."submittedAt" >= ${rc.period.start} AND r."submittedAt" < ${rc.period.end}))::int AS submitted,
               (COUNT(*) FILTER (WHERE r."status" = 'COMPLETED' AND r."completedAt" >= ${rc.period.start} AND r."completedAt" < ${rc.period.end}))::int AS completed
        FROM "service_requests" r
        WHERE r."tenantId" = ${rc.tenantId}::uuid AND r."deletedAt" IS NULL ${branchSql(Prisma.sql`r."branchId"`, rc.branchIds)}
          AND ((r."submittedAt" >= ${rc.period.start} AND r."submittedAt" < ${rc.period.end}) OR (r."completedAt" >= ${rc.period.start} AND r."completedAt" < ${rc.period.end}))
        GROUP BY 1`;
      const revenueBy = byKey(revenue);
      const countBy = new Map(counts.map((c) => [c.service_id, c]));
      const ids = [...new Set([...revenue.map((r) => r.key ?? ''), ...counts.map((c) => c.service_id)])];
      const names = await serviceNames(tx, rc, ids);
      const rows: ReportRow[] = ids
        .map((id) => {
          const r = revenueBy.get(id) ?? ZERO_REVENUE(id);
          const c = countBy.get(id);
          return { serviceId: id || null, service: id ? (names.get(id)?.name ?? 'Deleted service') : 'Not linked to a service', code: id ? (names.get(id)?.code ?? null) : null, requestsSubmitted: c?.submitted ?? 0, requestsCompleted: c?.completed ?? 0, ...revenueCells(r) };
        })
        .sort((a, b) => D(b.serviceFeeRevenue).cmp(D(a.serviceFeeRevenue)) || String(a.service).localeCompare(String(b.service)));
      return {
        columns: [col('service', 'Service'), col('code', 'Code'), col('requestsSubmitted', 'Requests submitted', 'number'), col('requestsCompleted', 'Requests completed', 'number'), ...REVENUE_COLUMNS],
        rows,
        totals: { service: 'Total', code: null, requestsSubmitted: intTotal(rows, 'requestsSubmitted'), requestsCompleted: intTotal(rows, 'requestsCompleted'), ...revenueTotals(rows) },
        chart: { type: 'bar', x: 'service', series: [{ key: 'serviceFeeRevenue', label: 'Earned service revenue' }] },
        notes: financialNotes(rc, 'An invoice line belongs to the service named on the line, otherwise to the service of the request the invoice was raised for. A credit note follows the service of its invoice.'),
      };
    },
    async drilldown(tx, rc, page) {
      const serviceId = rc.filters.serviceId;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        WITH m AS (${metrics.movementsSql(scopeOf(rc), rc.period.start, rc.period.end, serviceId ? { serviceId } : {})})
        SELECT m.kind, m.doc_id, m.doc_no, m.at, m.request_id, ${customerLabelSql(rc)} AS customer,
               COALESCE(SUM(m.net) FILTER (WHERE m.component = 'SERVICE_FEE'), 0) AS service_fee,
               COALESCE(SUM(m.net) FILTER (WHERE m.component <> 'SERVICE_FEE'), 0) AS other_fees, COALESCE(SUM(m.tax), 0) AS tax, COUNT(*) OVER ()::int AS full_count
        FROM m LEFT JOIN "customers" cu ON cu."id" = m.customer_id
        GROUP BY m.kind, m.doc_id, m.doc_no, m.at, m.request_id, 6 ORDER BY m.at, m.doc_no OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('type', 'Document'), col('number', 'Number'), col('date', 'Date', 'date'), col('customer', 'Customer'), col('serviceFee', 'Service fee (excl. tax)', 'money'), col('otherFees', 'Other fees (excl. tax)', 'money'), col('tax', 'Tax', 'money')],
        rows: rows.map((r) => ({ resourceType: r.kind === 'INVOICE' ? 'Invoice' : 'CreditNote', id: r.doc_id, requestId: r.request_id, type: r.kind === 'INVOICE' ? 'Invoice' : 'Credit note', number: r.doc_no, date: localYmd(r.at, rc.timeZone), customer: r.customer ?? null, serviceFee: money(r.service_fee), otherFees: money(r.other_fees), tax: money(r.tax) })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== outstanding payments
  const bucketSql = (now: Date) => Prisma.sql`
    CASE WHEN i."dueAt" IS NULL OR i."dueAt" >= ${now} THEN 'current'
         WHEN CEIL(EXTRACT(EPOCH FROM (${now}::timestamptz - i."dueAt")) / 86400.0) <= 30 THEN 'days1to30'
         WHEN CEIL(EXTRACT(EPOCH FROM (${now}::timestamptz - i."dueAt")) / 86400.0) <= 60 THEN 'days31to60'
         WHEN CEIL(EXTRACT(EPOCH FROM (${now}::timestamptz - i."dueAt")) / 86400.0) <= 90 THEN 'days61to90'
         ELSE 'days90plus' END`;
  const outstanding: ReportDefinition = {
    key: 'outstanding-payments',
    title: 'Outstanding payments',
    description: 'Open invoice balances per customer, aged by days past the due date.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [BRANCH_PARAMETER, { key: 'customerId', label: 'Customer', type: 'customer', drilldownOnly: true }, { key: 'bucket', label: 'Ageing bucket', type: 'enum', options: [...AGEING], drilldownOnly: true }],
    asOfNow: true,
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        WITH RECURSIVE o AS (
          SELECT i."customerId", i."corporateAccountId", i."balanceDue", ${bucketSql(rc.now)} AS bucket
          FROM "invoices" i
          WHERE i."tenantId" = ${rc.tenantId}::uuid AND i."status" IN ('ISSUED', 'PARTIALLY_PAID') AND i."balanceDue" > 0 ${branchSql(Prisma.sql`i."branchId"`, rc.branchIds)}
        ), ${survivorCtes(rc.tenantId, Prisma.sql`SELECT DISTINCT "customerId" AS id FROM o`)}
        -- Issued invoices keep the id of a record that was later merged away: the row is the customer that was kept.
        SELECT sv.root AS customer_id, ${customerLabelSql(rc)} AS customer, o."corporateAccountId" AS corporate_account_id, ca."companyName" AS company, COUNT(*)::int AS invoices,
          COALESCE(SUM(o."balanceDue") FILTER (WHERE o.bucket = 'current'), 0) AS "current",
          COALESCE(SUM(o."balanceDue") FILTER (WHERE o.bucket = 'days1to30'), 0) AS days1to30,
          COALESCE(SUM(o."balanceDue") FILTER (WHERE o.bucket = 'days31to60'), 0) AS days31to60,
          COALESCE(SUM(o."balanceDue") FILTER (WHERE o.bucket = 'days61to90'), 0) AS days61to90,
          COALESCE(SUM(o."balanceDue") FILTER (WHERE o.bucket = 'days90plus'), 0) AS days90plus,
          COALESCE(SUM(o."balanceDue"), 0) AS total
        FROM o
        JOIN survivor sv ON sv.id = o."customerId"
        JOIN "customers" cu ON cu."id" = sv.root
        LEFT JOIN "corporate_accounts" ca ON ca."id" = o."corporateAccountId"
        GROUP BY 1, 2, 3, 4 ORDER BY total DESC, customer`;
      const out: ReportRow[] = rows.map((r) => ({
        customerId: r.customer_id, corporateAccountId: r.corporate_account_id, customer: r.customer, company: r.company ?? null, invoices: r.invoices,
        current: money(r.current), days1to30: money(r.days1to30), days31to60: money(r.days31to60), days61to90: money(r.days61to90), days90plus: money(r.days90plus), total: money(r.total),
      }));
      return {
        columns: [
          col('customer', 'Customer'), col('company', 'Company'), col('invoices', 'Open invoices', 'number'), col('current', 'Not yet due', 'money'), col('days1to30', '1-30 days overdue', 'money'),
          col('days31to60', '31-60 days', 'money'), col('days61to90', '61-90 days', 'money'), col('days90plus', 'Over 90 days', 'money'), col('total', 'Total outstanding', 'money'),
        ],
        rows: out,
        totals: {
          customer: 'Total', company: null, invoices: intTotal(out, 'invoices'), current: moneyTotal(out, 'current'), days1to30: moneyTotal(out, 'days1to30'), days31to60: moneyTotal(out, 'days31to60'),
          days61to90: moneyTotal(out, 'days61to90'), days90plus: moneyTotal(out, 'days90plus'), total: moneyTotal(out, 'total'),
        },
        chart: { type: 'bar', x: 'customer', series: [{ key: 'total', label: 'Outstanding' }] },
        notes: [
          'Balances are as of the moment the report is run: the open balance (total - credit notes - payments + refunds) of every issued invoice that is not fully settled, all fee components and tax included.',
          'An invoice is aged by whole days past its due date; an invoice without a due date, or not yet due, is "not yet due".',
          'Customer records that were merged are one customer here: invoices that stayed on a retired record are counted under the record that was kept.',
        ],
      };
    },
    async drilldown(tx, rc, page) {
      // The row that was clicked stands for the kept record and everything merged into it.
      const family = rc.filters.customerId ? await mergedCustomerIds(tx, rc.tenantId, String(rc.filters.customerId)) : null;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        WITH RECURSIVE o AS (
          SELECT i."id", i."invoiceNo", i."customerId", i."requestId", i."issuedAt", i."dueAt", i."total", i."balanceDue", i."status"::text AS status, ${bucketSql(rc.now)} AS bucket,
                 CASE WHEN i."dueAt" IS NULL OR i."dueAt" >= ${rc.now} THEN 0 ELSE CEIL(EXTRACT(EPOCH FROM (${rc.now}::timestamptz - i."dueAt")) / 86400.0)::int END AS days_overdue
          FROM "invoices" i
          WHERE i."tenantId" = ${rc.tenantId}::uuid AND i."status" IN ('ISSUED', 'PARTIALLY_PAID') AND i."balanceDue" > 0 ${branchSql(Prisma.sql`i."branchId"`, rc.branchIds)}
            ${family ? Prisma.sql`AND i."customerId"::text = ANY(${family})` : Prisma.empty}
            ${rc.filters.corporateAccountId ? Prisma.sql`AND i."corporateAccountId" = ${rc.filters.corporateAccountId}::uuid` : Prisma.empty}
        ), ${survivorCtes(rc.tenantId, Prisma.sql`SELECT DISTINCT "customerId" AS id FROM o`)}
        SELECT o.*, sv.root AS survivor_id, ${customerLabelSql(rc)} AS customer, COUNT(*) OVER ()::int AS full_count
        FROM o JOIN survivor sv ON sv.id = o."customerId" JOIN "customers" cu ON cu."id" = sv.root
        ${rc.filters.bucket ? Prisma.sql`WHERE o.bucket = ${rc.filters.bucket}` : Prisma.empty}
        ORDER BY o.days_overdue DESC, o."invoiceNo" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('invoiceNo', 'Invoice'), col('customer', 'Customer'), col('issuedOn', 'Issued', 'date'), col('dueOn', 'Due', 'date'), col('daysOverdue', 'Days overdue', 'number'), col('total', 'Invoice total', 'money'), col('balanceDue', 'Open balance', 'money'), col('bucket', 'Ageing')],
        rows: rows.map((r) => ({
          resourceType: 'Invoice', id: r.id, requestId: r.requestId, customerId: r.survivor_id, invoiceNo: r.invoiceNo, customer: r.customer, issuedOn: r.issuedAt ? localYmd(r.issuedAt, rc.timeZone) : null,
          dueOn: r.dueAt ? localYmd(r.dueAt, rc.timeZone) : null, daysOverdue: r.days_overdue, total: money(r.total), balanceDue: money(r.balanceDue), bucket: r.bucket, status: r.status,
        })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== refunds
  const refunds: ReportDefinition = {
    key: 'refunds',
    title: 'Refunds',
    description: 'Refunds paid out in the period, split by fee component, and whether the charge itself was cancelled.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const where = Prisma.sql`rf."tenantId" = ${rc.tenantId}::uuid AND rf."status" = 'COMPLETED' AND rf."processedAt" >= ${rc.period.start} AND rf."processedAt" < ${rc.period.end} ${branchSql(Prisma.sql`p."branchId"`, rc.branchIds)}`;
      const part = (key: string) => Prisma.sql`COALESCE(NULLIF(rf."breakdown" ->> ${key}, '')::numeric, 0)`;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT rf."id", rf."refundNo", rf."processedAt", rf."amount", rf."reason", rf."requestId", rf."invoiceId", p."id" AS payment_id, p."paymentNo", p."method"::text AS method, i."invoiceNo",
               ${customerLabelSql(rc)} AS customer, ${part('SERVICE_FEE')} AS service_fee, ${part('GOVERNMENT_FEE')} AS government_fee, ${part('THIRD_PARTY_FEE')} AS third_party,
               COALESCE((rf."breakdown" ->> 'cancelCharge')::boolean, false) AS cancel_charge
        FROM "refunds" rf JOIN "payments" p ON p."id" = rf."paymentId"
        LEFT JOIN "invoices" i ON i."id" = rf."invoiceId" LEFT JOIN "customers" cu ON cu."id" = p."customerId"
        WHERE ${where} ORDER BY rf."processedAt", rf."refundNo" LIMIT ${MAX_LISTED_ROWS}`;
      const totals = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(rf."amount"), 0) AS amount, COALESCE(SUM(${part('SERVICE_FEE')}), 0) AS service_fee,
               COALESCE(SUM(${part('GOVERNMENT_FEE')}), 0) AS government_fee, COALESCE(SUM(${part('THIRD_PARTY_FEE')}), 0) AS third_party
        FROM "refunds" rf JOIN "payments" p ON p."id" = rf."paymentId" WHERE ${where}`;
      const pending = await tx.$queryRaw<Array<{ n: number; amount: Prisma.Decimal }>>`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(rf."amount"), 0) AS amount FROM "refunds" rf JOIN "payments" p ON p."id" = rf."paymentId"
        WHERE rf."tenantId" = ${rc.tenantId}::uuid AND rf."status" IN ('REQUESTED', 'APPROVED', 'PROCESSING') ${branchSql(Prisma.sql`p."branchId"`, rc.branchIds)}`;
      const t = totals[0];
      const notes = [
        'Refunds are counted when they are paid out (completed), on the day of the pay-out. They reduce gross collections of that day.',
        'The service-fee, government-fee and third-party parts include their share of tax. A refund that cancels the charge also issued a credit note, which reduces earned revenue; a refund without it leaves the amount due again.',
        `${pending[0]?.n ?? 0} refund(s) worth ${rc.currency} ${money(pending[0]?.amount)} are requested or approved but not yet paid out, and are not part of this report.`,
        BASIS.timeZone(rc.timeZone),
      ];
      if (t.n > rows.length) notes.unshift(`Showing the first ${rows.length} of ${t.n} refunds. The totals cover all of them.`);
      return {
        columns: [
          col('refundNo', 'Refund'), col('date', 'Paid out', 'date'), col('paymentNo', 'Payment'), col('invoiceNo', 'Invoice'), col('customer', 'Customer'), col('method', 'Payment method'), col('amount', 'Amount', 'money'),
          col('serviceFee', 'Service-fee part', 'money'), col('governmentFee', 'Government-fee part', 'money'), col('thirdParty', 'Third-party part', 'money'), col('chargeCancelled', 'Charge cancelled'), col('reason', 'Reason'),
        ],
        rows: rows.map((r) => ({
          refundId: r.id, paymentId: r.payment_id, invoiceId: r.invoiceId, requestId: r.requestId, refundNo: r.refundNo, date: localYmd(r.processedAt, rc.timeZone), paymentNo: r.paymentNo, invoiceNo: r.invoiceNo ?? null,
          customer: r.customer ?? null, method: r.method, amount: money(r.amount), serviceFee: money(r.service_fee), governmentFee: money(r.government_fee), thirdParty: money(r.third_party), chargeCancelled: r.cancel_charge ? 'Yes' : 'No', reason: r.reason,
        })),
        totals: { refundNo: `Total (${t.n})`, amount: money(t.amount), serviceFee: money(t.service_fee), governmentFee: money(t.government_fee), thirdParty: money(t.third_party) },
        notes,
      };
    },
  };

  // ====================================================================== liabilities
  const liabilities: ReportDefinition = {
    key: 'liabilities',
    title: 'Government-fee and third-party liabilities',
    description: 'Money collected on behalf of authorities and third parties: accrued, reversed, remitted and still owed.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'component', label: 'Fee component', type: 'enum', options: ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'], drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const inPeriod = Prisma.sql`le."occurredAt" >= ${rc.period.start} AND le."occurredAt" < ${rc.period.end}`;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT le."component"::text AS component,
          COALESCE(SUM(CASE WHEN le."direction" = 'ACCRUAL' THEN le."amount" ELSE -le."amount" END) FILTER (WHERE le."occurredAt" < ${rc.period.start}), 0) AS opening,
          COALESCE(SUM(le."amount") FILTER (WHERE ${inPeriod} AND le."direction" = 'ACCRUAL' AND le."sourceType" <> 'EXPENSE_VOID'), 0) AS accrued,
          COALESCE(SUM(le."amount") FILTER (WHERE ${inPeriod} AND le."direction" = 'REVERSAL'), 0) AS reversed,
          COALESCE(SUM(CASE WHEN le."direction" = 'REMITTANCE' THEN le."amount" ELSE -le."amount" END) FILTER (WHERE ${inPeriod} AND (le."direction" = 'REMITTANCE' OR le."sourceType" = 'EXPENSE_VOID')), 0) AS remitted,
          COALESCE(SUM(CASE WHEN le."direction" = 'ACCRUAL' THEN le."amount" ELSE -le."amount" END), 0) AS outstanding
        FROM "liability_entries" le
        WHERE le."tenantId" = ${rc.tenantId}::uuid AND le."occurredAt" < ${rc.period.end} ${branchSql(Prisma.sql`le."branchId"`, rc.branchIds)}
        GROUP BY 1`;
      const components = await tx.feeComponent.findMany({ where: { tenantId: rc.tenantId, type: { in: ['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] } }, select: { type: true, name: true, treatment: true } });
      const out: ReportRow[] = (['GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as const).map((type) => {
        const r = rows.find((x) => x.component === type);
        const c = components.find((x) => x.type === type);
        return {
          component: type, name: c?.name ?? (type === 'GOVERNMENT_FEE' ? 'Government fee' : 'Third-party fee'), treatment: c?.treatment ?? 'PASS_THROUGH_LIABILITY',
          opening: money(r?.opening), accrued: money(r?.accrued), reversed: money(r?.reversed), remitted: money(r?.remitted), outstanding: money(r?.outstanding),
        };
      });
      return {
        columns: [
          col('name', 'Fee component'), col('treatment', 'Accounting treatment'), col('opening', 'Owed at the start', 'money'), col('accrued', 'Accrued (collected)', 'money'), col('reversed', 'Reversed (refunded / credited)', 'money'),
          col('remitted', 'Remitted (paid out)', 'money'), col('outstanding', 'Owed at the end', 'money'),
        ],
        rows: out,
        totals: { name: 'Total', treatment: null, opening: moneyTotal(out, 'opening'), accrued: moneyTotal(out, 'accrued'), reversed: moneyTotal(out, 'reversed'), remitted: moneyTotal(out, 'remitted'), outstanding: moneyTotal(out, 'outstanding') },
        chart: { type: 'bar', x: 'name', series: [{ key: 'outstanding', label: 'Still owed' }] },
        notes: [
          'Figures come from the liability ledger (cash basis): a liability is accrued when the customer pays, reversed when the money is refunded or the charge is credited, and remitted when an expense pays it out to the authority or third party.',
          'Owed at the end = owed at the start + accrued - reversed - remitted. A deleted remittance expense counts as a negative remittance.',
          BASIS.passThrough,
          'A component the centre treats as REVENUE accrues nothing from the moment that setting was made.',
          BASIS.timeZone(rc.timeZone),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT le."requestId" AS request_id, le."component"::text AS component, r."requestNo", ${customerLabelSql(rc)} AS customer,
          COALESCE(SUM(le."amount") FILTER (WHERE le."direction" = 'ACCRUAL' AND le."sourceType" <> 'EXPENSE_VOID'), 0) AS accrued,
          COALESCE(SUM(le."amount") FILTER (WHERE le."direction" = 'REVERSAL'), 0) AS reversed,
          COALESCE(SUM(CASE WHEN le."direction" = 'REMITTANCE' THEN le."amount" ELSE -le."amount" END) FILTER (WHERE le."direction" = 'REMITTANCE' OR le."sourceType" = 'EXPENSE_VOID'), 0) AS remitted,
          COALESCE(SUM(CASE WHEN le."direction" = 'ACCRUAL' THEN le."amount" ELSE -le."amount" END), 0) AS outstanding,
          COUNT(*) OVER ()::int AS full_count
        FROM "liability_entries" le
        LEFT JOIN "service_requests" r ON r."id" = le."requestId" LEFT JOIN "customers" cu ON cu."id" = r."customerId"
        WHERE le."tenantId" = ${rc.tenantId}::uuid AND le."occurredAt" < ${rc.period.end} ${branchSql(Prisma.sql`le."branchId"`, rc.branchIds)}
          ${rc.filters.component ? Prisma.sql`AND le."component"::text = ${rc.filters.component}` : Prisma.empty}
          ${rc.filters.requestId ? Prisma.sql`AND le."requestId" = ${rc.filters.requestId}::uuid` : Prisma.empty}
        GROUP BY 1, 2, 3, 4 ORDER BY outstanding DESC, r."requestNo" NULLS LAST, 2 OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('requestNo', 'Request'), col('customer', 'Customer'), col('component', 'Fee component'), col('accrued', 'Accrued', 'money'), col('reversed', 'Reversed', 'money'), col('remitted', 'Remitted', 'money'), col('outstanding', 'Still owed', 'money')],
        rows: rows.map((r) => ({
          resourceType: r.request_id ? 'ServiceRequest' : null, id: r.request_id, requestId: r.request_id, requestNo: r.requestNo ?? 'Not linked to a request', customer: r.customer ?? null, component: r.component,
          accrued: money(r.accrued), reversed: money(r.reversed), remitted: money(r.remitted), outstanding: money(r.outstanding),
        })),
        total: rows[0]?.full_count ?? 0,
        notes: [`Balances per request from the start of the ledger to the end of ${rc.period.to}.`],
      };
    },
  };

  // ====================================================================== corporate revenue
  const corporate: ReportDefinition = {
    key: 'corporate-revenue',
    title: 'Corporate revenue',
    description: 'Invoiced amounts, earned service revenue, collections and open balance per corporate account.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'corporateAccountId', label: 'Corporate account', type: 'corporateAccount', drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const branchI = branchSql(Prisma.sql`i."branchId"`, rc.branchIds);
      const revenue = (await metrics.revenue(tx, scopeOf(rc), rc.period.start, rc.period.end, 'corporate')).filter((r) => r.key);
      const cash = await tx.$queryRaw<Array<{ id: string; collected: Prisma.Decimal }>>`
        SELECT x.id, COALESCE(SUM(x.amount), 0) AS collected FROM (
          SELECT i."corporateAccountId"::text AS id, pa."amount" AS amount
          FROM "payment_allocations" pa JOIN "payments" p ON p."id" = pa."paymentId" JOIN "invoices" i ON i."id" = pa."invoiceId"
          WHERE pa."tenantId" = ${rc.tenantId}::uuid AND p."status" IN ${SETTLED_SQL} AND p."receivedAt" >= ${rc.period.start} AND p."receivedAt" < ${rc.period.end} AND i."corporateAccountId" IS NOT NULL ${branchI}
          UNION ALL
          SELECT i."corporateAccountId"::text, -rf."amount"
          FROM "refunds" rf JOIN "invoices" i ON i."id" = rf."invoiceId"
          WHERE rf."tenantId" = ${rc.tenantId}::uuid AND rf."status" = 'COMPLETED' AND rf."processedAt" >= ${rc.period.start} AND rf."processedAt" < ${rc.period.end} AND i."corporateAccountId" IS NOT NULL ${branchI}
        ) x GROUP BY 1`;
      const open = await tx.$queryRaw<Array<{ id: string; outstanding: Prisma.Decimal }>>`
        SELECT i."corporateAccountId"::text AS id, COALESCE(SUM(i."balanceDue"), 0) AS outstanding FROM "invoices" i
        WHERE i."tenantId" = ${rc.tenantId}::uuid AND i."status" IN ('ISSUED', 'PARTIALLY_PAID') AND i."corporateAccountId" IS NOT NULL ${branchI} GROUP BY 1`;
      const ids = [...new Set([...revenue.map((r) => r.key!), ...cash.map((c) => c.id), ...open.filter((o) => D(o.outstanding).gt(0)).map((o) => o.id)])];
      const accounts = ids.length ? await tx.corporateAccount.findMany({ where: { tenantId: rc.tenantId, id: { in: ids } }, select: { id: true, companyName: true, accountNo: true } }) : [];
      const revenueBy = byKey(revenue);
      const rows: ReportRow[] = ids
        .map((id) => {
          const account = accounts.find((a) => a.id === id);
          return {
            corporateAccountId: id, company: account?.companyName ?? 'Unknown company', accountNo: account?.accountNo ?? null, ...revenueCells(revenueBy.get(id) ?? ZERO_REVENUE(id)),
            collected: money(cash.find((c) => c.id === id)?.collected), outstanding: money(open.find((o) => o.id === id)?.outstanding),
          };
        })
        .sort((a, b) => D(b.serviceFeeRevenue).cmp(D(a.serviceFeeRevenue)) || String(a.company).localeCompare(String(b.company)));
      return {
        columns: [col('company', 'Company'), col('accountNo', 'Account'), ...REVENUE_COLUMNS, col('collected', 'Collected on its invoices (cash)', 'money'), col('outstanding', 'Open balance now', 'money')],
        rows,
        totals: { company: 'Total', accountNo: null, ...revenueTotals(rows), collected: moneyTotal(rows, 'collected'), outstanding: moneyTotal(rows, 'outstanding') },
        chart: { type: 'bar', x: 'company', series: [{ key: 'serviceFeeRevenue', label: 'Earned service revenue' }] },
        notes: financialNotes(
          rc,
          'Only invoices billed to a corporate account are included.',
          '"Collected" is the money allocated to the company\'s invoices from payments completed in the period, minus refunds completed in the period on those invoices (cash basis, all components). "Open balance" is as of now.',
        ),
      };
    },
    async drilldown(tx, rc, page) {
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT i."id", i."invoiceNo", i."issuedAt", i."status"::text AS status, i."total", i."balanceDue", i."requestId", i."corporateAccountId", ca."companyName",
               (SELECT COALESCE(SUM(it."lineTotal" - it."taxAmount"), 0) FROM "invoice_items" it WHERE it."invoiceId" = i."id" AND it."component" = 'SERVICE_FEE') AS service_fee,
               COUNT(*) OVER ()::int AS full_count
        FROM "invoices" i JOIN "corporate_accounts" ca ON ca."id" = i."corporateAccountId"
        WHERE i."tenantId" = ${rc.tenantId}::uuid AND i."status" IN ${ISSUED_SQL} AND i."issuedAt" >= ${rc.period.start} AND i."issuedAt" < ${rc.period.end} ${branchSql(Prisma.sql`i."branchId"`, rc.branchIds)}
          ${rc.filters.corporateAccountId ? Prisma.sql`AND i."corporateAccountId" = ${rc.filters.corporateAccountId}::uuid` : Prisma.empty}
        ORDER BY i."issuedAt", i."invoiceNo" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('invoiceNo', 'Invoice'), col('company', 'Company'), col('date', 'Issued', 'date'), col('serviceFee', 'Service fee (excl. tax)', 'money'), col('total', 'Invoice total', 'money'), col('balanceDue', 'Open balance', 'money'), col('status', 'Status')],
        rows: rows.map((r) => ({ resourceType: 'Invoice', id: r.id, requestId: r.requestId, corporateAccountId: r.corporateAccountId, invoiceNo: r.invoiceNo, company: r.companyName, date: localYmd(r.issuedAt, rc.timeZone), serviceFee: money(r.service_fee), total: money(r.total), balanceDue: money(r.balanceDue), status: r.status })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== service profitability
  const profitability: ReportDefinition = {
    key: 'service-profitability',
    title: 'Service profitability',
    description: 'Earned revenue per service minus the expenses recorded against requests of that service.',
    permission: 'report.financial',
    category: 'FINANCE',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'serviceId', label: 'Service', type: 'service', drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const revenue = await metrics.revenue(tx, scopeOf(rc), rc.period.start, rc.period.end, 'service');
      const expenseRows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT r."serviceId"::text AS service_id,
          COALESCE(SUM(e."amount") FILTER (WHERE NOT ${passThroughRemittanceSql(rc.tenantId)}), 0) AS direct_cost,
          COALESCE(SUM(e."amount") FILTER (WHERE ${passThroughRemittanceSql(rc.tenantId)}), 0) AS pass_through_remitted
        FROM "expenses" e LEFT JOIN "service_requests" r ON r."id" = e."requestId"
        WHERE e."tenantId" = ${rc.tenantId}::uuid AND e."deletedAt" IS NULL AND e."paidOn" >= ${rc.period.from}::date AND e."paidOn" <= ${rc.period.to}::date ${branchSql(Prisma.sql`e."branchId"`, rc.branchIds)}
        GROUP BY 1`;
      const unallocated = expenseRows.find((e) => e.service_id === null);
      const linked = expenseRows.filter((e) => e.service_id !== null);
      const revenueBy = byKey(revenue.filter((r) => r.key));
      const ids = [...new Set([...revenue.filter((r) => r.key).map((r) => r.key!), ...linked.map((e) => e.service_id as string)])];
      const names = await serviceNames(tx, rc, ids);
      const rows: ReportRow[] = ids
        .map((id) => {
          const r = revenueBy.get(id) ?? ZERO_REVENUE(id);
          const e = linked.find((x) => x.service_id === id);
          const earned = r.serviceFeeRevenue.plus(r.otherRevenue);
          const cost = D(e?.direct_cost);
          const margin = earned.minus(cost);
          return {
            serviceId: id, service: names.get(id)?.name ?? 'Deleted service', code: names.get(id)?.code ?? null, serviceFeeRevenue: money(r.serviceFeeRevenue), otherRevenue: money(r.otherRevenue),
            directExpenses: money(cost), margin: money(margin), marginPercent: percent(margin, earned), passThroughRemitted: money(e?.pass_through_remitted),
          };
        })
        .sort((a, b) => D(b.margin).cmp(D(a.margin)) || String(a.service).localeCompare(String(b.service)));
      const noService = revenue.find((r) => !r.key);
      const totalEarned = D(moneyTotal(rows, 'serviceFeeRevenue')).plus(moneyTotal(rows, 'otherRevenue'));
      return {
        columns: [
          col('service', 'Service'), col('code', 'Code'), col('serviceFeeRevenue', 'Earned service revenue', 'money'), col('otherRevenue', 'Other revenue (fees treated as revenue)', 'money'),
          col('directExpenses', 'Expenses linked to its requests', 'money'), col('margin', 'Margin before overheads', 'money'), col('marginPercent', 'Margin %', 'percent'),
          col('passThroughRemitted', 'Pass-through fees remitted (not a cost)', 'money'),
        ],
        rows,
        totals: {
          service: 'Total', code: null, serviceFeeRevenue: moneyTotal(rows, 'serviceFeeRevenue'), otherRevenue: moneyTotal(rows, 'otherRevenue'), directExpenses: moneyTotal(rows, 'directExpenses'),
          margin: moneyTotal(rows, 'margin'), marginPercent: percent(moneyTotal(rows, 'margin'), totalEarned), passThroughRemitted: moneyTotal(rows, 'passThroughRemitted'),
        },
        chart: { type: 'bar', x: 'service', series: [{ key: 'margin', label: 'Margin before overheads' }] },
        notes: [
          'Margin = earned revenue of the service minus the expenses recorded against requests of that service and paid in the period. It is a margin before overheads, not a profit figure.',
          `Unallocated overheads are NOT included: expenses that are not linked to a request (rent, salaries, supplies ...) came to ${rc.currency} ${money(D(unallocated?.direct_cost).plus(D(unallocated?.pass_through_remitted)))} in this period and are not spread over the services.`,
          'Remittances of pass-through government and third-party fees are not a cost of the centre (the money was collected on behalf of others); they are shown for information only. If the centre treats such a component as REVENUE, its remittances count as an expense.',
          ...(noService && !(noService.serviceFeeRevenue.isZero() && noService.otherRevenue.isZero()) ? [`Earned revenue of ${rc.currency} ${money(noService.serviceFeeRevenue.plus(noService.otherRevenue))} is not linked to any service and is not shown in a row.`] : []),
          BASIS.revenue,
          BASIS.tax,
          BASIS.timeZone(rc.timeZone),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT e."id", e."category", e."description", e."amount", e."paidOn", e."payee", e."requestId", r."requestNo", r."serviceId", ${passThroughRemittanceSql(rc.tenantId)} AS pass_through, COUNT(*) OVER ()::int AS full_count
        FROM "expenses" e JOIN "service_requests" r ON r."id" = e."requestId"
        WHERE e."tenantId" = ${rc.tenantId}::uuid AND e."deletedAt" IS NULL AND e."paidOn" >= ${rc.period.from}::date AND e."paidOn" <= ${rc.period.to}::date ${branchSql(Prisma.sql`e."branchId"`, rc.branchIds)}
          ${rc.filters.serviceId ? Prisma.sql`AND r."serviceId" = ${rc.filters.serviceId}::uuid` : Prisma.empty}
        ORDER BY e."paidOn", e."createdAt" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('date', 'Paid on', 'date'), col('category', 'Category'), col('description', 'Description'), col('payee', 'Paid to'), col('requestNo', 'Request'), col('amount', 'Amount', 'money'), col('countedAsCost', 'Counted as a cost')],
        rows: rows.map((r) => ({
          resourceType: 'Expense', id: r.id, requestId: r.requestId, serviceId: r.serviceId, date: (r.paidOn as Date).toISOString().slice(0, 10), category: r.category, description: r.description, payee: r.payee ?? null,
          requestNo: r.requestNo, amount: money(r.amount), countedAsCost: r.pass_through ? 'No (pass-through remittance)' : 'Yes',
        })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  return [dailySales, monthlyRevenue, byService, outstanding, refunds, liabilities, corporate, profitability];
}

/** Expense alias `e`: a remittance of a component that the centre holds on behalf of others (not a cost of the centre). */
function passThroughRemittanceSql(tenantId: string): Prisma.Sql {
  const treated = (component: string) => Prisma.sql`COALESCE((SELECT fc."treatment"::text FROM "fee_components" fc WHERE fc."tenantId" = ${tenantId}::uuid AND fc."type"::text = ${component}), 'PASS_THROUGH_LIABILITY') <> 'REVENUE'`;
  return Prisma.sql`((e."category" = ${Object.keys(REMITTANCE_COMPONENT)[0]} AND ${treated('GOVERNMENT_FEE')}) OR (e."category" = ${Object.keys(REMITTANCE_COMPONENT)[1]} AND ${treated('THIRD_PARTY_FEE')}))`;
}
