import { Injectable } from '@nestjs/common';
import { REQUEST_STATUS_META, STATUS_BUCKETS } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import type { DashboardQuery, DashboardTrendsQuery } from '@typease/validation';
import { can, ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { BASIS, branchSql, FinanceMetrics, localDaySql, MoneyScope } from '../reports/finance-metrics.service';
import { addDays, daysBetween, eachDay, firstOfMonth, localYmd, period, Period, safeTimeZone } from '../reports/time';

const UPCOMING_EXPIRY_DAYS = 30;
const RECENT_ACTIVITY_ROWS = 15;
const UPCOMING_EXPIRY_ROWS = 10;
const WORKLOAD_ROWS = 50;
const TREND_DEFAULT_DAYS = 30;
const TREND_MAX_DAYS = 366;
const OPEN_SQL = Prisma.sql`r."status" NOT IN ('DRAFT', 'COMPLETED', 'CANCELLED')`;

type RequestScope = 'ALL' | 'ASSIGNED' | 'NONE';
interface Scope {
  tenantId: string;
  timeZone: string;
  currency: string;
  now: Date;
  today: string;
  /** null = every branch. */
  branchIds: string[] | null;
  requests: RequestScope;
  membershipId: string | null;
  /** May see invoice-based figures. */
  finance: boolean;
  /** Invoice-based figures are limited to the viewer's own cases. */
  financeOwnCases: boolean;
  /** May see cash figures (payments and refunds). */
  cash: boolean;
  customerNames: boolean;
  reminders: boolean;
}
const fmt = (v: Prisma.Decimal) => v.toFixed(2);

/**
 * The centre dashboard. Every widget is a query over the live tables, scoped
 * like the lists behind it:
 *   - to the tenant (row-level security plus an explicit tenant filter),
 *   - to the branches the viewer may see (or the one they asked for),
 *   - for operators limited to assigned requests, to their own cases.
 * A widget the viewer has no permission for is `null`, never a zero.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: TenantDb,
    private readonly metrics: FinanceMetrics,
  ) {}

  private async scope(tx: Tx, branchId: string | undefined): Promise<Scope> {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true, defaultCurrency: true } });
    const timeZone = safeTimeZone(tenant.timezone);
    let branchIds: string[] | null;
    if (branchId) {
      found(await tx.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } }), 'Branch');
      assertBranchAccess(branchId);
      branchIds = [branchId];
    } else branchIds = branchFilter()?.in ?? null;

    const requests: RequestScope = can('request.read.all') ? 'ALL' : can('request.read.assigned') && c.membershipId ? 'ASSIGNED' : 'NONE';
    const fullFinance = can('report.financial');
    const finance = fullFinance || can('invoice.read');
    // The finance module shows operators only the invoices of their own cases: so does the dashboard.
    const financeOwnCases = finance && !fullFinance && !can('request.read.all') && can('request.read.assigned') && !!c.membershipId;
    const now = new Date();
    return {
      tenantId, timeZone, currency: tenant.defaultCurrency, now, today: localYmd(now, timeZone), branchIds, requests, membershipId: c.membershipId ?? null,
      finance, financeOwnCases, cash: fullFinance || (can('payment.read') && finance && !financeOwnCases),
      customerNames: can('customer.read'), reminders: can('reminder.read') || can('reminder.manage'),
    };
  }

  /** Requests alias `r`: tenant, not deleted, branches, and the viewer's own cases when they are limited to those. */
  private requestWhere(s: Scope): Prisma.Sql {
    return Prisma.sql`r."tenantId" = ${s.tenantId}::uuid AND r."deletedAt" IS NULL ${branchSql(Prisma.sql`r."branchId"`, s.branchIds)}
      ${s.requests === 'ASSIGNED' ? Prisma.sql`AND (r."assignedToId" = ${s.membershipId}::uuid OR r."reviewerId" = ${s.membershipId}::uuid)` : Prisma.empty}`;
  }
  private moneyScope(s: Scope): MoneyScope {
    return { tenantId: s.tenantId, branchIds: s.branchIds, timeZone: s.timeZone, assigneeId: s.financeOwnCases ? s.membershipId : null };
  }

  // ------------------------------------------------------------------ GET /dashboard
  async overview(query: DashboardQuery) {
    return this.db.tx(async (tx) => {
      const s = await this.scope(tx, query.branchId);
      // Only a start: up to today. Only an end: from the first day of that month.
      const range = query.from || query.to ? period(query.from ?? firstOfMonth(query.to!), query.to ?? (query.from! > s.today ? query.from! : s.today), s.timeZone) : null;
      if (range && range.from > range.to) throw Errors.unprocessable('INVALID_PERIOD', 'The start date must not be after the end date.');
      const today = period(s.today, s.today, s.timeZone);
      return {
        generatedAt: s.now.toISOString(),
        timeZone: s.timeZone,
        today: s.today,
        currency: s.currency,
        filters: { branchId: query.branchId ?? null, from: range?.from ?? null, to: range?.to ?? null },
        scope: { branchIds: s.branchIds, requests: s.requests, finance: !s.finance ? 'NONE' : s.financeOwnCases ? 'OWN_CASES' : 'ALL' },
        requests: s.requests === 'NONE' ? null : await this.requestCounts(tx, s, today, range),
        finance: s.finance ? await this.finance(tx, s, today, range) : null,
        staffWorkload: s.requests === 'NONE' ? null : await this.workload(tx, s),
        upcomingExpiries: s.reminders ? await this.expiries(tx, s) : null,
        recentActivity: s.requests === 'NONE' ? null : await this.activity(tx, s, range),
      };
    });
  }

  private async requestCounts(tx: Tx, s: Scope, today: Period, range: Period | null) {
    const inRange = range ? Prisma.sql`AND r."createdAt" >= ${range.start} AND r."createdAt" < ${range.end}` : Prisma.empty;
    const byStatus = await tx.$queryRaw<Array<{ status: string; n: number; overdue: number }>>`
      SELECT r."status"::text AS status, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE ${OPEN_SQL} AND r."targetDate" < ${s.now}))::int AS overdue
      FROM "service_requests" r WHERE ${this.requestWhere(s)} ${inRange} GROUP BY 1`;
    const count = (statuses: readonly string[]) => byStatus.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r.n, 0);
    const completed = await tx.$queryRaw<Array<{ today: number; in_range: number | null }>>`
      SELECT (COUNT(*) FILTER (WHERE r."completedAt" >= ${today.start} AND r."completedAt" < ${today.end}))::int AS today,
             ${range ? Prisma.sql`(COUNT(*) FILTER (WHERE r."completedAt" >= ${range.start} AND r."completedAt" < ${range.end}))::int` : Prisma.sql`NULL::int`} AS in_range
      FROM "service_requests" r WHERE ${this.requestWhere(s)} AND r."status" = 'COMPLETED'`;
    return {
      newRequests: count(STATUS_BUCKETS.newRequests),
      pendingVerification: count(STATUS_BUCKETS.pendingVerification),
      awaitingCustomer: count(STATUS_BUCKETS.awaitingCustomer),
      awaitingPayment: count(STATUS_BUCKETS.awaitingPayment),
      readyForProcessing: count(STATUS_BUCKETS.readyForProcessing),
      inProgress: count(STATUS_BUCKETS.inProgress),
      /** Completed today in the centre's time zone, whatever period is selected. */
      completedToday: completed[0]?.today ?? 0,
      overdue: byStatus.reduce((n, r) => n + r.overdue, 0),
      open: byStatus.filter((r) => !['DRAFT', 'COMPLETED', 'CANCELLED'].includes(r.status)).reduce((n, r) => n + r.n, 0),
      drafts: count(['DRAFT']),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      range: range ? { from: range.from, to: range.to, created: byStatus.reduce((n, r) => n + r.n, 0), completed: completed[0]?.in_range ?? 0 } : null,
    };
  }

  private async finance(tx: Tx, s: Scope, today: Period, range: Period | null) {
    const scope = this.moneyScope(s);
    const revenueToday = await this.metrics.revenueTotal(tx, scope, today.start, today.end);
    const cashToday = s.cash ? await this.metrics.collectionsTotal(tx, scope, today.start, today.end) : null;
    const open = await this.metrics.receivables(tx, scope);
    const revenueRange = range ? await this.metrics.revenueTotal(tx, scope, range.start, range.end) : null;
    const cashRange = range && s.cash ? await this.metrics.collectionsTotal(tx, scope, range.start, range.end) : null;
    return {
      /** Earned service fees of invoices issued today (accrual, net of discounts and credit notes, excluding tax). */
      serviceRevenueToday: fmt(revenueToday.serviceFeeRevenue),
      /** Government / third-party components the centre treats as revenue. Zero unless configured so. */
      otherRevenueToday: fmt(revenueToday.otherRevenue),
      taxInvoicedToday: fmt(revenueToday.tax),
      /** Payments minus refunds completed today (cash, all components). Not revenue. `null` without access to payments. */
      grossCollectionsToday: cashToday ? fmt(cashToday.grossCollections) : null,
      paymentsToday: cashToday ? fmt(cashToday.payments) : null,
      refundsToday: cashToday ? fmt(cashToday.refunds) : null,
      /** Open balances of issued invoices as of now. */
      outstandingReceivables: fmt(open.outstanding),
      openInvoices: open.invoices,
      range: range
        ? {
            from: range.from,
            to: range.to,
            serviceRevenue: fmt(revenueRange!.serviceFeeRevenue),
            otherRevenue: fmt(revenueRange!.otherRevenue),
            taxInvoiced: fmt(revenueRange!.tax),
            grossCollections: cashRange ? fmt(cashRange.grossCollections) : null,
          }
        : null,
      labels: {
        serviceRevenueToday: "Today's service revenue (earned service fees, excluding tax)",
        grossCollectionsToday: "Today's gross collections (cash received minus refunds, all fees and tax)",
        outstandingReceivables: 'Outstanding receivables (open invoice balances)',
      },
      notes: [BASIS.revenue, BASIS.collections, BASIS.passThrough, ...(s.financeOwnCases ? ['Limited to the invoices of the requests assigned to you.'] : [])],
    };
  }

  private async workload(tx: Tx, s: Scope) {
    const own = s.requests === 'ASSIGNED';
    const rows = await tx.$queryRaw<Array<Record<string, any>>>`
      WITH open AS (
        SELECT r."assignedToId" AS id, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE r."targetDate" < ${s.now}))::int AS overdue,
               (COUNT(*) FILTER (WHERE r."priority" IN ('HIGH', 'URGENT')))::int AS urgent
        FROM "service_requests" r
        WHERE r."tenantId" = ${s.tenantId}::uuid AND r."deletedAt" IS NULL AND r."assignedToId" IS NOT NULL AND ${OPEN_SQL} ${branchSql(Prisma.sql`r."branchId"`, s.branchIds)}
          ${own ? Prisma.sql`AND r."assignedToId" = ${s.membershipId}::uuid` : Prisma.empty}
        GROUP BY 1
      ), todo AS (
        SELECT ta."assigneeId" AS id, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE tk."dueAt" < ${s.now}))::int AS overdue
        FROM "task_assignments" ta JOIN "tasks" tk ON tk."id" = ta."taskId"
        WHERE ta."tenantId" = ${s.tenantId}::uuid AND ta."unassignedAt" IS NULL AND tk."status" IN ('OPEN', 'IN_PROGRESS')
          ${s.branchIds ? Prisma.sql`AND (tk."branchId" IS NULL OR tk."branchId"::text = ANY(${s.branchIds}))` : Prisma.empty}
          ${own ? Prisma.sql`AND ta."assigneeId" = ${s.membershipId}::uuid` : Prisma.empty}
        GROUP BY 1
      )
      SELECT m."id", u."fullName" AS name, ro."key" AS role_key, ro."name" AS role_name,
             COALESCE(open.n, 0) AS open_requests, COALESCE(open.overdue, 0) AS overdue_requests, COALESCE(open.urgent, 0) AS urgent_requests,
             COALESCE(todo.n, 0) AS open_tasks, COALESCE(todo.overdue, 0) AS overdue_tasks
      FROM "tenant_memberships" m JOIN "users" u ON u."id" = m."userId" JOIN "roles" ro ON ro."id" = m."roleId"
      LEFT JOIN open ON open.id = m."id" LEFT JOIN todo ON todo.id = m."id"
      WHERE m."tenantId" = ${s.tenantId}::uuid AND m."kind" = 'STAFF'
        AND ${own ? Prisma.sql`m."id" = ${s.membershipId}::uuid` : Prisma.sql`COALESCE(open.n, 0) + COALESCE(todo.n, 0) > 0`}
      ORDER BY open_requests DESC, open_tasks DESC, name LIMIT ${WORKLOAD_ROWS}`;
    const unassigned = own
      ? null
      : await tx.$queryRaw<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n FROM "service_requests" r
          WHERE r."tenantId" = ${s.tenantId}::uuid AND r."deletedAt" IS NULL AND r."assignedToId" IS NULL AND ${OPEN_SQL} ${branchSql(Prisma.sql`r."branchId"`, s.branchIds)}`;
    return {
      /** Open requests nobody is assigned to (`null` for viewers limited to their own cases). */
      unassignedRequests: unassigned ? (unassigned[0]?.n ?? 0) : null,
      staff: rows.map((r) => ({
        membershipId: r.id, name: r.name, roleKey: r.role_key, roleName: r.role_name, openRequests: r.open_requests, overdueRequests: r.overdue_requests, highPriorityRequests: r.urgent_requests,
        openTasks: r.open_tasks, overdueTasks: r.overdue_tasks,
      })),
    };
  }

  private async expiries(tx: Tx, s: Scope) {
    const until = addDays(s.today, UPCOMING_EXPIRY_DAYS);
    const where = { tenantId: s.tenantId, status: { in: ['ACTIVE' as const, 'PAUSED' as const] }, expiryDate: { gte: new Date(`${s.today}T00:00:00.000Z`), lte: new Date(`${until}T00:00:00.000Z`) } };
    const [total, rows] = [
      await tx.reminderSchedule.count({ where }),
      await tx.reminderSchedule.findMany({
        where, orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }], take: UPCOMING_EXPIRY_ROWS,
        select: { id: true, documentTypeKey: true, subjectLabel: true, expiryDate: true, status: true, customerId: true, corporateAccountId: true, renewalRequestId: true, customer: { select: { fullName: true, customerNo: true } } },
      }),
    ];
    const keys = [...new Set(rows.map((r) => r.documentTypeKey))];
    const types = keys.length ? await tx.documentType.findMany({ where: { key: { in: keys }, OR: [{ tenantId: s.tenantId }, { tenantId: null }] }, select: { key: true, tenantId: true, name: true, nameAr: true } }) : [];
    const typeOf = (key: string) => types.find((t) => t.key === key && t.tenantId !== null) ?? types.find((t) => t.key === key);
    return {
      withinDays: UPCOMING_EXPIRY_DAYS,
      from: s.today,
      to: until,
      total,
      items: rows.map((r) => {
        const expiry = r.expiryDate.toISOString().slice(0, 10);
        return {
          scheduleId: r.id, documentTypeKey: r.documentTypeKey, documentTypeName: typeOf(r.documentTypeKey)?.name ?? r.documentTypeKey, documentTypeNameAr: typeOf(r.documentTypeKey)?.nameAr ?? null,
          expiryDate: expiry, daysLeft: daysBetween(s.today, expiry), status: r.status, customerId: r.customerId, corporateAccountId: r.corporateAccountId, renewalStarted: !!r.renewalRequestId,
          // The label of a tracked document usually is a person's name: only for viewers who may see customers.
          customerNo: r.customer?.customerNo ?? null, customerName: s.customerNames ? (r.customer?.fullName ?? null) : null, subjectLabel: s.customerNames ? r.subjectLabel : null,
        };
      }),
    };
  }

  private async activity(tx: Tx, s: Scope, range: Period | null) {
    const rows = await tx.$queryRaw<Array<Record<string, any>>>`
      SELECT h."id", h."requestId", h."fromStatus"::text AS from_status, h."toStatus"::text AS to_status, h."actorType"::text AS actor_type, h."createdAt", r."requestNo", r."branchId",
             s."name" AS service, cu."fullName" AS customer_name, cu."customerNo" AS customer_no, u."fullName" AS actor_name
      FROM "request_status_history" h
      JOIN "service_requests" r ON r."id" = h."requestId"
      JOIN "services" s ON s."id" = r."serviceId" JOIN "customers" cu ON cu."id" = r."customerId"
      LEFT JOIN "users" u ON u."id" = h."actorId" AND h."actorType" = 'STAFF'
      WHERE h."tenantId" = ${s.tenantId}::uuid AND h."fromStatus" IS DISTINCT FROM h."toStatus" AND ${this.requestWhere(s)}
        ${range ? Prisma.sql`AND h."createdAt" >= ${range.start} AND h."createdAt" < ${range.end}` : Prisma.empty}
      ORDER BY h."createdAt" DESC, NULLIF(h."meta" ->> 'seq', '')::int DESC NULLS LAST, h."id" LIMIT ${RECENT_ACTIVITY_ROWS}`;
    return rows.map((r) => ({
      id: r.id, requestId: r.requestId, requestNo: r.requestNo, branchId: r.branchId, serviceName: r.service,
      from: r.from_status, to: r.to_status, toLabel: REQUEST_STATUS_META[r.to_status as RequestStatus] ? { en: REQUEST_STATUS_META[r.to_status as RequestStatus].en, ar: REQUEST_STATUS_META[r.to_status as RequestStatus].ar } : null,
      at: (r.createdAt as Date).toISOString(), actorType: r.actor_type, actorName: r.actor_name ?? null,
      customerNo: r.customer_no, customerName: s.customerNames ? r.customer_name : null,
    }));
  }

  // ------------------------------------------------------------------ GET /dashboard/trends
  async trends(query: DashboardTrendsQuery) {
    return this.db.tx(async (tx) => {
      const s = await this.scope(tx, query.branchId);
      const to = query.to ?? (query.from && query.from > s.today ? query.from : s.today);
      const from = query.from ?? addDays(to, -(TREND_DEFAULT_DAYS - 1));
      if (from > to) throw Errors.unprocessable('INVALID_PERIOD', 'The start date must not be after the end date.');
      if (daysBetween(from, to) + 1 > TREND_MAX_DAYS) throw Errors.unprocessable('PERIOD_TOO_LONG', `Trends cover at most ${TREND_MAX_DAYS} days. Choose a shorter period.`, { maxDays: TREND_MAX_DAYS });
      const p = period(from, to, s.timeZone);
      const day = (column: Prisma.Sql) => localDaySql(column, s.timeZone);

      const created = s.requests === 'NONE' ? null : await tx.$queryRaw<Array<{ day: string; n: number }>>`
        SELECT ${day(Prisma.sql`r."createdAt"`)} AS day, COUNT(*)::int AS n FROM "service_requests" r
        WHERE ${this.requestWhere(s)} AND r."createdAt" >= ${p.start} AND r."createdAt" < ${p.end} GROUP BY 1`;
      const completed = s.requests === 'NONE' ? null : await tx.$queryRaw<Array<{ day: string; n: number }>>`
        SELECT ${day(Prisma.sql`r."completedAt"`)} AS day, COUNT(*)::int AS n FROM "service_requests" r
        WHERE ${this.requestWhere(s)} AND r."status" = 'COMPLETED' AND r."completedAt" >= ${p.start} AND r."completedAt" < ${p.end} GROUP BY 1`;
      const revenue = s.finance ? await this.metrics.revenue(tx, this.moneyScope(s), p.start, p.end, 'day') : null;
      const cash = s.cash ? await this.metrics.collections(tx, this.moneyScope(s), p.start, p.end, 'day') : null;
      return {
        generatedAt: s.now.toISOString(),
        timeZone: s.timeZone,
        currency: s.currency,
        from,
        to,
        filters: { branchId: query.branchId ?? null },
        scope: { branchIds: s.branchIds, requests: s.requests, finance: !s.finance ? 'NONE' : s.financeOwnCases ? 'OWN_CASES' : 'ALL' },
        days: eachDay(from, to).map((d) => ({
          date: d,
          requestsCreated: created ? (created.find((x) => x.day === d)?.n ?? 0) : null,
          requestsCompleted: completed ? (completed.find((x) => x.day === d)?.n ?? 0) : null,
          /** Earned service fees (accrual). `null` without access to financial figures. */
          serviceRevenue: revenue ? fmt(revenue.find((x) => x.key === d)?.serviceFeeRevenue ?? new Prisma.Decimal(0)) : null,
          /** Cash received minus refunds. `null` without access to payments. */
          grossCollections: cash ? fmt(cash.find((x) => x.key === d)?.grossCollections ?? new Prisma.Decimal(0)) : null,
        })),
        notes: s.finance ? [BASIS.revenue, ...(s.cash ? [BASIS.collections] : [])] : [],
      };
    });
  }
}
