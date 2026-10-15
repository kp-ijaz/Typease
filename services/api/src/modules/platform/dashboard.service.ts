import { Injectable } from '@nestjs/common';
import type { FailedPaymentsQuery, PlatformPeriodQuery, TenantGrowthQuery } from '@typease/validation';
import { Prisma, SystemDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { D, pageResult } from '../../common/pagination';
import { periodKey } from '../../common/usage.service';
import { SystemHealthService } from './health.service';
import { buckets, churn, growthSeries, planDistribution, recurringRevenue, RecurringSubscription, SubscriptionHistory } from './metrics.calc';
import { dayEndExclusive, dayStart, resolvePeriod } from './platform.util';
import { PlatformTenantsService } from './tenants.service';

const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
const fixed = (v: Prisma.Decimal | null | undefined, places = 2) => D(v).toFixed(places);

/**
 * Platform dashboard and SaaS reports (spec sections 8 and 26). Every number
 * comes from a query on real rows; the arithmetic (MRR normalisation, churn,
 * time buckets) lives in metrics.calc.ts.
 *
 * Only platform-level tables are read: tenants, subscriptions and their
 * invoices / events, usage counters, AI usage logs, notification deliveries
 * (counts only) and PLATFORM-scope support tickets. No customer, document or
 * request content of any centre.
 */
@Injectable()
export class PlatformDashboardService {
  constructor(
    private readonly sys: SystemDb,
    private readonly tenants: PlatformTenantsService,
    private readonly health: SystemHealthService,
  ) {}

  // ------------------------------------------------------------------ building blocks
  private async subscriptions(where: Prisma.SubscriptionWhereInput = {}): Promise<RecurringSubscription[]> {
    const rows = await this.sys.client.subscription.findMany({
      where,
      select: { status: true, billingCycle: true, couponEndsAt: true, plan: { select: { key: true, name: true, monthlyPrice: true, annualPrice: true, currency: true } }, coupon: { select: { percentOff: true, amountOff: true, currency: true } } },
    });
    return rows;
  }

  private async histories(): Promise<SubscriptionHistory[]> {
    const [subs, events] = await Promise.all([
      this.sys.client.subscription.findMany({ select: { id: true, createdAt: true, status: true } }),
      this.sys.client.subscriptionEvent.findMany({ where: { type: 'STATUS_CHANGED' }, orderBy: { createdAt: 'asc' }, select: { subscriptionId: true, createdAt: true, data: true } }),
    ]);
    const bySub = new Map<string, SubscriptionHistory>(subs.map((s) => [s.id, { id: s.id, createdAt: s.createdAt, currentStatus: s.status, changes: [] }]));
    for (const e of events) {
      const data = (e.data ?? {}) as { from?: string; to?: string };
      if (typeof data.from !== 'string' || typeof data.to !== 'string') continue;
      bySub.get(e.subscriptionId)?.changes.push({ at: e.createdAt, from: data.from, to: data.to });
    }
    return [...bySub.values()];
  }

  private async failedPaymentTotals() {
    const [openFailed, pastDue, grace] = await Promise.all([
      this.sys.client.subscriptionInvoice.groupBy({ by: ['currency'], where: { status: 'OPEN', attemptCount: { gt: 0 } }, _count: { _all: true }, _sum: { total: true } }),
      this.sys.client.subscription.count({ where: { status: 'PAST_DUE' } }),
      this.sys.client.subscription.count({ where: { status: 'GRACE' } }),
    ]);
    return {
      /** Open subscription invoices with at least one failed collection attempt. */
      openInvoices: openFailed.reduce((n, g) => n + g._count._all, 0),
      amounts: openFailed.map((g) => ({ currency: g.currency, total: fixed(g._sum.total) })),
      subscriptionsPastDue: pastDue,
      subscriptionsInGrace: grace,
    };
  }

  private async usageTotals(now: Date) {
    const month = periodKey(now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [storage, monthly, ai, deliveries] = await Promise.all([
      this.sys.client.usageRecord.aggregate({ where: { metric: 'storageBytes', periodKey: 'total' }, _sum: { quantity: true } }),
      this.sys.client.usageRecord.groupBy({ by: ['metric'], where: { periodKey: month, metric: { in: ['notifications', 'monthlyRequests', 'aiPages'] } }, _sum: { quantity: true } }),
      this.sys.client.aiUsageLog.groupBy({ by: ['currency'], where: { createdAt: { gte: monthStart } }, _sum: { costEstimate: true, pages: true }, _count: { _all: true } }),
      this.sys.client.$queryRaw<Array<{ channel: string; status: string; n: bigint }>>`
        SELECT n."channel"::text AS channel, d."status"::text AS status, count(*) AS n
        FROM "notification_deliveries" d JOIN "notifications" n ON n."id" = d."notificationId"
        WHERE d."requestedAt" >= ${monthStart} GROUP BY 1, 2`,
    ]);
    const metric = (name: string) => Number(monthly.find((m) => m.metric === name)?._sum.quantity ?? 0);
    const storageBytes = Number(storage._sum.quantity ?? 0);
    const channels: Record<string, { sent: number; failed: number }> = {};
    for (const row of deliveries) {
      const entry = (channels[row.channel] ??= { sent: 0, failed: 0 });
      if (row.status === 'FAILED') entry.failed += Number(row.n);
      else if (row.status === 'SENT' || row.status === 'DELIVERED') entry.sent += Number(row.n);
    }
    return {
      period: month,
      storage: { bytes: storageBytes, gigabytes: Number((storageBytes / 1024 ** 3).toFixed(3)) },
      notifications: { counted: metric('notifications'), deliveriesByChannel: channels },
      requests: metric('monthlyRequests'),
      ai: { pages: metric('aiPages'), calls: ai.reduce((n, a) => n + a._count._all, 0), cost: ai.map((a) => ({ currency: a.currency, estimate: fixed(a._sum.costEstimate, 4) })) },
    };
  }

  private async ticketsByStatus() {
    const rows = await this.sys.client.supportTicket.groupBy({ by: ['status'], where: { scope: 'PLATFORM' }, _count: { _all: true } });
    const out = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<(typeof TICKET_STATUSES)[number], number>;
    for (const r of rows) out[r.status] = r._count._all;
    return { byStatus: out, open: out.OPEN + out.IN_PROGRESS + out.WAITING_CUSTOMER, total: Object.values(out).reduce((a, b) => a + b, 0) };
  }

  // ------------------------------------------------------------------ dashboard
  /** `from` / `to` select the churn period (default: the last 30 days). Everything else is "as of now". */
  async dashboard(query: PlatformPeriodQuery) {
    const now = new Date();
    const { start, end } = resolvePeriod(query, 30, now);
    const [byStatus, subs, histories, failedPayments, usage, tickets, health] = await Promise.all([
      this.tenants.countByStatus(),
      this.subscriptions(),
      this.histories(),
      this.failedPaymentTotals(),
      this.usageTotals(now),
      this.ticketsByStatus(),
      this.health.health(),
    ]);
    const { churnedIds: _ids, ...churnResult } = churn(histories, start, end);
    return {
      generatedAt: now,
      tenants: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        active: byStatus.ACTIVE,
        trial: byStatus.TRIAL,
        onboarding: byStatus.ONBOARDING,
        pendingApproval: byStatus.PENDING_APPROVAL,
        pastDue: byStatus.PAST_DUE,
        suspended: byStatus.SUSPENDED,
        cancelled: byStatus.CANCELLED,
        archived: byStatus.ARCHIVED,
      },
      /** One line per currency: amounts in different currencies are never added together. */
      revenue: recurringRevenue(subs, now),
      churn: { from: start, to: end, ...churnResult },
      failedPayments,
      usage,
      supportTickets: tickets,
      systemHealth: health,
    };
  }

  // ------------------------------------------------------------------ time series
  private range(query: { from?: string; to?: string }, defaultMonths: number) {
    const now = new Date();
    const end = query.to ? dayEndExclusive(query.to) : now;
    const start = query.from ? dayStart(query.from) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (defaultMonths - 1), 1));
    return { start, end };
  }
  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RangeError) throw Errors.badRequest('RANGE_TOO_LONG', e.message);
      throw e;
    }
  }

  /** New centres per day / week / month and the running total. Centres that were permanently deleted are no longer counted. */
  async tenantGrowth(query: TenantGrowthQuery) {
    const { start, end } = this.range(query, 12);
    const rows = await this.sys.client.tenant.findMany({ where: { createdAt: { lt: end } }, select: { createdAt: true } });
    return { from: start, to: end, interval: query.interval, series: this.guard(() => growthSeries(rows.map((r) => r.createdAt), start, end, query.interval)) };
  }

  /** Money actually received for subscriptions: PAID subscription invoices by the month they were paid. */
  async subscriptionRevenue(query: PlatformPeriodQuery) {
    const { start, end } = this.range(query, 12);
    const rows = await this.sys.client.$queryRaw<Array<{ month: Date; currency: string; invoices: bigint; total: Prisma.Decimal; tax: Prisma.Decimal; discount: Prisma.Decimal }>>`
      SELECT date_trunc('month', "paidAt") AS month, "currency", count(*) AS invoices, sum("total") AS total, sum("tax") AS tax, sum("discount") AS discount
      FROM "subscription_invoices" WHERE "status" = 'PAID' AND "paidAt" >= ${start} AND "paidAt" < ${end} GROUP BY 1, 2 ORDER BY 1, 2`;
    const currencies = [...new Set(rows.map((r) => r.currency))].sort();
    const series = this.guard(() => buckets(start, end, 'month')).map((b) => ({
      period: b.key,
      lines: (currencies.length ? currencies : ['AED']).map((currency) => {
        const row = rows.find((r) => r.currency === currency && new Date(r.month).toISOString().slice(0, 7) === b.key);
        return { currency, invoices: Number(row?.invoices ?? 0), total: fixed(row?.total), tax: fixed(row?.tax), discount: fixed(row?.discount) };
      }),
    }));
    const totals = currencies.map((currency) => ({ currency, invoices: rows.filter((r) => r.currency === currency).reduce((n, r) => n + Number(r.invoices), 0), total: fixed(rows.filter((r) => r.currency === currency).reduce((s, r) => s.plus(D(r.total)), D(0))) }));
    return { from: start, to: end, series, totals };
  }

  /** Subscriptions per plan (optionally only those created in a date range), with status mix and MRR per plan. */
  async planDistribution(query: PlatformPeriodQuery) {
    const createdAt = query.from || query.to ? { ...(query.from ? { gte: dayStart(query.from) } : {}), ...(query.to ? { lt: dayEndExclusive(query.to) } : {}) } : undefined;
    const subs = await this.subscriptions(createdAt ? { createdAt } : {});
    const plans = await this.sys.client.subscriptionPlan.findMany({ orderBy: { sortOrder: 'asc' }, select: { key: true, name: true, currency: true, isActive: true } });
    const lines = planDistribution(subs, new Date());
    const withoutSubscription = createdAt ? null : await this.sys.client.tenant.count({ where: { subscription: { is: null } } });
    return {
      createdFrom: query.from ?? null,
      createdTo: query.to ?? null,
      total: subs.length,
      centresWithoutSubscription: withoutSubscription,
      plans: plans.map((p) => lines.find((l) => l.planKey === p.key) ?? { planKey: p.key, planName: p.name, currency: p.currency, mrr: '0.00', arr: '0.00', subscriptions: 0, byStatus: {}, byCycle: { MONTHLY: 0, ANNUAL: 0 } }),
    };
  }

  /** Monthly churn: for each month, who was paying at its start and how many of them ended during it. */
  async churnSeries(query: PlatformPeriodQuery) {
    const { start, end } = this.range(query, 12);
    const histories = await this.histories();
    const now = new Date();
    const series = this.guard(() => buckets(start, end, 'month')).map((b) => {
      const { churnedIds: _ids, ...result } = churn(histories, b.start, new Date(Math.min(b.end.getTime(), now.getTime())));
      return { period: b.key, ...result, complete: b.end.getTime() <= now.getTime() };
    });
    const { churnedIds: _all, ...overall } = churn(histories, start, new Date(Math.min(end.getTime(), now.getTime())));
    return { from: start, to: end, overall, series };
  }

  /** Usage per month: counters from usage_records, AI cost from ai_usage_logs, plus the centres using the most storage. */
  async usage(query: PlatformPeriodQuery) {
    const { start, end } = this.range(query, 6);
    const months = this.guard(() => buckets(start, end, 'month'));
    const keys = months.map((m) => m.key);
    const [counters, ai, storage, topStorage] = await Promise.all([
      this.sys.client.usageRecord.groupBy({ by: ['metric', 'periodKey'], where: { periodKey: { in: keys } }, _sum: { quantity: true } }),
      this.sys.client.$queryRaw<Array<{ month: Date; currency: string; pages: bigint; cost: Prisma.Decimal; calls: bigint; failed: bigint }>>`
        SELECT date_trunc('month', "createdAt") AS month, "currency", sum("pages") AS pages, sum("costEstimate") AS cost, count(*) AS calls, count(*) FILTER (WHERE NOT "success") AS failed
        FROM "ai_usage_logs" WHERE "createdAt" >= ${start} AND "createdAt" < ${end} GROUP BY 1, 2 ORDER BY 1, 2`,
      this.sys.client.usageRecord.aggregate({ where: { metric: 'storageBytes', periodKey: 'total' }, _sum: { quantity: true } }),
      this.sys.client.usageRecord.findMany({ where: { metric: 'storageBytes', periodKey: 'total', quantity: { gt: 0 } }, orderBy: { quantity: 'desc' }, take: 10, select: { quantity: true, tenant: { select: { id: true, name: true, slug: true } } } }),
    ]);
    const counter = (metric: string, key: string) => Number(counters.find((c) => c.metric === metric && c.periodKey === key)?._sum.quantity ?? 0);
    return {
      from: start,
      to: end,
      /** Storage is a running total (a gauge), not a monthly counter. */
      storage: { bytes: Number(storage._sum.quantity ?? 0), topCentres: topStorage.map((t) => ({ centre: t.tenant, bytes: Number(t.quantity) })) },
      series: months.map((m) => ({
        period: m.key,
        requests: counter('monthlyRequests', m.key),
        notifications: counter('notifications', m.key),
        aiPages: counter('aiPages', m.key),
        aiCost: ai.filter((a) => new Date(a.month).toISOString().slice(0, 7) === m.key).map((a) => ({ currency: a.currency, estimate: fixed(a.cost, 4), calls: Number(a.calls), failedCalls: Number(a.failed), pages: Number(a.pages) })),
      })),
    };
  }

  /** Open subscription invoices that already had a failed collection attempt, oldest due date first. */
  async failedPayments(query: FailedPaymentsQuery) {
    const dueAt = query.from || query.to ? { ...(query.from ? { gte: dayStart(query.from) } : {}), ...(query.to ? { lt: dayEndExclusive(query.to) } : {}) } : undefined;
    const where: Prisma.SubscriptionInvoiceWhereInput = {
      status: 'OPEN',
      attemptCount: { gt: 0 },
      ...(dueAt ? { dueAt } : {}),
      ...(query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { tenant: { name: { contains: query.q, mode: 'insensitive' } } }, { tenant: { slug: { contains: query.q.toLowerCase() } } }] } : {}),
    };
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const [rows, total, totals] = await Promise.all([
      this.sys.client.subscriptionInvoice.findMany({
        where,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, number: true, reason: true, total: true, currency: true, dueAt: true, attemptCount: true, nextAttemptAt: true, lastError: true, tenant: { select: { id: true, name: true, slug: true, status: true } }, subscription: { select: { status: true, graceEndsAt: true, plan: { select: { key: true, name: true } } } } },
      }),
      this.sys.client.subscriptionInvoice.count({ where }),
      this.failedPaymentTotals(),
    ]);
    return {
      ...pageResult(
        rows.map((r) => ({ id: r.id, number: r.number, reason: r.reason, total: fixed(r.total), currency: r.currency, dueAt: r.dueAt, attempts: r.attemptCount, nextAttemptAt: r.nextAttemptAt, lastError: r.lastError, centre: r.tenant, subscriptionStatus: r.subscription.status, graceEndsAt: r.subscription.graceEndsAt, plan: r.subscription.plan })),
        total,
        query,
      ),
      totals,
    };
  }
}
