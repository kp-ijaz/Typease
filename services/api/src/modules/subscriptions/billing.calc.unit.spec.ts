import { D } from '../../common/pagination';
import {
  addMonths, changeKind, couponDiscount, couponProblem, DEFAULT_POLICY, formatInvoiceNumber, invoiceAmounts, mergePolicy, periodEnd, priceFor, proration, remainingFraction,
  usageExceeding,
} from './billing.calc';

const d = (iso: string) => new Date(iso);
const s = (v: { toFixed(n: number): string }) => v.toFixed(2);
const starter = { monthlyPrice: '149.00', annualPrice: '1490.00' };
const professional = { monthlyPrice: '349.00', annualPrice: '3490.00' };

describe('SaaS billing arithmetic (pure)', () => {
  describe('periods', () => {
    it('adds calendar months and clamps the day', () => {
      expect(addMonths(d('2026-01-15T10:00:00Z'), 1).toISOString()).toBe('2026-02-15T10:00:00.000Z');
      expect(addMonths(d('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
      expect(addMonths(d('2028-01-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z'); // leap year
      expect(addMonths(d('2026-12-10T00:00:00Z'), 1).toISOString()).toBe('2027-01-10T00:00:00.000Z');
      expect(addMonths(d('2026-03-31T00:00:00Z'), 3).toISOString()).toBe('2026-06-30T00:00:00.000Z');
    });
    it('a monthly period is one month, an annual period twelve', () => {
      expect(periodEnd(d('2026-06-10T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-07-10T00:00:00.000Z');
      expect(periodEnd(d('2026-06-10T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2027-06-10T00:00:00.000Z');
      expect(periodEnd(d('2028-02-29T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2029-02-28T00:00:00.000Z');
    });
    it('prices come from the plan row for the cycle', () => {
      expect(s(priceFor(starter, 'MONTHLY'))).toBe('149.00');
      expect(s(priceFor(starter, 'ANNUAL'))).toBe('1490.00');
    });
  });

  describe('proration of an upgrade', () => {
    const start = d('2026-06-01T00:00:00Z');
    const end = d('2026-07-01T00:00:00Z'); // 30 days
    it('charges the price difference for the remaining fraction of the period', () => {
      // 20 of 30 days left: (349 - 149) * 20/30 = 133.33
      expect(s(proration('149.00', '349.00', start, end, d('2026-06-11T00:00:00Z')))).toBe('133.33');
      // half way: 100.00 ; at the very start: the full difference ; at the end: nothing
      expect(s(proration('149.00', '349.00', start, end, d('2026-06-16T00:00:00Z')))).toBe('100.00');
      expect(s(proration('149.00', '349.00', start, end, start))).toBe('200.00');
      expect(s(proration('149.00', '349.00', start, end, end))).toBe('0.00');
    });
    it('rounds half-up to fils', () => {
      // 1 of 30 days left: 200/30 = 6.666... -> 6.67 ; 29 of 30: 193.333... -> 193.33
      expect(s(proration('149.00', '349.00', start, end, d('2026-06-30T00:00:00Z')))).toBe('6.67');
      expect(s(proration('149.00', '349.00', start, end, d('2026-06-02T00:00:00Z')))).toBe('193.33');
      // 600 * 1/8 = 75.00 ; 1.01 * 1/2 = 0.505 -> 0.51
      expect(s(proration('0', '1.01', d('2026-01-01T00:00:00Z'), d('2026-01-03T00:00:00Z'), d('2026-01-02T00:00:00Z')))).toBe('0.51');
    });
    it('is never negative and clamps outside the period', () => {
      expect(s(proration('349.00', '149.00', start, end, d('2026-06-11T00:00:00Z')))).toBe('0.00');
      expect(s(proration('149.00', '349.00', start, end, d('2026-05-01T00:00:00Z')))).toBe('200.00');
      expect(s(proration('149.00', '349.00', start, end, d('2026-08-01T00:00:00Z')))).toBe('0.00');
      expect(remainingFraction(start, start, start).toNumber()).toBe(0);
      expect(remainingFraction(start, end, d('2026-06-16T00:00:00Z')).toNumber()).toBe(0.5);
    });
    it('annual upgrades prorate over the year', () => {
      const yearStart = d('2026-01-01T00:00:00Z');
      const yearEnd = d('2027-01-01T00:00:00Z');
      // 2000 * (184 days of 365 left on 1 July) = 1008.219... -> 1008.22
      expect(s(proration('1490.00', '3490.00', yearStart, yearEnd, d('2026-07-01T00:00:00Z')))).toBe('1008.22');
    });
  });

  describe('coupons', () => {
    it('percentage and fixed discounts, never more than the subtotal', () => {
      expect(s(couponDiscount('149.00', { percentOff: '50', amountOff: null }))).toBe('74.50');
      expect(s(couponDiscount('149.00', { percentOff: '33.33', amountOff: null }))).toBe('49.66'); // 49.6617
      expect(s(couponDiscount('149.00', { percentOff: 100, amountOff: null }))).toBe('149.00');
      expect(s(couponDiscount('149.00', { percentOff: null, amountOff: '49.00' }))).toBe('49.00');
      expect(s(couponDiscount('149.00', { percentOff: null, amountOff: '500.00' }))).toBe('149.00');
      expect(s(couponDiscount('149.00', null))).toBe('0.00');
    });
    it('a fixed amount is not applied to a prorated upgrade, a percentage is', () => {
      expect(s(couponDiscount('133.33', { percentOff: null, amountOff: '49.00' }, { percentOnly: true }))).toBe('0.00');
      expect(s(couponDiscount('133.33', { percentOff: '10', amountOff: null }, { percentOnly: true }))).toBe('13.33');
    });
    it('invoice amounts satisfy total = subtotal - discount + tax', () => {
      const a = invoiceAmounts('149.00', '74.50', 5);
      expect([s(a.subtotal), s(a.discount), s(a.tax), s(a.total)]).toEqual(['149.00', '74.50', '3.73', '78.23']); // 74.50 * 5% = 3.725 -> 3.73
      expect(a.total.equals(a.subtotal.minus(a.discount).plus(a.tax))).toBe(true);
      const free = invoiceAmounts('149.00', '200.00', 5);
      expect([s(free.discount), s(free.tax), s(free.total)]).toEqual(['149.00', '0.00', '0.00']);
      expect(s(invoiceAmounts('149.00', 0, 0).total)).toBe('149.00');
    });
    it('explains why a coupon cannot be used', () => {
      const now = d('2026-06-10T00:00:00Z');
      const base = { isActive: true, validFrom: null, validUntil: null, maxRedemptions: null, redeemedCount: 0, planKeys: [] as string[], amountOff: null, currency: 'AED' };
      const plan = { key: 'starter', currency: 'AED' };
      expect(couponProblem(base, plan, now)).toBeNull();
      expect(couponProblem({ ...base, isActive: false }, plan, now)).toBe('INACTIVE');
      expect(couponProblem({ ...base, validFrom: d('2026-07-01T00:00:00Z') }, plan, now)).toBe('NOT_STARTED');
      expect(couponProblem({ ...base, validUntil: d('2026-06-10T00:00:00Z') }, plan, now)).toBe('EXPIRED');
      expect(couponProblem({ ...base, validUntil: d('2026-06-10T00:00:01Z') }, plan, now)).toBeNull();
      expect(couponProblem({ ...base, maxRedemptions: 3, redeemedCount: 3 }, plan, now)).toBe('EXHAUSTED');
      expect(couponProblem({ ...base, maxRedemptions: 3, redeemedCount: 2 }, plan, now)).toBeNull();
      expect(couponProblem({ ...base, planKeys: ['business'] }, plan, now)).toBe('WRONG_PLAN');
      expect(couponProblem({ ...base, planKeys: ['starter', 'business'] }, plan, now)).toBeNull();
      expect(couponProblem({ ...base, amountOff: '10', currency: 'USD' }, plan, now)).toBe('WRONG_CURRENCY');
    });
  });

  describe('plan changes', () => {
    it('classifies by price at the current cycle', () => {
      const current = { planId: 'starter', cycle: 'MONTHLY' as const, price: priceFor(starter, 'MONTHLY') };
      expect(changeKind(current, { planId: 'starter', cycle: 'MONTHLY', priceAtCurrentCycle: 149 })).toBe('NONE');
      expect(changeKind(current, { planId: 'starter', cycle: 'ANNUAL', priceAtCurrentCycle: 149 })).toBe('CYCLE_ONLY');
      expect(changeKind(current, { planId: 'professional', cycle: 'MONTHLY', priceAtCurrentCycle: priceFor(professional, 'MONTHLY') })).toBe('UPGRADE');
      expect(changeKind({ planId: 'professional', cycle: 'MONTHLY', price: 349 }, { planId: 'starter', cycle: 'MONTHLY', priceAtCurrentCycle: 149 })).toBe('DOWNGRADE');
      // Same price, different plan: nothing to charge now, so it waits for the period end.
      expect(changeKind(current, { planId: 'other', cycle: 'MONTHLY', priceAtCurrentCycle: D('149.00') })).toBe('DOWNGRADE');
    });
    it('finds usage that exceeds the limits of the target plan (-1 = unlimited)', () => {
      const usage = [
        { metric: 'branches' as const, used: 2 },
        { metric: 'staffUsers' as const, used: 3 },
        { metric: 'corporateClients' as const, used: 4 },
        { metric: 'storageMb' as const, used: 5000 },
        { metric: 'monthlyRequests' as const, used: 99999 }, // monthly counters do not block a downgrade
      ];
      expect(usageExceeding(usage, { branches: 1, staffUsers: 3, monthlyRequests: 200, storageMb: 2048, corporateClients: 0 })).toEqual([
        { metric: 'branches', used: 2, limit: 1 },
        { metric: 'corporateClients', used: 4, limit: 0 },
        { metric: 'storageMb', used: 5000, limit: 2048 },
      ]);
      expect(usageExceeding(usage, { branches: -1, staffUsers: -1, storageMb: -1, corporateClients: -1 })).toEqual([]);
      expect(usageExceeding(usage, { branches: 2, staffUsers: 3, storageMb: 5000, corporateClients: 4 })).toEqual([]);
    });
  });

  describe('numbering and policy', () => {
    it('formats the global SaaS invoice number', () => {
      expect(formatInvoiceNumber(1)).toBe('TE-SUB-000001');
      expect(formatInvoiceNumber(BigInt(4217))).toBe('TE-SUB-004217');
      expect(formatInvoiceNumber(1234567)).toBe('TE-SUB-1234567');
    });
    it('merges a stored policy over the defaults and ignores nonsense', () => {
      expect(mergePolicy(null)).toEqual(DEFAULT_POLICY);
      expect(mergePolicy({ graceDays: 14, taxRatePercent: 5 })).toEqual({ ...DEFAULT_POLICY, graceDays: 14, taxRatePercent: 5 });
      expect(mergePolicy({ graceDays: -3, retryDelaysDays: 'soon', renewalLeadDays: 9999, taxRatePercent: 500 })).toEqual(DEFAULT_POLICY);
      expect(mergePolicy({ retryDelaysDays: [1, 1, 1, 3] }).retryDelaysDays).toEqual([1, 1, 1, 3]);
    });
  });
});
