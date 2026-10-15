import {
  bucketStart, buckets, churn, growthSeries, monthlyRecurring, planDistribution, prometheusText, RecurringSubscription, recurringRevenue, statusAt, SubscriptionHistory,
} from './metrics.calc';

const NOW = new Date('2026-06-15T12:00:00Z');
const plan = (key: string, monthly: string, annual: string, currency = 'AED') => ({ key, name: key[0].toUpperCase() + key.slice(1), monthlyPrice: monthly, annualPrice: annual, currency });
const starter = plan('starter', '149.00', '1490.00');
const professional = plan('professional', '349.00', '3490.00');
const sub = (over: Partial<RecurringSubscription> = {}): RecurringSubscription => ({ status: 'ACTIVE', billingCycle: 'MONTHLY', plan: starter, coupon: null, couponEndsAt: null, ...over });
const d = (iso: string) => new Date(iso);

describe('platform metrics maths', () => {
  describe('monthlyRecurring', () => {
    it('is the monthly price for monthly billing and a twelfth of the annual price for annual billing', () => {
      expect(monthlyRecurring(sub(), NOW).toFixed(2)).toBe('149.00');
      expect(monthlyRecurring(sub({ billingCycle: 'ANNUAL' }), NOW).toFixed(4)).toBe('124.1667');
      expect(monthlyRecurring(sub({ plan: professional, billingCycle: 'ANNUAL' }), NOW).toFixed(4)).toBe('290.8333');
    });
    it('counts ACTIVE, PAST_DUE and GRACE; trials and ended subscriptions contribute nothing', () => {
      for (const status of ['ACTIVE', 'PAST_DUE', 'GRACE']) expect(monthlyRecurring(sub({ status }), NOW).toFixed(2)).toBe('149.00');
      for (const status of ['TRIALING', 'CANCELLED', 'EXPIRED']) expect(monthlyRecurring(sub({ status }), NOW).toFixed(2)).toBe('0.00');
    });
    it('subtracts an active coupon from the price of the billing period', () => {
      const half = { percentOff: '50', amountOff: null, currency: 'AED' };
      expect(monthlyRecurring(sub({ coupon: half }), NOW).toFixed(2)).toBe('74.50');
      expect(monthlyRecurring(sub({ coupon: half, billingCycle: 'ANNUAL' }), NOW).toFixed(4)).toBe('62.0833');
      const fixed = { percentOff: null, amountOff: '100.00', currency: 'AED' };
      expect(monthlyRecurring(sub({ coupon: fixed }), NOW).toFixed(2)).toBe('49.00');
      // A fixed amount is per invoice: on annual billing it is spread over twelve months.
      expect(monthlyRecurring(sub({ coupon: fixed, billingCycle: 'ANNUAL' }), NOW).toFixed(4)).toBe('115.8333');
      // Never below zero.
      expect(monthlyRecurring(sub({ coupon: { percentOff: null, amountOff: '500.00', currency: 'AED' } }), NOW).toFixed(2)).toBe('0.00');
      expect(monthlyRecurring(sub({ coupon: { percentOff: '100', amountOff: null, currency: 'AED' } }), NOW).toFixed(2)).toBe('0.00');
    });
    it('ignores a coupon that has ended or is in another currency', () => {
      const half = { percentOff: '50', amountOff: null, currency: 'AED' };
      expect(monthlyRecurring(sub({ coupon: half, couponEndsAt: d('2026-06-15T11:59:59Z') }), NOW).toFixed(2)).toBe('149.00');
      expect(monthlyRecurring(sub({ coupon: half, couponEndsAt: d('2026-06-15T12:00:01Z') }), NOW).toFixed(2)).toBe('74.50');
      expect(monthlyRecurring(sub({ coupon: { percentOff: null, amountOff: '100.00', currency: 'USD' } }), NOW).toFixed(2)).toBe('149.00');
    });
  });

  describe('recurringRevenue and planDistribution', () => {
    const subs = [
      sub(),
      sub({ billingCycle: 'ANNUAL' }),
      sub({ plan: professional, status: 'PAST_DUE' }),
      sub({ plan: professional, status: 'TRIALING' }),
      sub({ plan: professional, status: 'CANCELLED' }),
      sub({ plan: plan('global', '40.00', '400.00', 'USD') }),
    ];
    it('sums per currency and rounds once at the end; ARR is twelve times MRR', () => {
      expect(recurringRevenue(subs, NOW)).toEqual([
        // 149 + 124.1666.. + 349 = 622.1666..
        { currency: 'AED', mrr: '622.17', arr: '7466.00', subscriptions: 3 },
        { currency: 'USD', mrr: '40.00', arr: '480.00', subscriptions: 1 },
      ]);
      expect(recurringRevenue([], NOW)).toEqual([]);
      expect(recurringRevenue([sub({ status: 'TRIALING' })], NOW)).toEqual([]);
    });
    it('rounds half-up on the total, not per subscription', () => {
      // 3 x (100 / 12) = 25.00 exactly; rounding each one first would give 24.99.
      const hundred = plan('odd', '0.00', '100.00');
      expect(recurringRevenue([1, 2, 3].map(() => sub({ plan: hundred, billingCycle: 'ANNUAL' })), NOW)[0]).toMatchObject({ mrr: '25.00', arr: '300.00' });
    });
    it('groups by plan with the status mix', () => {
      const lines = planDistribution(subs, NOW);
      expect(lines.map((l) => l.planKey)).toEqual(['global', 'professional', 'starter']);
      expect(lines.find((l) => l.planKey === 'professional')).toEqual({ planKey: 'professional', planName: 'Professional', currency: 'AED', mrr: '349.00', arr: '4188.00', subscriptions: 1, byStatus: { PAST_DUE: 1, TRIALING: 1, CANCELLED: 1 }, byCycle: { MONTHLY: 3, ANNUAL: 0 } });
      expect(lines.find((l) => l.planKey === 'starter')).toMatchObject({ mrr: '273.17', subscriptions: 2, byStatus: { ACTIVE: 2 }, byCycle: { MONTHLY: 1, ANNUAL: 1 } });
    });
  });

  describe('statusAt', () => {
    const history: SubscriptionHistory = {
      id: 's1',
      createdAt: d('2026-01-10T00:00:00Z'),
      currentStatus: 'CANCELLED',
      changes: [
        { at: d('2026-01-24T00:00:00Z'), from: 'TRIALING', to: 'ACTIVE' },
        { at: d('2026-03-24T00:00:00Z'), from: 'ACTIVE', to: 'PAST_DUE' },
        { at: d('2026-04-02T00:00:00Z'), from: 'PAST_DUE', to: 'ACTIVE' },
        { at: d('2026-05-20T00:00:00Z'), from: 'ACTIVE', to: 'CANCELLED' },
      ],
    };
    it('replays the recorded changes', () => {
      expect(statusAt(history, d('2026-01-01T00:00:00Z'))).toBeNull();
      expect(statusAt(history, d('2026-01-10T00:00:00Z'))).toBe('TRIALING');
      expect(statusAt(history, d('2026-01-24T00:00:00Z'))).toBe('ACTIVE');
      expect(statusAt(history, d('2026-03-30T00:00:00Z'))).toBe('PAST_DUE');
      expect(statusAt(history, d('2026-05-19T23:59:59Z'))).toBe('ACTIVE');
      expect(statusAt(history, d('2026-06-01T00:00:00Z'))).toBe('CANCELLED');
    });
    it('falls back to the current status when nothing was ever recorded', () => {
      expect(statusAt({ id: 's2', createdAt: d('2026-01-01T00:00:00Z'), currentStatus: 'ACTIVE', changes: [] }, d('2026-02-01T00:00:00Z'))).toBe('ACTIVE');
    });
  });

  describe('churn', () => {
    const h = (id: string, createdAt: string, currentStatus: string, changes: Array<[string, string, string]> = []): SubscriptionHistory => ({ id, createdAt: d(createdAt), currentStatus, changes: changes.map(([at, from, to]) => ({ at: d(at), from, to })) });
    const subs = [
      h('stays', '2026-01-01T00:00:00Z', 'ACTIVE'),
      h('cancels', '2026-01-01T00:00:00Z', 'CANCELLED', [['2026-03-10T00:00:00Z', 'ACTIVE', 'CANCELLED']]),
      h('lapses', '2026-01-01T00:00:00Z', 'EXPIRED', [['2026-03-05T00:00:00Z', 'ACTIVE', 'PAST_DUE'], ['2026-03-08T00:00:00Z', 'PAST_DUE', 'GRACE'], ['2026-03-15T00:00:00Z', 'GRACE', 'EXPIRED']]),
      h('trial-never-converts', '2026-02-20T00:00:00Z', 'EXPIRED', [['2026-03-06T00:00:00Z', 'TRIALING', 'PAST_DUE'], ['2026-03-20T00:00:00Z', 'PAST_DUE', 'EXPIRED']]),
      h('new-and-gone-in-march', '2026-03-02T00:00:00Z', 'CANCELLED', [['2026-03-25T00:00:00Z', 'ACTIVE', 'CANCELLED']]),
      h('already-gone', '2026-01-01T00:00:00Z', 'CANCELLED', [['2026-02-10T00:00:00Z', 'ACTIVE', 'CANCELLED']]),
      h('cancels-in-april', '2026-01-01T00:00:00Z', 'CANCELLED', [['2026-04-10T00:00:00Z', 'ACTIVE', 'CANCELLED']]),
    ];
    it('counts subscriptions that were paying at the start and ended during the period', () => {
      const march = churn(subs, d('2026-03-01T00:00:00Z'), d('2026-04-01T00:00:00Z'));
      // Paying on 1 March: stays, cancels, lapses, cancels-in-april. The trial was not paying; two did not exist / were gone.
      expect(march).toEqual({ activeAtStart: 4, churned: 2, ratePercent: '50.00', churnedIds: ['cancels', 'lapses'] });
      const april = churn(subs, d('2026-04-01T00:00:00Z'), d('2026-05-01T00:00:00Z'));
      expect(april).toMatchObject({ activeAtStart: 2, churned: 1, ratePercent: '50.00', churnedIds: ['cancels-in-april'] });
      expect(churn(subs, d('2026-05-01T00:00:00Z'), d('2026-06-01T00:00:00Z'))).toMatchObject({ activeAtStart: 1, churned: 0, ratePercent: '0.00' });
    });
    it('the period is (start, end]: an end exactly at the boundary belongs to the earlier period', () => {
      const edge = [h('edge', '2026-01-01T00:00:00Z', 'CANCELLED', [['2026-04-01T00:00:00Z', 'ACTIVE', 'CANCELLED']])];
      expect(churn(edge, d('2026-03-01T00:00:00Z'), d('2026-04-01T00:00:00Z')).churned).toBe(1);
      expect(churn(edge, d('2026-04-01T00:00:00Z'), d('2026-05-01T00:00:00Z'))).toMatchObject({ activeAtStart: 0, churned: 0, ratePercent: null });
    });
    it('has no rate when nothing was paying at the start', () => {
      expect(churn([], d('2026-03-01T00:00:00Z'), d('2026-04-01T00:00:00Z'))).toEqual({ activeAtStart: 0, churned: 0, ratePercent: null, churnedIds: [] });
      expect(churn([h('a', '2026-01-01T00:00:00Z', 'ACTIVE'), h('b', '2026-01-01T00:00:00Z', 'ACTIVE'), h('c', '2026-01-01T00:00:00Z', 'CANCELLED', [['2026-03-10T00:00:00Z', 'ACTIVE', 'CANCELLED']])], d('2026-03-01T00:00:00Z'), d('2026-04-01T00:00:00Z')).ratePercent).toBe('33.33');
    });
  });

  describe('time buckets', () => {
    it('finds the start of a day, a week (Monday) and a month in UTC', () => {
      const at = d('2026-06-17T21:30:00Z'); // a Wednesday
      expect(bucketStart(at, 'day').toISOString()).toBe('2026-06-17T00:00:00.000Z');
      expect(bucketStart(at, 'week').toISOString()).toBe('2026-06-15T00:00:00.000Z');
      expect(bucketStart(d('2026-06-21T23:59:59Z'), 'week').toISOString()).toBe('2026-06-15T00:00:00.000Z'); // Sunday
      expect(bucketStart(d('2026-06-22T00:00:00Z'), 'week').toISOString()).toBe('2026-06-22T00:00:00.000Z'); // Monday
      expect(bucketStart(at, 'month').toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });
    it('lists every bucket that overlaps the range, across month lengths and year ends', () => {
      expect(buckets(d('2025-11-15T00:00:00Z'), d('2026-02-01T00:00:00Z'), 'month').map((b) => b.key)).toEqual(['2025-11', '2025-12', '2026-01']);
      expect(buckets(d('2026-02-27T00:00:00Z'), d('2026-03-02T00:00:00Z'), 'day').map((b) => b.key)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
      expect(buckets(d('2026-06-17T00:00:00Z'), d('2026-06-30T00:00:00Z'), 'week').map((b) => b.key)).toEqual(['2026-06-15', '2026-06-22', '2026-06-29']);
      expect(buckets(d('2026-06-01T00:00:00Z'), d('2026-06-01T00:00:00Z'), 'day')).toEqual([]);
      expect(() => buckets(d('2000-01-01T00:00:00Z'), d('2026-01-01T00:00:00Z'), 'day')).toThrow(RangeError);
    });
    it('growthSeries counts new and cumulative items per bucket', () => {
      const created = ['2026-01-05T10:00:00Z', '2026-01-31T23:59:59Z', '2026-02-01T00:00:00Z', '2026-03-15T00:00:00Z', '2025-06-01T00:00:00Z'].map(d);
      expect(growthSeries(created, d('2026-01-01T00:00:00Z'), d('2026-04-01T00:00:00Z'), 'month')).toEqual([
        { period: '2026-01', from: '2026-01-01', new: 2, total: 3 },
        { period: '2026-02', from: '2026-02-01', new: 1, total: 4 },
        { period: '2026-03', from: '2026-03-01', new: 1, total: 5 },
      ]);
    });
  });

  describe('prometheusText', () => {
    it('renders HELP, TYPE and samples with escaped labels', () => {
      const text = prometheusText(
        [
          { name: 'typease_tenants', help: 'Centres by status.', type: 'gauge', samples: [{ labels: { status: 'active' }, value: 12 }, { labels: { status: 'trial' }, value: 0 }] },
          { name: 'typease_process_uptime_seconds', help: 'Up\ntime', type: 'gauge', samples: [{ value: 42 }] },
          { name: 'typease_weird', help: 'x', type: 'counter', samples: [{ labels: { a: 'quote " and \\ slash', b: 'line\nbreak' }, value: Number.NaN }] },
        ],
        ['first comment'],
      );
      expect(text).toBe(
        [
          '# first comment',
          '# HELP typease_tenants Centres by status.',
          '# TYPE typease_tenants gauge',
          'typease_tenants{status="active"} 12',
          'typease_tenants{status="trial"} 0',
          '# HELP typease_process_uptime_seconds Up\\ntime',
          '# TYPE typease_process_uptime_seconds gauge',
          'typease_process_uptime_seconds 42',
          '# HELP typease_weird x',
          '# TYPE typease_weird counter',
          'typease_weird{a="quote \\" and \\\\ slash",b="line\\nbreak"} NaN',
          '',
        ].join('\n'),
      );
    });
    it('refuses an invalid metric name', () => {
      expect(() => prometheusText([{ name: 'bad name', help: '', type: 'gauge', samples: [] }])).toThrow(/Invalid metric name/);
    });
  });
});
