import { REQUEST_STATUS_META } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import { Prisma } from '../../../common/db/prisma.service';
import { D } from '../../../common/pagination';
import { BASIS, branchSql, FinanceMetrics, localMonthSql } from '../finance-metrics.service';
import { BRANCH_PARAMETER, PERIOD_PARAMETERS, ReportColumn, ReportContext, ReportDefinition, ReportOutput, ReportRow } from '../report.types';
import { addDays, addMonths, eachMonth, firstOfMonth, lastOfMonth, localYmd, period as makePeriod } from '../time';
import { branchNames, col, customerLabelSql, hours, intTotal, money, moneyTotal, percent, scopeOf, serviceNames } from './shared';

const OPEN_SQL = Prisma.sql`r."status" NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED')`;
const statusLabel = (status: string) => REQUEST_STATUS_META[status as RequestStatus]?.en ?? status;
const requestBranch = (rc: ReportContext) => branchSql(Prisma.sql`r."branchId"`, rc.branchIds);
const inPeriod = (column: Prisma.Sql, rc: ReportContext) => Prisma.sql`${column} >= ${rc.period.start} AND ${column} < ${rc.period.end}`;
const timeNote = (rc: ReportContext) => BASIS.timeZone(rc.timeZone);

export function operationalReports(metrics: FinanceMetrics): ReportDefinition[] {
  // ====================================================================== requests by status
  const byStatus: ReportDefinition = {
    key: 'requests-by-status',
    title: 'Requests by status',
    description: 'Where the requests created in the period stand today.',
    permission: 'report.operational',
    category: 'OPERATIONS',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'status', label: 'Status', type: 'enum', options: Object.keys(REQUEST_STATUS_META), drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const counts = await tx.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT r."status"::text AS status, COUNT(*)::int AS n FROM "service_requests" r
        WHERE r."tenantId" = ${rc.tenantId}::uuid AND r."deletedAt" IS NULL AND ${inPeriod(Prisma.sql`r."createdAt"`, rc)} ${requestBranch(rc)} GROUP BY 1`;
      const total = counts.reduce((n, c) => n + c.n, 0);
      // The order of the request lifecycle, not the alphabet.
      const rows: ReportRow[] = (Object.keys(REQUEST_STATUS_META) as RequestStatus[])
        .map((status) => ({ status, n: counts.find((c) => c.status === status)?.n ?? 0 }))
        .filter((r) => r.n > 0)
        .map((r) => ({ statusKey: r.status, status: statusLabel(r.status), count: r.n, share: percent(r.n, total) }));
      return {
        columns: [col('status', 'Status'), col('count', 'Requests', 'number'), col('share', 'Share', 'percent')],
        rows,
        totals: { status: 'Total', count: total, share: total ? 100 : null },
        chart: { type: 'pie', x: 'status', series: [{ key: 'count', label: 'Requests' }] },
        notes: ['Requests created in the period (drafts included), counted by the status they have at the moment the report is run.', timeNote(rc)],
      };
    },
    async drilldown(tx, rc, page) {
      const status = rc.filters.status && rc.filters.status in REQUEST_STATUS_META ? rc.filters.status : null;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT r."id", r."requestNo", r."status"::text AS status, r."priority"::text AS priority, r."createdAt", r."targetDate", r."branchId", b."name" AS branch, s."name" AS service,
               ${customerLabelSql(rc)} AS customer, COUNT(*) OVER ()::int AS full_count
        FROM "service_requests" r JOIN "customers" cu ON cu."id" = r."customerId" JOIN "branches" b ON b."id" = r."branchId" JOIN "services" s ON s."id" = r."serviceId"
        WHERE r."tenantId" = ${rc.tenantId}::uuid AND r."deletedAt" IS NULL AND ${inPeriod(Prisma.sql`r."createdAt"`, rc)} ${requestBranch(rc)}
          ${status ? Prisma.sql`AND r."status"::text = ${status}` : Prisma.empty}
        ORDER BY r."createdAt", r."requestNo" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('requestNo', 'Request'), col('customer', 'Customer'), col('service', 'Service'), col('branch', 'Branch'), col('status', 'Status'), col('priority', 'Priority'), col('created', 'Created', 'date')],
        rows: rows.map((r) => ({ resourceType: 'ServiceRequest', id: r.id, requestNo: r.requestNo, customer: r.customer, service: r.service, branch: r.branch, statusKey: r.status, status: statusLabel(r.status), priority: r.priority, created: localYmd(r.createdAt, rc.timeZone) })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== staff workload and performance
  const staff: ReportDefinition = {
    key: 'staff-workload',
    title: 'Staff workload and performance',
    description: 'Per staff member: cases assigned and completed in the period, average handling time, and the open workload right now.',
    permission: 'report.operational',
    category: 'OPERATIONS',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'membershipId', label: 'Staff member', type: 'staff', drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const t = rc.tenantId;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        WITH assigned AS (
          SELECT a."assigneeId" AS id, COUNT(*)::int AS n FROM "request_assignments" a JOIN "service_requests" r ON r."id" = a."requestId"
          WHERE a."tenantId" = ${t}::uuid AND a."role" = 'OPERATOR' AND ${inPeriod(Prisma.sql`a."assignedAt"`, rc)} AND r."deletedAt" IS NULL ${requestBranch(rc)} GROUP BY 1
        ), done AS (
          SELECT r."assignedToId" AS id, COUNT(*)::int AS n, ROUND(AVG(EXTRACT(EPOCH FROM (r."completedAt" - r."submittedAt")) / 3600.0)::numeric, 1) AS avg_hours
          FROM "service_requests" r
          WHERE r."tenantId" = ${t}::uuid AND r."deletedAt" IS NULL AND r."status" = 'COMPLETED' AND r."assignedToId" IS NOT NULL AND r."submittedAt" IS NOT NULL AND ${inPeriod(Prisma.sql`r."completedAt"`, rc)} ${requestBranch(rc)} GROUP BY 1
        ), open AS (
          SELECT r."assignedToId" AS id, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE r."targetDate" < ${rc.now}))::int AS overdue
          FROM "service_requests" r WHERE r."tenantId" = ${t}::uuid AND r."deletedAt" IS NULL AND r."assignedToId" IS NOT NULL AND ${OPEN_SQL} ${requestBranch(rc)} GROUP BY 1
        ), todo AS (
          SELECT ta."assigneeId" AS id, COUNT(*)::int AS n FROM "task_assignments" ta JOIN "tasks" tk ON tk."id" = ta."taskId"
          WHERE ta."tenantId" = ${t}::uuid AND ta."unassignedAt" IS NULL AND tk."status" IN ('OPEN', 'IN_PROGRESS')
            ${rc.branchIds ? Prisma.sql`AND (tk."branchId" IS NULL OR tk."branchId"::text = ANY(${rc.branchIds}))` : Prisma.empty} GROUP BY 1
        )
        SELECT m."id", u."fullName" AS name, ro."name" AS role, m."status"::text AS member_status,
               COALESCE(assigned.n, 0) AS assigned, COALESCE(done.n, 0) AS completed, done.avg_hours, COALESCE(open.n, 0) AS open_requests, COALESCE(open.overdue, 0) AS overdue, COALESCE(todo.n, 0) AS open_tasks
        FROM "tenant_memberships" m JOIN "users" u ON u."id" = m."userId" JOIN "roles" ro ON ro."id" = m."roleId"
        LEFT JOIN assigned ON assigned.id = m."id" LEFT JOIN done ON done.id = m."id" LEFT JOIN open ON open.id = m."id" LEFT JOIN todo ON todo.id = m."id"
        WHERE m."tenantId" = ${t}::uuid AND m."kind" = 'STAFF' AND COALESCE(assigned.n, 0) + COALESCE(done.n, 0) + COALESCE(open.n, 0) + COALESCE(todo.n, 0) > 0
        ORDER BY open_requests DESC, name`;
      const out: ReportRow[] = rows.map((r) => ({
        membershipId: r.id, staff: r.member_status === 'ACTIVE' ? r.name : `${r.name} (no longer active)`, role: r.role, assigned: r.assigned, completed: r.completed, avgHandlingHours: hours(r.avg_hours),
        openRequests: r.open_requests, overdueRequests: r.overdue, openTasks: r.open_tasks,
      }));
      return {
        columns: [
          col('staff', 'Staff member'), col('role', 'Role'), col('assigned', 'Cases assigned in the period', 'number'), col('completed', 'Cases completed in the period', 'number'),
          col('avgHandlingHours', 'Average handling time (hours)', 'number'), col('openRequests', 'Open cases now', 'number'), col('overdueRequests', 'Overdue cases now', 'number'), col('openTasks', 'Open tasks now', 'number'),
        ],
        rows: out,
        totals: { staff: 'Total', role: null, assigned: intTotal(out, 'assigned'), completed: intTotal(out, 'completed'), avgHandlingHours: null, openRequests: intTotal(out, 'openRequests'), overdueRequests: intTotal(out, 'overdueRequests'), openTasks: intTotal(out, 'openTasks') },
        chart: { type: 'bar', x: 'staff', series: [{ key: 'openRequests', label: 'Open cases' }, { key: 'completed', label: 'Completed in the period' }] },
        notes: [
          '"Assigned" counts operator assignments made in the period (a reassigned case counts for each person it was given to). "Completed" counts requests completed in the period by the operator who holds them.',
          'Handling time is the time from submission to completion of those completed requests, in hours, including waiting for the customer and for authorities.',
          'Open and overdue cases and open tasks are as of now. Staff without any of these figures are not listed.',
          timeNote(rc),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const member = rc.filters.membershipId;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT r."id", r."requestNo", r."status"::text AS status, r."submittedAt", r."completedAt", r."targetDate", r."assignedToId", u."fullName" AS staff, s."name" AS service, ${customerLabelSql(rc)} AS customer,
               COUNT(*) OVER ()::int AS full_count
        FROM "service_requests" r JOIN "customers" cu ON cu."id" = r."customerId" JOIN "services" s ON s."id" = r."serviceId"
        JOIN "tenant_memberships" m ON m."id" = r."assignedToId" JOIN "users" u ON u."id" = m."userId"
        WHERE r."tenantId" = ${rc.tenantId}::uuid AND r."deletedAt" IS NULL ${requestBranch(rc)}
          ${member ? Prisma.sql`AND r."assignedToId" = ${member}::uuid` : Prisma.empty}
          AND (${OPEN_SQL} OR (r."status" = 'COMPLETED' AND ${inPeriod(Prisma.sql`r."completedAt"`, rc)}))
        ORDER BY (r."status" = 'COMPLETED'), r."targetDate" NULLS LAST, r."requestNo" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('requestNo', 'Request'), col('staff', 'Staff member'), col('customer', 'Customer'), col('service', 'Service'), col('status', 'Status'), col('submitted', 'Submitted', 'date'), col('target', 'Target date', 'date'), col('completed', 'Completed', 'date'), col('overdue', 'Overdue')],
        rows: rows.map((r) => ({
          resourceType: 'ServiceRequest', id: r.id, membershipId: r.assignedToId, requestNo: r.requestNo, staff: r.staff, customer: r.customer, service: r.service, statusKey: r.status, status: statusLabel(r.status),
          submitted: r.submittedAt ? localYmd(r.submittedAt, rc.timeZone) : null, target: r.targetDate ? localYmd(r.targetDate, rc.timeZone) : null, completed: r.completedAt ? localYmd(r.completedAt, rc.timeZone) : null,
          overdue: r.status !== 'COMPLETED' && r.targetDate && r.targetDate < rc.now ? 'Yes' : 'No',
        })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== branch performance
  const branches: ReportDefinition = {
    key: 'branch-performance',
    title: 'Branch performance',
    description: 'Requests handled per branch, and (for viewers of financial reports) revenue, collections and open balances.',
    permission: 'report.operational',
    category: 'OPERATIONS',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const names = await branchNames(tx, rc);
      const counts = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT r."branchId"::text AS id,
          (COUNT(*) FILTER (WHERE ${inPeriod(Prisma.sql`r."submittedAt"`, rc)}))::int AS submitted,
          (COUNT(*) FILTER (WHERE r."status" = 'COMPLETED' AND ${inPeriod(Prisma.sql`r."completedAt"`, rc)}))::int AS completed,
          ROUND((AVG(EXTRACT(EPOCH FROM (r."completedAt" - r."submittedAt")) / 3600.0) FILTER (WHERE r."status" = 'COMPLETED' AND r."submittedAt" IS NOT NULL AND ${inPeriod(Prisma.sql`r."completedAt"`, rc)}))::numeric, 1) AS avg_hours,
          (COUNT(*) FILTER (WHERE ${OPEN_SQL}))::int AS open,
          (COUNT(*) FILTER (WHERE ${OPEN_SQL} AND r."targetDate" < ${rc.now}))::int AS overdue
        FROM "service_requests" r WHERE r."tenantId" = ${rc.tenantId}::uuid AND r."deletedAt" IS NULL ${requestBranch(rc)} GROUP BY 1`;
      const scope = scopeOf(rc);
      const money$ = rc.viewer.financial;
      const revenue = money$ ? await metrics.revenue(tx, scope, rc.period.start, rc.period.end, 'branch') : [];
      const cash = money$ ? await metrics.collections(tx, scope, rc.period.start, rc.period.end, 'branch') : [];
      const open = money$
        ? await tx.$queryRaw<Array<{ id: string; outstanding: Prisma.Decimal }>>`
            SELECT i."branchId"::text AS id, COALESCE(SUM(i."balanceDue"), 0) AS outstanding FROM "invoices" i
            WHERE i."tenantId" = ${rc.tenantId}::uuid AND i."status" IN ('ISSUED', 'PARTIALLY_PAID') ${branchSql(Prisma.sql`i."branchId"`, rc.branchIds)} GROUP BY 1`
        : [];
      const rows: ReportRow[] = [...names.entries()].map(([id, name]) => {
        const c = counts.find((x) => x.id === id);
        const base: ReportRow = { branchId: id, branch: name, requestsSubmitted: c?.submitted ?? 0, requestsCompleted: c?.completed ?? 0, avgProcessingHours: hours(c?.avg_hours), openRequests: c?.open ?? 0, overdueRequests: c?.overdue ?? 0 };
        if (!money$) return base;
        return { ...base, serviceFeeRevenue: money(revenue.find((r) => r.key === id)?.serviceFeeRevenue), grossCollections: money(cash.find((r) => r.key === id)?.grossCollections), outstanding: money(open.find((r) => r.id === id)?.outstanding) };
      });
      const columns: ReportColumn[] = [
        col('branch', 'Branch'), col('requestsSubmitted', 'Requests submitted', 'number'), col('requestsCompleted', 'Requests completed', 'number'), col('avgProcessingHours', 'Average processing time (hours)', 'number'),
        col('openRequests', 'Open requests now', 'number'), col('overdueRequests', 'Overdue requests now', 'number'),
        ...(money$ ? [col('serviceFeeRevenue', 'Earned service revenue', 'money'), col('grossCollections', 'Gross collections (cash)', 'money'), col('outstanding', 'Open balance now', 'money')] : []),
      ];
      return {
        columns,
        rows,
        totals: {
          branch: 'Total', requestsSubmitted: intTotal(rows, 'requestsSubmitted'), requestsCompleted: intTotal(rows, 'requestsCompleted'), avgProcessingHours: null, openRequests: intTotal(rows, 'openRequests'), overdueRequests: intTotal(rows, 'overdueRequests'),
          ...(money$ ? { serviceFeeRevenue: moneyTotal(rows, 'serviceFeeRevenue'), grossCollections: moneyTotal(rows, 'grossCollections'), outstanding: moneyTotal(rows, 'outstanding') } : {}),
        },
        chart: { type: 'bar', x: 'branch', series: [{ key: 'requestsCompleted', label: 'Requests completed' }, ...(money$ ? [{ key: 'serviceFeeRevenue', label: 'Earned service revenue' }] : [])] },
        notes: [
          'Requests are counted by the date they were submitted / completed. Processing time runs from submission to completion. Open and overdue requests are as of now.',
          ...(money$ ? [BASIS.revenue, BASIS.collections, BASIS.passThrough, BASIS.tax] : ['Amounts are shown only to people who may view financial reports.']),
          timeNote(rc),
        ],
      };
    },
  };

  // ====================================================================== customer growth
  const growth: ReportDefinition = {
    key: 'customer-growth',
    title: 'Customer growth',
    description: 'New customers per month and the size of the customer base.',
    permission: 'report.operational',
    category: 'CUSTOMERS',
    parameters: [...PERIOD_PARAMETERS, { key: 'month', label: 'Month', type: 'month', drilldownOnly: true }],
    branchScoped: false,
    defaultPeriod: (today: string) => ({ from: addMonths(firstOfMonth(today), -11), to: today }),
    async run(tx, rc): Promise<ReportOutput> {
      const live = Prisma.sql`c."tenantId" = ${rc.tenantId}::uuid AND c."deletedAt" IS NULL AND c."status" <> 'MERGED'`;
      const before = await tx.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM "customers" c WHERE ${live} AND c."createdAt" < ${rc.period.start}`;
      const months = await tx.$queryRaw<Array<{ month: string; n: number; individuals: number; businesses: number }>>`
        SELECT ${localMonthSql(Prisma.sql`c."createdAt"`, rc.timeZone)} AS month, COUNT(*)::int AS n,
               (COUNT(*) FILTER (WHERE c."type" = 'INDIVIDUAL'))::int AS individuals, (COUNT(*) FILTER (WHERE c."type" = 'BUSINESS'))::int AS businesses
        FROM "customers" c WHERE ${live} AND ${inPeriod(Prisma.sql`c."createdAt"`, rc)} GROUP BY 1`;
      let running = before[0]?.n ?? 0;
      const rows: ReportRow[] = eachMonth(rc.period.from, rc.period.to).map((month) => {
        const m = months.find((x) => x.month === month);
        const previous = running;
        running += m?.n ?? 0;
        return { month, newCustomers: m?.n ?? 0, individuals: m?.individuals ?? 0, businesses: m?.businesses ?? 0, totalCustomers: running, growth: percent(m?.n ?? 0, previous) };
      });
      return {
        columns: [col('month', 'Month'), col('newCustomers', 'New customers', 'number'), col('individuals', 'Individuals', 'number'), col('businesses', 'Businesses', 'number'), col('totalCustomers', 'Customers at month end', 'number'), col('growth', 'Growth', 'percent')],
        rows,
        totals: { month: 'Total', newCustomers: intTotal(rows, 'newCustomers'), individuals: intTotal(rows, 'individuals'), businesses: intTotal(rows, 'businesses'), totalCustomers: running, growth: percent(intTotal(rows, 'newCustomers'), before[0]?.n ?? 0) },
        chart: { type: 'line', x: 'month', series: [{ key: 'totalCustomers', label: 'Customers' }, { key: 'newCustomers', label: 'New customers' }] },
        notes: [
          'Customers are counted by the date their record was created. Deleted records and records merged into another customer are not counted; archived customers are.',
          'Customers belong to the centre, not to a branch: this report always covers the whole centre.',
          'Growth = new customers of the month as a percentage of the customers at the start of the month.',
          timeNote(rc),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const month = rc.filters.month;
      const p = month ? makePeriod(`${month}-01` < rc.period.from ? rc.period.from : `${month}-01`, lastOfMonth(`${month}-01`) > rc.period.to ? rc.period.to : lastOfMonth(`${month}-01`), rc.timeZone) : rc.period;
      const where = { tenantId: rc.tenantId, deletedAt: null, status: { not: 'MERGED' as const }, createdAt: { gte: p.start, lt: p.end } };
      const [rows, total] = [await tx.customer.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take, select: { id: true, customerNo: true, fullName: true, type: true, status: true, createdAt: true } }), await tx.customer.count({ where })];
      return {
        columns: [col('customerNo', 'Customer number'), ...(rc.viewer.customerNames ? [col('name', 'Name')] : []), col('type', 'Type'), col('status', 'Status'), col('created', 'Registered', 'date')],
        rows: rows.map((c) => ({ resourceType: 'Customer', id: c.id, customerNo: c.customerNo, ...(rc.viewer.customerNames ? { name: c.fullName } : {}), type: c.type, status: c.status, created: localYmd(c.createdAt, rc.timeZone) })),
        total,
      };
    },
  };

  // ====================================================================== expiry reminders
  const reminders: ReportDefinition = {
    key: 'expiry-reminders',
    title: 'Expiry reminders',
    description: 'Documents that expire soon, and the expiry reminders that were sent in the period.',
    permission: 'report.operational',
    category: 'CUSTOMERS',
    parameters: [
      ...PERIOD_PARAMETERS, { key: 'withinDays', label: 'Upcoming: days ahead', type: 'number' }, { key: 'kind', label: 'List', type: 'enum', options: ['upcoming', 'sent'], drilldownOnly: true },
      { key: 'documentTypeKey', label: 'Document type', type: 'text', drilldownOnly: true },
    ],
    branchScoped: false,
    async run(tx, rc): Promise<ReportOutput> {
      const within = rc.filters.withinDays ?? 30;
      const until = addDays(rc.today, within);
      const upcoming = await tx.$queryRaw<Array<{ key: string; n: number; renewals: number }>>`
        SELECT s."documentTypeKey" AS key, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE s."renewalRequestId" IS NOT NULL))::int AS renewals
        FROM "reminder_schedules" s
        WHERE s."tenantId" = ${rc.tenantId}::uuid AND s."status" IN ('ACTIVE', 'PAUSED') AND s."expiryDate" >= ${rc.today}::date AND s."expiryDate" <= ${until}::date GROUP BY 1`;
      const sent = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT s."documentTypeKey" AS key,
          (COUNT(*) FILTER (WHERE d."status" = 'SENT'))::int AS sent, (COUNT(*) FILTER (WHERE d."status" = 'SKIPPED_NO_CONSENT'))::int AS no_consent,
          (COUNT(*) FILTER (WHERE d."status" = 'SKIPPED_OPT_OUT'))::int AS opt_out, (COUNT(*) FILTER (WHERE d."status" = 'FAILED'))::int AS failed
        FROM "reminder_dispatches" d JOIN "reminder_schedules" s ON s."id" = d."scheduleId"
        WHERE d."tenantId" = ${rc.tenantId}::uuid AND ${inPeriod(Prisma.sql`d."processedAt"`, rc)} GROUP BY 1`;
      const keys = [...new Set([...upcoming.map((u) => u.key), ...sent.map((s) => s.key)])];
      const types = keys.length ? await tx.documentType.findMany({ where: { key: { in: keys }, OR: [{ tenantId: rc.tenantId }, { tenantId: null }] }, select: { key: true, tenantId: true, name: true } }) : [];
      const nameOf = (key: string) => types.find((x) => x.key === key && x.tenantId !== null)?.name ?? types.find((x) => x.key === key)?.name ?? key;
      const rows: ReportRow[] = keys
        .map((key) => {
          const u = upcoming.find((x) => x.key === key);
          const s = sent.find((x) => x.key === key);
          return { documentTypeKey: key, documentType: nameOf(key), upcoming: u?.n ?? 0, renewalsStarted: u?.renewals ?? 0, remindersSent: s?.sent ?? 0, skippedNoConsent: s?.no_consent ?? 0, skippedOptOut: s?.opt_out ?? 0, failed: s?.failed ?? 0 };
        })
        .sort((a, b) => b.upcoming - a.upcoming || String(a.documentType).localeCompare(String(b.documentType)));
      return {
        columns: [
          col('documentType', 'Document type'), col('upcoming', `Expiring in the next ${within} days`, 'number'), col('renewalsStarted', 'Of these, renewal started', 'number'), col('remindersSent', 'Reminders sent in the period', 'number'),
          col('skippedNoConsent', 'Not sent: no consent', 'number'), col('skippedOptOut', 'Not sent: opted out', 'number'), col('failed', 'Failed', 'number'),
        ],
        rows,
        totals: { documentType: 'Total', upcoming: intTotal(rows, 'upcoming'), renewalsStarted: intTotal(rows, 'renewalsStarted'), remindersSent: intTotal(rows, 'remindersSent'), skippedNoConsent: intTotal(rows, 'skippedNoConsent'), skippedOptOut: intTotal(rows, 'skippedOptOut'), failed: intTotal(rows, 'failed') },
        chart: { type: 'bar', x: 'documentType', series: [{ key: 'upcoming', label: 'Expiring soon' }, { key: 'remindersSent', label: 'Reminders sent' }] },
        notes: [
          `"Expiring" counts tracked documents (active or paused reminder schedules) whose expiry date lies between today (${rc.today}) and ${until}; it does not depend on the report period.`,
          'Reminder figures count the reminders handled in the report period. A reminder is not sent without the customer\'s consent to reminders or when every channel is opted out.',
          'Expiry dates are the dates on record at the centre. Reminders belong to the centre, not to a branch.',
          timeNote(rc),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const type = rc.filters.documentTypeKey;
      if (rc.filters.kind === 'sent') {
        const rows = await tx.$queryRaw<Array<Record<string, any>>>`
          SELECT d."id", d."scheduleId", d."offsetDays", d."status", d."processedAt", s."documentTypeKey", s."expiryDate", s."customerId", ${customerLabelSql(rc)} AS customer, COUNT(*) OVER ()::int AS full_count
          FROM "reminder_dispatches" d JOIN "reminder_schedules" s ON s."id" = d."scheduleId" LEFT JOIN "customers" cu ON cu."id" = s."customerId"
          WHERE d."tenantId" = ${rc.tenantId}::uuid AND ${inPeriod(Prisma.sql`d."processedAt"`, rc)} AND d."status" <> 'PENDING' ${type ? Prisma.sql`AND s."documentTypeKey" = ${type}` : Prisma.empty}
          ORDER BY d."processedAt", d."id" OFFSET ${page.skip} LIMIT ${page.take}`;
        return {
          columns: [col('date', 'Handled', 'date'), col('customer', 'Customer'), col('documentTypeKey', 'Document type'), col('expiryDate', 'Expiry date', 'date'), col('offsetDays', 'Days before expiry', 'number'), col('status', 'Outcome')],
          rows: rows.map((r) => ({ resourceType: 'ReminderSchedule', id: r.scheduleId, customerId: r.customerId, date: localYmd(r.processedAt, rc.timeZone), customer: r.customer ?? null, documentTypeKey: r.documentTypeKey, expiryDate: (r.expiryDate as Date).toISOString().slice(0, 10), offsetDays: r.offsetDays, status: r.status })),
          total: rows[0]?.full_count ?? 0,
        };
      }
      const until = addDays(rc.today, rc.filters.withinDays ?? 30);
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT s."id", s."documentTypeKey", s."expiryDate", s."status"::text AS status, s."customerId", s."corporateAccountId", s."renewalRequestId", ${customerLabelSql(rc)} AS customer, ca."companyName" AS company,
               (s."expiryDate" - ${rc.today}::date)::int AS days_left, COUNT(*) OVER ()::int AS full_count
        FROM "reminder_schedules" s LEFT JOIN "customers" cu ON cu."id" = s."customerId" LEFT JOIN "corporate_accounts" ca ON ca."id" = s."corporateAccountId"
        WHERE s."tenantId" = ${rc.tenantId}::uuid AND s."status" IN ('ACTIVE', 'PAUSED') AND s."expiryDate" >= ${rc.today}::date AND s."expiryDate" <= ${until}::date ${type ? Prisma.sql`AND s."documentTypeKey" = ${type}` : Prisma.empty}
        ORDER BY s."expiryDate", s."id" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('expiryDate', 'Expiry date', 'date'), col('daysLeft', 'Days left', 'number'), col('customer', 'Customer'), col('company', 'Company'), col('documentTypeKey', 'Document type'), col('status', 'Reminder'), col('renewalStarted', 'Renewal started')],
        rows: rows.map((r) => ({
          resourceType: 'ReminderSchedule', id: r.id, customerId: r.customerId, corporateAccountId: r.corporateAccountId, renewalRequestId: r.renewalRequestId, expiryDate: (r.expiryDate as Date).toISOString().slice(0, 10), daysLeft: r.days_left,
          customer: r.customer ?? null, company: r.company ?? null, documentTypeKey: r.documentTypeKey, status: r.status, renewalStarted: r.renewalRequestId ? 'Yes' : 'No',
        })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== document processing time
  const completedSql = (rc: ReportContext, serviceId?: string) => Prisma.sql`
    WITH done AS (
      SELECT r."id", r."serviceId", r."requestNo", r."customerId", r."submittedAt", r."completedAt", EXTRACT(EPOCH FROM (r."completedAt" - r."submittedAt")) / 3600.0 AS total_hours
      FROM "service_requests" r
      WHERE r."tenantId" = ${rc.tenantId}::uuid AND r."deletedAt" IS NULL AND r."status" = 'COMPLETED' AND r."submittedAt" IS NOT NULL AND ${inPeriod(Prisma.sql`r."completedAt"`, rc)} ${requestBranch(rc)}
        ${serviceId ? Prisma.sql`AND r."serviceId" = ${serviceId}::uuid` : Prisma.empty}
    ), hist AS (
      SELECT h."requestId", h."toStatus"::text AS to_status, h."createdAt" AS at,
             LEAD(h."createdAt") OVER (PARTITION BY h."requestId" ORDER BY h."createdAt", NULLIF(h."meta" ->> 'seq', '')::int NULLS LAST) AS next_at
      FROM "request_status_history" h JOIN done d ON d."id" = h."requestId"
      WHERE h."tenantId" = ${rc.tenantId}::uuid AND h."fromStatus" IS DISTINCT FROM h."toStatus"
    ), verification AS (
      SELECT "requestId", SUM(EXTRACT(EPOCH FROM (next_at - at)) / 3600.0) AS hours FROM hist WHERE to_status = 'UNDER_REVIEW' AND next_at IS NOT NULL GROUP BY 1
    )`;
  const processing: ReportDefinition = {
    key: 'document-processing-time',
    title: 'Document processing time',
    description: 'How long completed requests took from submission to completion, and how much of that was document verification, per service.',
    permission: 'report.operational',
    category: 'OPERATIONS',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'serviceId', label: 'Service', type: 'service', drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      // The fraction is a literal chosen here, never input: PERCENTILE_CONT cannot take it as an untyped parameter.
      const pct = (p: 0.5 | 0.9, column: Prisma.Sql) => Prisma.sql`ROUND((PERCENTILE_CONT(${Prisma.raw(p === 0.5 ? '0.5' : '0.9')}) WITHIN GROUP (ORDER BY (${column})::float8))::numeric, 1)`;
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        ${completedSql(rc)}
        SELECT d."serviceId"::text AS service_id, (GROUPING(d."serviceId") = 1) AS is_total, COUNT(*)::int AS n,
               ROUND(AVG(d.total_hours)::numeric, 1) AS avg_hours, ${pct(0.5, Prisma.sql`d.total_hours`)} AS p50, ${pct(0.9, Prisma.sql`d.total_hours`)} AS p90,
               ROUND(AVG(v.hours)::numeric, 1) AS v_avg, ${pct(0.5, Prisma.sql`v.hours`)} AS v_p50, ${pct(0.9, Prisma.sql`v.hours`)} AS v_p90
        FROM done d LEFT JOIN verification v ON v."requestId" = d."id"
        GROUP BY ROLLUP (d."serviceId")`;
      const names = await serviceNames(tx, rc, rows.map((r) => r.service_id));
      const cells = (r: Record<string, any>) => ({ completed: r.n, avgHours: hours(r.avg_hours), medianHours: hours(r.p50), p90Hours: hours(r.p90), avgVerificationHours: hours(r.v_avg), medianVerificationHours: hours(r.v_p50), p90VerificationHours: hours(r.v_p90) });
      const out: ReportRow[] = rows
        .filter((r) => !r.is_total)
        .map((r) => ({ serviceId: r.service_id, service: names.get(r.service_id)?.name ?? 'Deleted service', ...cells(r) }))
        .sort((a, b) => Number(b.completed) - Number(a.completed) || String(a.service).localeCompare(String(b.service)));
      const total = rows.find((r) => r.is_total);
      return {
        columns: [
          col('service', 'Service'), col('completed', 'Requests completed', 'number'), col('avgHours', 'Average (hours)', 'number'), col('medianHours', 'Median (hours)', 'number'), col('p90Hours', '90th percentile (hours)', 'number'),
          col('avgVerificationHours', 'Verification: average (hours)', 'number'), col('medianVerificationHours', 'Verification: median (hours)', 'number'), col('p90VerificationHours', 'Verification: 90th percentile (hours)', 'number'),
        ],
        rows: out,
        totals: total && total.n > 0 ? { service: 'All services', ...cells(total) } : { service: 'All services', completed: 0, avgHours: null, medianHours: null, p90Hours: null, avgVerificationHours: null, medianVerificationHours: null, p90VerificationHours: null },
        chart: { type: 'bar', x: 'service', series: [{ key: 'medianHours', label: 'Median hours to complete' }, { key: 'medianVerificationHours', label: 'Median hours in verification' }] },
        notes: [
          'Requests completed in the period. Processing time is the elapsed time from submission to completion in hours (calendar time, including waiting for the customer, for payment and for authorities).',
          'Verification time is the total time a request spent in the status "Documents under review", from the status history; requests that never were in that status are left out of the verification figures.',
          'The 90th percentile is the time within which 9 out of 10 requests were finished. The totals row is computed over all requests, not as an average of the rows.',
          timeNote(rc),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        ${completedSql(rc, rc.filters.serviceId)}
        SELECT d."id", d."requestNo", d."serviceId", d."submittedAt", d."completedAt", ROUND(d.total_hours::numeric, 1) AS total_hours, ROUND(v.hours::numeric, 1) AS verification_hours, s."name" AS service,
               ${customerLabelSql(rc)} AS customer, COUNT(*) OVER ()::int AS full_count
        FROM done d LEFT JOIN verification v ON v."requestId" = d."id" JOIN "services" s ON s."id" = d."serviceId" JOIN "customers" cu ON cu."id" = d."customerId"
        ORDER BY d.total_hours DESC, d."requestNo" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('requestNo', 'Request'), col('customer', 'Customer'), col('service', 'Service'), col('submitted', 'Submitted', 'date'), col('completed', 'Completed', 'date'), col('totalHours', 'Hours to complete', 'number'), col('verificationHours', 'Hours in verification', 'number')],
        rows: rows.map((r) => ({ resourceType: 'ServiceRequest', id: r.id, serviceId: r.serviceId, requestNo: r.requestNo, customer: r.customer, service: r.service, submitted: localYmd(r.submittedAt, rc.timeZone), completed: localYmd(r.completedAt, rc.timeZone), totalHours: hours(r.total_hours), verificationHours: hours(r.verification_hours) })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  // ====================================================================== customer satisfaction
  /** Feedback alias `f`. With a branch scope only feedback about a request of those branches counts. */
  const feedbackWhere = (rc: ReportContext) => Prisma.sql`
    f."tenantId" = ${rc.tenantId}::uuid AND ${inPeriod(Prisma.sql`f."createdAt"`, rc)}
    ${rc.branchIds ? Prisma.sql`AND EXISTS (SELECT 1 FROM "service_requests" r WHERE r."id" = f."requestId" AND r."branchId"::text = ANY(${rc.branchIds}))` : Prisma.empty}`;
  const satisfaction: ReportDefinition = {
    key: 'customer-satisfaction',
    title: 'Customer satisfaction',
    description: 'Ratings customers gave after a completed request or a resolved support ticket: average and distribution.',
    permission: 'report.operational',
    category: 'CUSTOMERS',
    parameters: [...PERIOD_PARAMETERS, BRANCH_PARAMETER, { key: 'rating', label: 'Rating', type: 'number', drilldownOnly: true }],
    branchScoped: true,
    async run(tx, rc): Promise<ReportOutput> {
      const counts = await tx.$queryRaw<Array<{ rating: number; n: number; requests: number; tickets: number }>>`
        SELECT f."rating"::int AS rating, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE f."requestId" IS NOT NULL))::int AS requests, (COUNT(*) FILTER (WHERE f."ticketId" IS NOT NULL))::int AS tickets
        FROM "customer_feedback" f WHERE ${feedbackWhere(rc)} GROUP BY 1`;
      const total = counts.reduce((n, c) => n + c.n, 0);
      const weighted = counts.reduce((n, c) => n + c.n * c.rating, 0);
      const rows: ReportRow[] = [5, 4, 3, 2, 1].map((rating) => {
        const c = counts.find((x) => x.rating === rating);
        return { ratingValue: rating, rating: `${rating} ${rating === 1 ? 'star' : 'stars'}`, count: c?.n ?? 0, share: percent(c?.n ?? 0, total), aboutRequests: c?.requests ?? 0, aboutTickets: c?.tickets ?? 0 };
      });
      const average = total ? D(weighted).div(total).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber() : null;
      const satisfied = rows.filter((r) => Number(r.ratingValue) >= 4).reduce((n, r) => n + Number(r.count), 0);
      return {
        columns: [col('rating', 'Rating'), col('count', 'Ratings', 'number'), col('share', 'Share', 'percent'), col('aboutRequests', 'About a request', 'number'), col('aboutTickets', 'About a support ticket', 'number')],
        rows,
        totals: { rating: average === null ? 'No ratings' : `Average ${average.toFixed(2)} of 5`, count: total, share: total ? 100 : null, aboutRequests: intTotal(rows, 'aboutRequests'), aboutTickets: intTotal(rows, 'aboutTickets'), average, satisfiedShare: percent(satisfied, total) },
        chart: { type: 'pie', x: 'rating', series: [{ key: 'count', label: 'Ratings' }] },
        notes: [
          'Ratings (1-5) given in the period. `average` and `satisfiedShare` (4 or 5 stars) are in the totals.',
          ...(rc.branchIds ? ['Limited to a branch: only ratings of requests of that branch are counted. Ratings of support tickets have no branch and are left out.'] : []),
          timeNote(rc),
        ],
      };
    },
    async drilldown(tx, rc, page) {
      const rows = await tx.$queryRaw<Array<Record<string, any>>>`
        SELECT f."id", f."rating"::int AS rating, f."comment", f."createdAt", f."requestId", f."ticketId", f."customerId", r."requestNo", ${customerLabelSql(rc)} AS customer, COUNT(*) OVER ()::int AS full_count
        FROM "customer_feedback" f JOIN "customers" cu ON cu."id" = f."customerId" LEFT JOIN "service_requests" r ON r."id" = f."requestId"
        WHERE ${feedbackWhere(rc)} ${rc.filters.rating ? Prisma.sql`AND f."rating" = ${rc.filters.rating}` : Prisma.empty}
        ORDER BY f."createdAt" DESC, f."id" OFFSET ${page.skip} LIMIT ${page.take}`;
      return {
        columns: [col('date', 'Date', 'date'), col('rating', 'Rating', 'number'), col('about', 'About'), col('customer', 'Customer'), col('requestNo', 'Request'), col('comment', 'Comment')],
        rows: rows.map((r) => ({ resourceType: 'CustomerFeedback', id: r.id, requestId: r.requestId, ticketId: r.ticketId, customerId: r.customerId, date: localYmd(r.createdAt, rc.timeZone), rating: r.rating, about: r.requestId ? 'Request' : 'Support ticket', customer: r.customer, requestNo: r.requestNo ?? null, comment: r.comment ?? null })),
        total: rows[0]?.full_count ?? 0,
      };
    },
  };

  return [byStatus, staff, branches, growth, reminders, processing, satisfaction];
}
