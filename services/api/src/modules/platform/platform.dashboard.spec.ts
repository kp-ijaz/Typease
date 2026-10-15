import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { env } from '../../config/env';
import { periodKey } from '../../common/usage.service';

const num = (v: string | number) => Number(v);

describe('Platform: dashboard, SaaS reports and metrics', () => {
  let t: TestApp;
  let admin: Actor;
  let agent: Actor;
  let owner: TenantFixture;

  const dashboard = async (qs = '') => (await t.as(admin).get(`/platform/dashboard${qs}`).expect(200)).body;
  const aed = (body: any) => body.revenue.find((r: any) => r.currency === 'AED') ?? { mrr: '0.00', arr: '0.00', subscriptions: 0 };
  /** A centre on a plan whose subscription is then put into an exact state. */
  const centre = async (plan: string, sub: Record<string, unknown> = {}, name?: string) => {
    const tenant = await t.createTenant({ plan, name });
    if (Object.keys(sub).length) await t.sys.subscription.update({ where: { tenantId: tenant.id }, data: sub });
    return tenant;
  };

  beforeAll(async () => {
    t = await TestApp.create();
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    owner = await t.createTenant({ name: 'Some Centre' });
  });
  afterAll(() => t.close());

  it('is for staff with the metrics permission', async () => {
    for (const actor of [agent, owner.owner]) {
      await t.as(actor).get('/platform/dashboard').expect(403);
      for (const report of ['tenant-growth', 'subscription-revenue', 'plan-distribution', 'churn', 'usage', 'failed-payments']) await t.as(actor).get(`/platform/reports/${report}`).expect(403);
    }
    await t.as(null).get('/platform/dashboard').expect(401);
    await t.as(admin).get('/platform/dashboard?from=2026-05-01&to=2026-04-01').expect(400);
    await t.as(admin).get('/platform/dashboard?from=yesterday').expect(400);
  });

  it('counts centres by status', async () => {
    const before = await dashboard();
    const a = await t.createTenant();
    const b = await t.createTenant();
    const c = await t.createTenant();
    await t.sys.tenant.update({ where: { id: a.id }, data: { status: 'TRIAL' } });
    await t.sys.tenant.update({ where: { id: b.id }, data: { status: 'PENDING_APPROVAL' } });
    await t.sys.tenant.update({ where: { id: c.id }, data: { status: 'SUSPENDED', suspensionReason: 'PLATFORM: test' } });
    const after = await dashboard();
    expect(after.tenants.total - before.tenants.total).toBe(3);
    expect(after.tenants.trial - before.tenants.trial).toBe(1);
    expect(after.tenants.pendingApproval - before.tenants.pendingApproval).toBe(1);
    expect(after.tenants.suspended - before.tenants.suspended).toBe(1);
    expect(after.tenants.active).toBe(before.tenants.active);
    // And it matches the table.
    const byStatus = Object.fromEntries((await t.sys.tenant.groupBy({ by: ['status'], _count: { _all: true } })).map((r) => [r.status, r._count._all]));
    expect(after.tenants).toEqual({
      total: await t.sys.tenant.count(), active: byStatus.ACTIVE ?? 0, trial: byStatus.TRIAL ?? 0, onboarding: byStatus.ONBOARDING ?? 0, pendingApproval: byStatus.PENDING_APPROVAL ?? 0,
      pastDue: byStatus.PAST_DUE ?? 0, suspended: byStatus.SUSPENDED ?? 0, cancelled: byStatus.CANCELLED ?? 0, archived: byStatus.ARCHIVED ?? 0,
    });
  });

  it('computes MRR and ARR from paying subscriptions, normalised per month, minus active coupons', async () => {
    const before = aed(await dashboard());
    const half = await t.sys.coupon.create({ data: { code: `HALF${uniq()}`.toUpperCase(), percentOff: '50' } });
    const hundred = await t.sys.coupon.create({ data: { code: `HUNDRED${uniq()}`.toUpperCase(), amountOff: '100.00', currency: 'AED' } });
    await centre('starter'); // 149.00
    await centre('professional', { billingCycle: 'ANNUAL' }); // 3490 / 12 = 290.8333
    await centre('business', { status: 'PAST_DUE', couponId: half.id }); // 749 x 50% = 374.50
    await centre('starter', { status: 'GRACE', billingCycle: 'ANNUAL', couponId: hundred.id }); // (1490 - 100) / 12 = 115.8333
    await centre('starter', { couponId: half.id, couponEndsAt: new Date(Date.now() - 86_400_000) }); // coupon over: 149.00
    await centre('enterprise', { status: 'TRIALING' }); // trial: 0
    await centre('enterprise', { status: 'CANCELLED' }); // ended: 0
    await centre('enterprise', { status: 'EXPIRED' }); // ended: 0
    const after = aed(await dashboard());
    expect(after.subscriptions - before.subscriptions).toBe(5);
    // 149 + 290.8333 + 374.50 + 115.8333 + 149 = 1079.1667 (each total is rounded once, so allow one fils).
    expect(Math.abs(num(after.mrr) - num(before.mrr) - 1079.1667)).toBeLessThan(0.011);
    expect(Math.abs(num(after.arr) - num(before.arr) - 12950)).toBeLessThan(0.021);
    expect(num(after.arr)).toBeCloseTo(num(after.mrr) * 12, 0);
    expect(after.mrr).toMatch(/^\d+\.\d{2}$/);
  });

  it('measures churn over a period from the recorded status changes', async () => {
    // History in early 2021, where no other test has data.
    const stays = await centre('starter', { createdAt: new Date('2021-01-15T00:00:00Z') });
    const leaves = await centre('starter', { createdAt: new Date('2021-01-10T00:00:00Z'), status: 'CANCELLED', cancelledAt: new Date('2021-03-20T00:00:00Z') });
    const lapses = await centre('starter', { createdAt: new Date('2021-01-12T00:00:00Z'), status: 'EXPIRED' });
    const trial = await centre('starter', { createdAt: new Date('2021-02-20T00:00:00Z'), status: 'EXPIRED' });
    const sub = async (tenant: TenantFixture) => (await t.sys.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).id;
    const change = async (tenant: TenantFixture, at: string, from: string, to: string) => t.sys.subscriptionEvent.create({ data: { tenantId: tenant.id, subscriptionId: await sub(tenant), type: 'STATUS_CHANGED', data: { from, to }, createdAt: new Date(at) } });
    await change(leaves, '2021-03-20T09:00:00Z', 'ACTIVE', 'CANCELLED');
    await change(lapses, '2021-04-01T09:00:00Z', 'ACTIVE', 'PAST_DUE');
    await change(lapses, '2021-04-05T09:00:00Z', 'PAST_DUE', 'GRACE');
    await change(lapses, '2021-04-12T09:00:00Z', 'GRACE', 'EXPIRED');
    await change(trial, '2021-03-06T09:00:00Z', 'TRIALING', 'PAST_DUE');
    await change(trial, '2021-03-25T09:00:00Z', 'PAST_DUE', 'EXPIRED');
    // An unrelated event type must not be mistaken for a status change.
    await t.sys.subscriptionEvent.create({ data: { tenantId: stays.id, subscriptionId: await sub(stays), type: 'INVOICE_PAID', data: { from: 'ACTIVE', to: 'CANCELLED' }, createdAt: new Date('2021-03-10T00:00:00Z') } });

    const march = (await dashboard('?from=2021-03-01&to=2021-03-31')).churn;
    // Paying on 1 March: stays, leaves, lapses (the trial was not paying). One of them ended in March.
    expect(march).toMatchObject({ activeAtStart: 3, churned: 1, ratePercent: '33.33' });
    expect(march).not.toHaveProperty('churnedIds');
    expect((await dashboard('?from=2021-04-01&to=2021-04-30')).churn).toMatchObject({ activeAtStart: 2, churned: 1, ratePercent: '50.00' });
    expect((await dashboard('?from=2020-06-01&to=2020-06-30')).churn).toMatchObject({ activeAtStart: 0, churned: 0, ratePercent: null });

    const series = await t.as(admin).get('/platform/reports/churn?from=2021-02-01&to=2021-05-31').expect(200);
    expect(series.body.series).toEqual([
      { period: '2021-02', activeAtStart: 3, churned: 0, ratePercent: '0.00', complete: true },
      { period: '2021-03', activeAtStart: 3, churned: 1, ratePercent: '33.33', complete: true },
      { period: '2021-04', activeAtStart: 2, churned: 1, ratePercent: '50.00', complete: true },
      { period: '2021-05', activeAtStart: 1, churned: 0, ratePercent: '0.00', complete: true },
    ]);
    expect(series.body.overall).toMatchObject({ activeAtStart: 3, churned: 2, ratePercent: '66.67' });
    // The current month is reported as not finished yet.
    const now = await t.as(admin).get('/platform/reports/churn').expect(200);
    expect(now.body.series).toHaveLength(12);
    expect(now.body.series.at(-1)).toMatchObject({ period: periodKey(), complete: false });
  });

  it('reports failed payments, usage, AI cost and platform support tickets', async () => {
    // The centres exist before the baseline is taken (signing up already counts a notification or two).
    const pastDue = await centre('business', {}, 'Late Payer Typing');
    const inGrace = await centre('starter');
    const before = await dashboard();
    await t.sys.subscription.update({ where: { tenantId: pastDue.id }, data: { status: 'PAST_DUE' } });
    await t.sys.subscription.update({ where: { tenantId: inGrace.id }, data: { status: 'GRACE' } });
    const sub = await t.sys.subscription.findUniqueOrThrow({ where: { tenantId: pastDue.id } });
    const number = `TE-FAIL-${uniq()}`;
    await t.sys.subscriptionInvoice.create({ data: { tenantId: pastDue.id, subscriptionId: sub.id, number, status: 'OPEN', periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86_400_000), subtotal: '749.00', total: '749.00', dueAt: new Date('2026-09-01T00:00:00Z'), attemptCount: 2, lastError: 'Invoice is still unpaid', nextAttemptAt: new Date(Date.now() + 86_400_000) } });
    // An open invoice that has not failed yet does not count.
    await t.sys.subscriptionInvoice.create({ data: { tenantId: pastDue.id, subscriptionId: sub.id, number: `TE-NEW-${uniq()}`, status: 'OPEN', periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86_400_000), subtotal: '10.00', total: '10.00', dueAt: new Date(Date.now() + 86_400_000) } });
    const month = periodKey();
    // Counters may already hold something for this centre (its sign-up emails), so add to them.
    const add = (metric: string, key: string, quantity: number) =>
      t.sys.usageRecord.upsert({ where: { tenantId_metric_periodKey: { tenantId: pastDue.id, metric, periodKey: key } }, create: { tenantId: pastDue.id, metric, periodKey: key, quantity }, update: { quantity: { increment: quantity } } });
    await add('storageBytes', 'total', 5 * 1024 ** 3);
    await add('notifications', month, 40);
    await add('monthlyRequests', month, 12);
    await add('aiPages', month, 7);
    await add('notifications', '2021-07', 999);
    await t.sys.aiUsageLog.create({ data: { tenantId: pastDue.id, provider: 'external-http', operation: 'ocr.extract', pages: 7, units: 7, costEstimate: '0.3500', currency: 'USD' } });
    await t.as(pastDue.owner).post('/support/platform-tickets', { subject: 'Cannot pay by card', message: 'The payment page says the gateway is not configured.' }).expect(201);

    const after = await dashboard();
    expect(after.failedPayments.openInvoices - before.failedPayments.openInvoices).toBe(1);
    expect(after.failedPayments.subscriptionsPastDue - before.failedPayments.subscriptionsPastDue).toBe(1);
    expect(after.failedPayments.subscriptionsInGrace - before.failedPayments.subscriptionsInGrace).toBe(1);
    const amount = (b: any) => num(b.failedPayments.amounts.find((a: any) => a.currency === 'AED')?.total ?? 0);
    expect(amount(after) - amount(before)).toBeCloseTo(749, 2);

    expect(after.usage.period).toBe(month);
    expect(after.usage.storage.bytes - before.usage.storage.bytes).toBe(5 * 1024 ** 3);
    expect(after.usage.storage.gigabytes - before.usage.storage.gigabytes).toBeCloseTo(5, 2);
    expect(after.usage.notifications.counted - before.usage.notifications.counted).toBe(40);
    expect(after.usage.requests - before.usage.requests).toBe(12);
    expect(after.usage.ai.pages - before.usage.ai.pages).toBe(7);
    expect(after.usage.ai.calls - before.usage.ai.calls).toBe(1);
    const cost = (b: any) => num(b.usage.ai.cost.find((c: any) => c.currency === 'USD')?.estimate ?? 0);
    expect(cost(after) - cost(before)).toBeCloseTo(0.35, 4);

    expect(after.supportTickets.byStatus.OPEN - before.supportTickets.byStatus.OPEN).toBe(1);
    expect(after.supportTickets.open - before.supportTickets.open).toBe(1);
    expect(Object.keys(after.supportTickets.byStatus)).toEqual(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']);

    // Failed payments as a list, with the centre and what to do next.
    const list = await t.as(admin).get('/platform/reports/failed-payments?q=late%20payer').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ number, total: '749.00', currency: 'AED', attempts: 2, lastError: 'Invoice is still unpaid', subscriptionStatus: 'PAST_DUE', centre: { id: pastDue.id, name: 'Late Payer Typing' }, plan: { key: 'business' } });
    expect(list.body.totals.openInvoices).toBe(after.failedPayments.openInvoices);
    expect((await t.as(admin).get('/platform/reports/failed-payments?from=2026-09-01&to=2026-09-01&pageSize=100').expect(200)).body.data.map((r: any) => r.number)).toContain(number);
    expect((await t.as(admin).get('/platform/reports/failed-payments?to=2020-01-01').expect(200)).body.data).toEqual([]);

    // Usage per month.
    const usage = await t.as(admin).get('/platform/reports/usage').expect(200);
    expect(usage.body.series).toHaveLength(6);
    const current = usage.body.series.at(-1);
    expect(current.period).toBe(month);
    expect(current.notifications).toBe(after.usage.notifications.counted);
    expect(current.aiCost.find((c: any) => c.currency === 'USD')).toMatchObject({ pages: expect.any(Number), calls: expect.any(Number) });
    expect(usage.body.storage.topCentres[0]).toMatchObject({ centre: { id: pastDue.id, name: 'Late Payer Typing' }, bytes: 5 * 1024 ** 3 });
    const old = await t.as(admin).get('/platform/reports/usage?from=2021-07-01&to=2021-08-31').expect(200);
    expect(old.body.series).toEqual([{ period: '2021-07', requests: 0, notifications: 999, aiPages: 0, aiCost: [] }, { period: '2021-08', requests: 0, notifications: 0, aiPages: 0, aiCost: [] }]);
  });

  it('reports system health from the real dependencies', async () => {
    const stale = await t.sys.outboxEvent.create({ data: { type: 'customer.created', payload: {}, status: 'FAILED', error: 'subscriber kept failing' } });
    const body = await dashboard();
    expect(body.systemHealth).toMatchObject({ database: true, systemDatabase: true, redis: true, queue: { driver: 'inline', reachable: true } });
    expect(body.systemHealth.outbox.failed).toBeGreaterThanOrEqual(1);
    expect(body.systemHealth.status).toBe('degraded');
    expect(body.systemHealth.problems.join(' ')).toMatch(/domain events could not be delivered/);
    await t.sys.outboxEvent.update({ where: { id: stale.id }, data: { status: 'PROCESSED' } });
    expect(new Date(body.generatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('tenant growth: new centres per day, week or month with a running total', async () => {
    const early = await t.createTenant();
    const later = await t.createTenant();
    await t.sys.tenant.update({ where: { id: early.id }, data: { createdAt: new Date('2019-03-13T08:00:00Z') } });
    await t.sys.tenant.update({ where: { id: later.id }, data: { createdAt: new Date('2019-04-02T08:00:00Z') } });
    const months = await t.as(admin).get('/platform/reports/tenant-growth?from=2019-02-01&to=2019-05-31').expect(200);
    expect(months.body).toMatchObject({ interval: 'month' });
    expect(months.body.series).toEqual([
      { period: '2019-02', from: '2019-02-01', new: 0, total: 0 },
      { period: '2019-03', from: '2019-03-01', new: 1, total: 1 },
      { period: '2019-04', from: '2019-04-01', new: 1, total: 2 },
      { period: '2019-05', from: '2019-05-01', new: 0, total: 2 },
    ]);
    const weeks = await t.as(admin).get('/platform/reports/tenant-growth?from=2019-03-11&to=2019-03-24&interval=week').expect(200);
    expect(weeks.body.series).toEqual([{ period: '2019-03-11', from: '2019-03-11', new: 1, total: 1 }, { period: '2019-03-18', from: '2019-03-18', new: 0, total: 1 }]);
    const days = await t.as(admin).get('/platform/reports/tenant-growth?from=2019-03-12&to=2019-03-14&interval=day').expect(200);
    expect(days.body.series.map((d: any) => [d.period, d.new, d.total])).toEqual([['2019-03-12', 0, 0], ['2019-03-13', 1, 1], ['2019-03-14', 0, 1]]);
    // Default: the last 12 months; the last bucket ends with every centre that exists.
    const recent = await t.as(admin).get('/platform/reports/tenant-growth').expect(200);
    expect(recent.body.series).toHaveLength(12);
    expect(recent.body.series.at(-1).total).toBe(await t.sys.tenant.count());
    expect((await t.as(admin).get('/platform/reports/tenant-growth?from=2000-01-01&interval=day').expect(400)).body.code).toBe('RANGE_TOO_LONG');
    await t.as(admin).get('/platform/reports/tenant-growth?interval=hour').expect(400);
  });

  it('subscription revenue: paid subscription invoices by the month they were paid', async () => {
    const payer = await centre('starter');
    const sub = await t.sys.subscription.findUniqueOrThrow({ where: { tenantId: payer.id } });
    const invoice = (status: string, total: string, paidAt: string | null, extra: Record<string, unknown> = {}) =>
      t.sys.subscriptionInvoice.create({ data: { tenantId: payer.id, subscriptionId: sub.id, number: `TE-REV-${uniq()}`, status: status as any, periodStart: new Date('2019-05-01'), periodEnd: new Date('2019-06-01'), subtotal: total, total, dueAt: new Date('2019-05-01'), paidAt: paidAt ? new Date(paidAt) : null, ...extra } });
    await invoice('PAID', '149.00', '2019-05-03T10:00:00Z');
    await invoice('PAID', '366.45', '2019-05-31T23:59:59Z', { subtotal: '349.00', tax: '17.45' });
    await invoice('PAID', '100.00', '2019-06-01T00:00:00Z', { subtotal: '149.00', discount: '49.00' });
    await invoice('PAID', '20.00', '2019-06-15T00:00:00Z', { currency: 'USD' });
    await invoice('VOID', '999.00', null);
    await invoice('OPEN', '888.00', null);
    const res = await t.as(admin).get('/platform/reports/subscription-revenue?from=2019-05-01&to=2019-07-31').expect(200);
    expect(res.body.series).toEqual([
      { period: '2019-05', lines: [{ currency: 'AED', invoices: 2, total: '515.45', tax: '17.45', discount: '0.00' }, { currency: 'USD', invoices: 0, total: '0.00', tax: '0.00', discount: '0.00' }] },
      { period: '2019-06', lines: [{ currency: 'AED', invoices: 1, total: '100.00', tax: '0.00', discount: '49.00' }, { currency: 'USD', invoices: 1, total: '20.00', tax: '0.00', discount: '0.00' }] },
      { period: '2019-07', lines: [{ currency: 'AED', invoices: 0, total: '0.00', tax: '0.00', discount: '0.00' }, { currency: 'USD', invoices: 0, total: '0.00', tax: '0.00', discount: '0.00' }] },
    ]);
    expect(res.body.totals).toEqual([{ currency: 'AED', invoices: 3, total: '615.45' }, { currency: 'USD', invoices: 1, total: '20.00' }]);
    expect((await t.as(admin).get('/platform/reports/subscription-revenue').expect(200)).body.series).toHaveLength(12);
  });

  it('plan distribution: subscriptions per plan with status mix and MRR', async () => {
    const res = await t.as(admin).get('/platform/reports/plan-distribution').expect(200);
    // Every plan of the platform, in sort order; other suites may have added plans of their own, so only the four
    // built-in ones (and their relative order) are pinned here.
    const keys: string[] = res.body.plans.map((p: any) => p.planKey);
    expect(keys.filter((k) => ['starter', 'professional', 'business', 'enterprise'].includes(k))).toEqual(['starter', 'professional', 'business', 'enterprise']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(await t.sys.subscriptionPlan.count());
    expect(res.body.total).toBe(await t.sys.subscription.count());
    expect(res.body.centresWithoutSubscription).toBe(await t.sys.tenant.count({ where: { subscription: { is: null } } }));
    const starterPlan = await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: 'starter' } });
    const groups = await t.sys.subscription.groupBy({ by: ['status'], where: { planId: starterPlan.id }, _count: { _all: true } });
    const starter = res.body.plans.find((p: any) => p.planKey === 'starter');
    expect(starter.byStatus).toEqual(Object.fromEntries(groups.map((g) => [g.status, g._count._all])));
    expect(starter.byCycle.MONTHLY + starter.byCycle.ANNUAL).toBe(groups.reduce((n, g) => n + g._count._all, 0));
    expect(starter.mrr).toMatch(/^\d+\.\d{2}$/);
    // The sum of the plans' MRR is the dashboard's MRR.
    const sum = res.body.plans.reduce((n: number, p: any) => n + num(p.mrr), 0);
    expect(Math.abs(sum - num(aed(await dashboard()).mrr))).toBeLessThan(0.05);
    // Limited to subscriptions created in a range.
    const old = await t.as(admin).get('/platform/reports/plan-distribution?from=2021-01-01&to=2021-01-31').expect(200);
    expect(old.body.total).toBe(3);
    expect(old.body.plans.find((p: any) => p.planKey === 'starter').byStatus).toEqual({ ACTIVE: 1, CANCELLED: 1, EXPIRED: 1 });
    expect(old.body.centresWithoutSubscription).toBeNull();
  });

  describe('GET /internal/metrics', () => {
    const scrape = (token?: string) => {
      const req = t.http.get('/api/v1/internal/metrics');
      return token === undefined ? req : req.set('x-internal-token', token);
    };
    it('needs the internal token: a staff login is not enough', async () => {
      await scrape().expect(401);
      await scrape('wrong-token-wrong-token').expect(401);
      await t.as(admin).get('/internal/metrics').expect(401);
      await scrape('').expect(401);
    });
    it('serves Prometheus text with live values', async () => {
      const res = await scrape(env().INTERNAL_API_TOKEN).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain;/);
      expect(res.headers['content-type']).toContain('version=0.0.4');
      const text = res.text;
      const value = (line: string) => Number(text.split('\n').find((l) => l.startsWith(`${line} `))!.split(' ').pop());
      expect(text.split('\n')[0]).toBe('# TypEase operational metrics. HTTP request metrics are not instrumented; use the reverse proxy for those.');
      expect(text).toContain('# TYPE typease_tenants gauge');
      expect(value('typease_tenants{status="active"}')).toBe(await t.sys.tenant.count({ where: { status: 'ACTIVE' } }));
      expect(value('typease_tenants{status="pending_approval"}')).toBe(await t.sys.tenant.count({ where: { status: 'PENDING_APPROVAL' } }));
      expect(value('typease_database_up')).toBe(1);
      expect(value('typease_queue_up{driver="inline"}')).toBe(1);
      expect(value('typease_outbox_pending')).toBe(await t.sys.outboxEvent.count({ where: { status: 'PENDING' } }));
      expect(value('typease_outbox_failed')).toBe(await t.sys.outboxEvent.count({ where: { status: 'FAILED' } }));
      expect(value('typease_queue_jobs{state="active"}')).toBe(0);
      expect(value('typease_queue_jobs{state="failed"}')).toBe(t.jobs.deadLetters.length);
      expect(value('typease_queue_jobs{state="waiting"}')).toBe(t.jobs.pendingCount());
      expect(value('typease_process_uptime_seconds')).toBeGreaterThanOrEqual(0);
      expect(value('typease_process_resident_memory_bytes')).toBeGreaterThan(1_000_000);
      expect(value('typease_notifications_failed')).toBe(await t.sys.notification.count({ where: { status: 'FAILED', createdAt: { gte: new Date(Date.now() - 3600_000) } } }));
      // Every sample line is "name{labels} number".
      for (const line of text.trim().split('\n').filter((l) => !l.startsWith('#'))) expect(line).toMatch(/^[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?\d+(\.\d+)?$/);
      // No centre names or other tenant data.
      expect(text).not.toContain('Some Centre');
    });
  });
});
