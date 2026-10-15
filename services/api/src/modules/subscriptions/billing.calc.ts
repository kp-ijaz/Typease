import { Prisma } from '@typease/database';
import type { PlanLimitKey, PlanLimits } from '@typease/types';
import { D, DecimalInput, money } from '../../common/pagination';

/**
 * Pure SaaS-billing arithmetic (no database): periods, prices, proration,
 * coupons and the usage check for downgrades. Unit-tested in billing.calc.unit.spec.ts.
 */
export type Cycle = 'MONTHLY' | 'ANNUAL';
type Dec = Prisma.Decimal;
const DAY = 86_400_000;

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);

/** Calendar months in UTC; the day is clamped (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}
export const periodEnd = (start: Date, cycle: Cycle) => addMonths(start, cycle === 'ANNUAL' ? 12 : 1);

export function priceFor(plan: { monthlyPrice: DecimalInput; annualPrice: DecimalInput }, cycle: Cycle): Dec {
  return D(cycle === 'ANNUAL' ? plan.annualPrice : plan.monthlyPrice);
}

/** Share of the current period that is still ahead (0..1). */
export function remainingFraction(periodStart: Date, periodEndAt: Date, now: Date): Dec {
  const length = periodEndAt.getTime() - periodStart.getTime();
  if (length <= 0) return D(0);
  const left = Math.min(Math.max(periodEndAt.getTime() - now.getTime(), 0), length);
  return D(left).div(length);
}

/**
 * Upgrade proration: (new price - old price) x remaining fraction of the period,
 * rounded half-up to 2 decimals. Never negative.
 */
export function proration(oldPrice: DecimalInput, newPrice: DecimalInput, periodStart: Date, periodEndAt: Date, now: Date): Dec {
  const difference = D(newPrice).minus(D(oldPrice));
  if (difference.lte(0)) return D(0);
  return money(difference.mul(remainingFraction(periodStart, periodEndAt, now)));
}

export interface CouponTerms {
  percentOff: DecimalInput | null;
  amountOff: DecimalInput | null;
}
/** Discount of a coupon on a subtotal. A fixed amount never exceeds the subtotal. */
export function couponDiscount(subtotal: DecimalInput, coupon: CouponTerms | null | undefined, opts: { percentOnly?: boolean } = {}): Dec {
  const base = D(subtotal);
  if (!coupon || base.lte(0)) return D(0);
  if (coupon.percentOff !== null && coupon.percentOff !== undefined) return Prisma.Decimal.min(money(base.mul(D(coupon.percentOff)).div(100)), base);
  if (opts.percentOnly) return D(0); // a fixed amount is a per-period discount, not applied to prorated upgrades
  return Prisma.Decimal.min(D(coupon.amountOff), base);
}

export interface InvoiceAmounts {
  subtotal: Dec;
  discount: Dec;
  tax: Dec;
  total: Dec;
}
/** total = subtotal - discount + tax (database check constraint), tax on the discounted amount. */
export function invoiceAmounts(subtotal: DecimalInput, discount: DecimalInput, taxRatePercent: DecimalInput): InvoiceAmounts {
  const s = money(subtotal);
  const d = Prisma.Decimal.min(money(discount), s);
  const tax = money(s.minus(d).mul(D(taxRatePercent)).div(100));
  return { subtotal: s, discount: d, tax, total: s.minus(d).plus(tax) };
}

export type CouponProblem = 'INACTIVE' | 'NOT_STARTED' | 'EXPIRED' | 'EXHAUSTED' | 'WRONG_PLAN' | 'WRONG_CURRENCY';
export function couponProblem(
  coupon: { isActive: boolean; validFrom: Date | null; validUntil: Date | null; maxRedemptions: number | null; redeemedCount: number; planKeys: string[]; amountOff: DecimalInput | null; currency: string },
  plan: { key: string; currency: string },
  now: Date,
): CouponProblem | null {
  if (!coupon.isActive) return 'INACTIVE';
  if (coupon.validFrom && coupon.validFrom > now) return 'NOT_STARTED';
  if (coupon.validUntil && coupon.validUntil <= now) return 'EXPIRED';
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) return 'EXHAUSTED';
  if (coupon.planKeys.length && !coupon.planKeys.includes(plan.key)) return 'WRONG_PLAN';
  if (coupon.amountOff !== null && coupon.currency !== plan.currency) return 'WRONG_CURRENCY';
  return null;
}

/** Limits that describe what a centre already HAS (as opposed to monthly counters), checked before a downgrade. */
export const DOWNGRADE_CHECKED: PlanLimitKey[] = ['branches', 'staffUsers', 'corporateClients', 'storageMb'];
export interface UsageExcess {
  metric: PlanLimitKey;
  used: number;
  limit: number;
}
export function usageExceeding(usage: Array<{ metric: PlanLimitKey; used: number }>, limits: Partial<PlanLimits>): UsageExcess[] {
  const out: UsageExcess[] = [];
  for (const metric of DOWNGRADE_CHECKED) {
    const limit = limits[metric];
    if (limit === undefined || limit === -1) continue;
    const used = usage.find((u) => u.metric === metric)?.used ?? 0;
    if (used > limit) out.push({ metric, used, limit });
  }
  return out;
}

export type ChangeKind = 'NONE' | 'UPGRADE' | 'DOWNGRADE' | 'CYCLE_ONLY';
/** Compared at the CURRENT billing cycle: a higher price is an upgrade, anything else waits for the period end. */
export function changeKind(
  current: { planId: string; cycle: Cycle; price: DecimalInput },
  target: { planId: string; cycle: Cycle; priceAtCurrentCycle: DecimalInput },
): ChangeKind {
  if (current.planId === target.planId) return current.cycle === target.cycle ? 'NONE' : 'CYCLE_ONLY';
  return D(target.priceAtCurrentCycle).gt(D(current.price)) ? 'UPGRADE' : 'DOWNGRADE';
}

export const formatInvoiceNumber = (n: number | bigint) => `TE-SUB-${String(n).padStart(6, '0')}`;

/** Dunning policy. Overridable per installation through platform_settings key "subscriptions.policy". */
export interface BillingPolicy {
  /** Renewal invoice is created this many days before the period ends. */
  renewalLeadDays: number;
  /** Trial-ending reminder. */
  trialReminderDays: number;
  /** Days between collection attempts after the first one at the due date. Length + 1 = number of attempts. */
  retryDelaysDays: number[];
  /** Days in GRACE after the last attempt before the centre is suspended. */
  graceDays: number;
  /** Tax on SaaS invoices, percent. */
  taxRatePercent: number;
}
export const DEFAULT_POLICY: BillingPolicy = { renewalLeadDays: 7, trialReminderDays: 3, retryDelaysDays: [1, 2], graceDays: 7, taxRatePercent: 0 };
export function mergePolicy(override: unknown): BillingPolicy {
  const o = (override && typeof override === 'object' ? override : {}) as Partial<BillingPolicy>;
  const int = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : def);
  return {
    renewalLeadDays: int(o.renewalLeadDays, DEFAULT_POLICY.renewalLeadDays, 0, 60),
    trialReminderDays: int(o.trialReminderDays, DEFAULT_POLICY.trialReminderDays, 0, 30),
    retryDelaysDays: Array.isArray(o.retryDelaysDays) && o.retryDelaysDays.length <= 10 && o.retryDelaysDays.every((d) => typeof d === 'number' && d >= 0 && d <= 30) ? o.retryDelaysDays : DEFAULT_POLICY.retryDelaysDays,
    graceDays: int(o.graceDays, DEFAULT_POLICY.graceDays, 0, 90),
    taxRatePercent: typeof o.taxRatePercent === 'number' && o.taxRatePercent >= 0 && o.taxRatePercent <= 100 ? o.taxRatePercent : DEFAULT_POLICY.taxRatePercent,
  };
}
