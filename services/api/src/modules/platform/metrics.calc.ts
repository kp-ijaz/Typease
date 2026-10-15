import { Prisma } from '@typease/database';
import { D, DecimalInput, money } from '../../common/pagination';

/**
 * Pure maths of the platform dashboard (no database, no clock of its own).
 * Unit-tested in metrics.calc.unit.spec.ts.
 */
type Dec = Prisma.Decimal;

// ------------------------------------------------------------------ recurring revenue
/** Subscriptions that are being charged: active, or overdue but not yet lapsed. Trials pay nothing yet. */
export const RECURRING_STATUSES = ['ACTIVE', 'PAST_DUE', 'GRACE'] as const;
/** Subscriptions that have ended. */
export const ENDED_STATUSES = ['CANCELLED', 'EXPIRED'] as const;

export interface RecurringSubscription {
  status: string;
  billingCycle: 'MONTHLY' | 'ANNUAL';
  plan: { key: string; name: string; monthlyPrice: DecimalInput; annualPrice: DecimalInput; currency: string };
  coupon: { percentOff: DecimalInput | null; amountOff: DecimalInput | null; currency: string } | null;
  couponEndsAt: Date | null;
}

/**
 * What one subscription contributes to monthly recurring revenue (unrounded).
 *
 *   price of one billing period        monthly price, or annual price for annual billing
 *   - coupon discount on that period   percentage of the price, or a fixed amount (never more than the
 *                                      price; ignored when the coupon has ended or is in another currency)
 *   = net price per period
 *   normalised to a month              annual billing: net / 12
 *
 * Only ACTIVE, PAST_DUE and GRACE subscriptions count. A trial contributes 0.
 */
export function monthlyRecurring(sub: RecurringSubscription, now: Date): Dec {
  if (!(RECURRING_STATUSES as readonly string[]).includes(sub.status)) return D(0);
  const periodPrice = D(sub.billingCycle === 'ANNUAL' ? sub.plan.annualPrice : sub.plan.monthlyPrice);
  let discount = D(0);
  const coupon = sub.coupon && (!sub.couponEndsAt || sub.couponEndsAt.getTime() > now.getTime()) ? sub.coupon : null;
  if (coupon) {
    if (coupon.percentOff !== null && coupon.percentOff !== undefined) discount = periodPrice.mul(D(coupon.percentOff)).div(100);
    else if (coupon.amountOff !== null && coupon.amountOff !== undefined && coupon.currency === sub.plan.currency) discount = D(coupon.amountOff);
  }
  const net = Prisma.Decimal.max(periodPrice.minus(Prisma.Decimal.min(discount, periodPrice)), 0);
  return sub.billingCycle === 'ANNUAL' ? net.div(12) : net;
}

export interface RevenueLine {
  currency: string;
  /** Monthly recurring revenue, 2 decimals. */
  mrr: string;
  /** Annual run rate = MRR x 12. */
  arr: string;
  subscriptions: number;
}
export interface PlanLine extends RevenueLine {
  planKey: string;
  planName: string;
  /** Subscriptions on this plan by status (all statuses, including trials and ended ones). */
  byStatus: Record<string, number>;
  byCycle: { MONTHLY: number; ANNUAL: number };
}

/** MRR / ARR per currency (amounts in different currencies are never added together). */
export function recurringRevenue(subs: RecurringSubscription[], now: Date): RevenueLine[] {
  const totals = new Map<string, { sum: Dec; count: number }>();
  for (const sub of subs) {
    if (!(RECURRING_STATUSES as readonly string[]).includes(sub.status)) continue;
    const entry = totals.get(sub.plan.currency) ?? { sum: D(0), count: 0 };
    entry.sum = entry.sum.plus(monthlyRecurring(sub, now));
    entry.count += 1;
    totals.set(sub.plan.currency, entry);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({ currency, mrr: money(t.sum).toFixed(2), arr: money(t.sum.mul(12)).toFixed(2), subscriptions: t.count }));
}

/** Subscriptions per plan with their status mix and the MRR the plan brings in. */
export function planDistribution(subs: RecurringSubscription[], now: Date): PlanLine[] {
  const plans = new Map<string, { name: string; currency: string; sum: Dec; paying: number; byStatus: Record<string, number>; byCycle: { MONTHLY: number; ANNUAL: number } }>();
  for (const sub of subs) {
    const entry = plans.get(sub.plan.key) ?? { name: sub.plan.name, currency: sub.plan.currency, sum: D(0), paying: 0, byStatus: {}, byCycle: { MONTHLY: 0, ANNUAL: 0 } };
    entry.byStatus[sub.status] = (entry.byStatus[sub.status] ?? 0) + 1;
    entry.byCycle[sub.billingCycle] += 1;
    if ((RECURRING_STATUSES as readonly string[]).includes(sub.status)) {
      entry.sum = entry.sum.plus(monthlyRecurring(sub, now));
      entry.paying += 1;
    }
    plans.set(sub.plan.key, entry);
  }
  return [...plans.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([planKey, p]) => ({ planKey, planName: p.name, currency: p.currency, mrr: money(p.sum).toFixed(2), arr: money(p.sum.mul(12)).toFixed(2), subscriptions: p.paying, byStatus: p.byStatus, byCycle: p.byCycle }));
}

// ------------------------------------------------------------------ churn
export interface StatusChange {
  at: Date;
  from: string;
  to: string;
}
export interface SubscriptionHistory {
  id: string;
  createdAt: Date;
  /** Status right now. Used only when no change was ever recorded. */
  currentStatus: string;
  /** Recorded status changes (subscription_events of type STATUS_CHANGED), oldest first. */
  changes: StatusChange[];
}

/** The status a subscription had at an instant, or null when it did not exist yet. */
export function statusAt(sub: SubscriptionHistory, at: Date): string | null {
  if (sub.createdAt.getTime() > at.getTime()) return null;
  let status: string | null = null;
  for (const change of sub.changes) {
    if (change.at.getTime() <= at.getTime()) status = change.to;
    else break;
  }
  if (status !== null) return status;
  // Before the first recorded change the subscription had that change's "from" status.
  return sub.changes.length ? sub.changes[0].from : sub.currentStatus;
}

export interface ChurnResult {
  /** Paying subscriptions (ACTIVE / PAST_DUE / GRACE) at the start of the period. */
  activeAtStart: number;
  /** Of those, how many were cancelled or expired during the period. */
  churned: number;
  /** churned / activeAtStart as a percentage with 2 decimals; null when nothing was active at the start. */
  ratePercent: string | null;
  churnedIds: string[];
}

/**
 * Subscription churn for the period (start, end]:
 *
 *   churned        subscriptions that were paying at `start` and reached CANCELLED or EXPIRED
 *                  at some point after `start` and up to `end`
 *   rate           churned / paying at `start`
 *
 * A subscription that starts and ends inside the period is not in the base and
 * therefore not counted; a trial that never converts is not churn.
 */
export function churn(subs: SubscriptionHistory[], start: Date, end: Date): ChurnResult {
  const paying = subs.filter((s) => (RECURRING_STATUSES as readonly string[]).includes(statusAt(s, start) ?? ''));
  const churnedIds = paying
    .filter((s) => s.changes.some((c) => c.at.getTime() > start.getTime() && c.at.getTime() <= end.getTime() && (ENDED_STATUSES as readonly string[]).includes(c.to)))
    .map((s) => s.id);
  return {
    activeAtStart: paying.length,
    churned: churnedIds.length,
    ratePercent: paying.length ? D(churnedIds.length).mul(100).div(paying.length).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2) : null,
    churnedIds,
  };
}

// ------------------------------------------------------------------ time buckets (UTC)
export type Interval = 'day' | 'week' | 'month';
const DAY = 86_400_000;

/** Start of the bucket a date falls in. Weeks start on Monday. */
export function bucketStart(date: Date, interval: Interval): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (interval === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (interval === 'week') return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  return d;
}
export function nextBucket(start: Date, interval: Interval): Date {
  if (interval === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return new Date(start.getTime() + (interval === 'week' ? 7 : 1) * DAY);
}
/** Every bucket that overlaps [start, end). Capped so a careless range cannot produce an enormous answer. */
export function buckets(start: Date, end: Date, interval: Interval, max = 400): Array<{ start: Date; end: Date; key: string }> {
  const out: Array<{ start: Date; end: Date; key: string }> = [];
  let cursor = bucketStart(start, interval);
  while (cursor.getTime() < end.getTime()) {
    if (out.length >= max) throw new RangeError(`The date range is too long for ${interval} steps. Choose a shorter range or a coarser interval.`);
    const next = nextBucket(cursor, interval);
    out.push({ start: cursor, end: next, key: interval === 'month' ? cursor.toISOString().slice(0, 7) : cursor.toISOString().slice(0, 10) });
    cursor = next;
  }
  return out;
}

/** New and cumulative totals per bucket from a list of creation times. */
export function growthSeries(createdAt: Date[], start: Date, end: Date, interval: Interval): Array<{ period: string; from: string; new: number; total: number }> {
  const sorted = createdAt.map((d) => d.getTime()).sort((a, b) => a - b);
  return buckets(start, end, interval).map((b) => {
    const created = sorted.filter((t) => t >= b.start.getTime() && t < b.end.getTime()).length;
    const total = sorted.filter((t) => t < b.end.getTime()).length;
    return { period: b.key, from: b.start.toISOString().slice(0, 10), new: created, total };
  });
}

// ------------------------------------------------------------------ Prometheus text format
export interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Array<{ labels?: Record<string, string>; value: number }>;
}
const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** Prometheus exposition format 0.0.4. */
export function prometheusText(metrics: Metric[], comments: string[] = []): string {
  const lines: string[] = comments.map((c) => `# ${c.replace(/\n/g, ' ')}`);
  for (const m of metrics) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(m.name)) throw new Error(`Invalid metric name "${m.name}".`);
    lines.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples) {
      const labels = Object.entries(s.labels ?? {});
      const rendered = labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
      lines.push(`${m.name}${rendered} ${Number.isFinite(s.value) ? s.value : 'NaN'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
