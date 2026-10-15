import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { listen } from '../finance/fixtures';
import { env } from '../../config/env';
import { UsageService } from '../../common/usage.service';
import { DEFAULT_PLANS, ProvisioningService } from '../tenancy/provisioning.service';
import { BillingCore } from './billing.core';
import { clockOf, completeOnboarding, couponCode, DAY, eventsOf, invoicesOf, lifecycleOf, openInvoiceOf, paySandbox, setPeriod, signedUpTenant, subOf, tenantOf } from './fixtures';

describe('Subscriptions: plans, coupons, choosing and changing a plan', () => {
  let t: TestApp;
  let platform: Actor;
  let support: Actor;

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    platform = await t.createPlatformAdmin('SUPER_ADMIN');
    support = await t.createPlatformAdmin('SUPPORT_AGENT');
  });
  afterEach(() => clockOf(t).reset());
  afterAll(() => t.close());

  const newCoupon = async (body: Record<string, unknown>) => (await t.as(platform).post('/platform/coupons', { code: couponCode(), ...body }).expect(201)).body;

  // ---------------------------------------------------------------- plans are data
  describe('plans', () => {
    it('lists the public plans with prices, limits and features (no authentication)', async () => {
      const res = await t.http.get('/api/v1/public/plans').expect(200);
      const defaults = ['starter', 'professional', 'business', 'enterprise'];
      // The four starting plans, in price order (other suites may add plans of their own).
      expect(res.body.map((p: any) => p.key).filter((k: string) => defaults.includes(k))).toEqual(defaults);
      const starter = res.body.find((p: any) => p.key === 'starter');
      expect(starter).toMatchObject({ name: 'Starter', monthlyPrice: '149.00', annualPrice: '1490.00', currency: 'AED', trialDays: 14, annualSaving: '298.00' });
      expect(starter.limits).toMatchObject({ branches: 1, staffUsers: 3, corporateClients: 0 });
      expect(starter.features).toMatchObject({ whiteLabel: false, automation: false });
      expect(res.body.find((p: any) => p.key === 'enterprise').limits.branches).toBe(-1);
      expect(starter.id).toBeUndefined();
    });

    it('platform admins create, change, deactivate and delete plans - never one that has subscribers', async () => {
      const key = `team-${uniq()}`;
      const limits = { branches: 3, staffUsers: 15, monthlyRequests: 2000, storageMb: 20480, aiPages: 500, notifications: 5000, corporateClients: 25 };
      const features = { whiteLabel: false, customDomains: false, corporatePortal: true, automation: true, aiAssistant: true, scheduledReports: true };
      const created = await t.as(platform).post('/platform/plans', { key, name: 'Team', monthlyPrice: '499.00', annualPrice: '4990.00', trialDays: 7, limits, features, sortOrder: 5 }).expect(201);
      expect(created.body).toMatchObject({ key, monthlyPrice: '499.00', isActive: true, isPublic: true });
      expect((await t.http.get('/api/v1/public/plans')).body.map((p: any) => p.key)).toContain(key);
      await t.as(platform).post('/platform/plans', { key, name: 'Duplicate', monthlyPrice: '1.00', annualPrice: '10.00', limits, features }).expect(409);
      await t.as(platform).post('/platform/plans', { key: `x-${uniq()}`, name: 'Bad', monthlyPrice: '-5', annualPrice: '10.00', limits, features }).expect(400);
      await t.as(platform).post('/platform/plans', { key: `x-${uniq()}`, name: 'Bad', monthlyPrice: '5.00', annualPrice: '10.00', limits: { branches: 1 }, features }).expect(400);

      const updated = await t.as(platform).patch(`/platform/plans/${created.body.id}`, { monthlyPrice: '549.00', limits: { ...limits, branches: 4 } }).expect(200);
      expect(updated.body.monthlyPrice).toBe('549.00');
      expect(updated.body.limits.branches).toBe(4);

      // A centre subscribes to it: now it can only be deactivated.
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: key, billingCycle: 'MONTHLY' }).expect(201);
      const del = await t.as(platform).delete(`/platform/plans/${created.body.id}`);
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('PLAN_IN_USE');
      expect(del.body.message).toMatch(/Deactivate/);
      await t.as(platform).patch(`/platform/plans/${created.body.id}`, { isActive: false }).expect(200);
      expect((await t.http.get('/api/v1/public/plans')).body.map((p: any) => p.key)).not.toContain(key);
      // The subscriber keeps the plan; nobody new can choose it.
      expect((await subOf(t, tenant.id)).plan.key).toBe(key);
      const other = await signedUpTenant(t);
      const refused = await t.as(other.owner).post('/onboarding/plan', { planKey: key, billingCycle: 'MONTHLY' });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('PLAN_NOT_AVAILABLE');
      const listed = (await t.as(platform).get('/platform/plans').expect(200)).body.find((p: any) => p.key === key);
      expect(listed).toMatchObject({ isActive: false, subscriptionCount: 1 });

      // An unused plan can be deleted.
      const unused = await t.as(platform).post('/platform/plans', { key: `tmp-${uniq()}`, name: 'Temp', monthlyPrice: '1.00', annualPrice: '10.00', limits, features, isPublic: false }).expect(201);
      await t.as(platform).delete(`/platform/plans/${unused.body.id}`).expect(200);
      expect(await t.sys.subscriptionPlan.findUnique({ where: { id: unused.body.id } })).toBeNull();
    });

    it('only platform staff with platform.plans.manage may manage plans and coupons', async () => {
      const tenant = await t.createTenant();
      const body = { key: `nope-${uniq()}`, name: 'Nope', monthlyPrice: '1.00', annualPrice: '10.00', limits: {}, features: {} };
      await t.as(tenant.owner).post('/platform/plans', body).expect(403);
      await t.as(tenant.owner).get('/platform/plans').expect(403);
      await t.as(tenant.owner).get('/platform/coupons').expect(403);
      await t.as(support).post('/platform/plans', body).expect(403);
      await t.as(support).post('/platform/coupons', { code: couponCode(), percentOff: 10 }).expect(403);
      await t.as(support).get('/platform/billing/subscriptions').expect(403);
      await t.as(null).get('/platform/plans').expect(401);
    });
  });

  describe('coupons', () => {
    it('are percentage or fixed, with validity, redemption limit, plan restriction and duration', async () => {
      const percent = await newCoupon({ percentOff: 25, durationMonths: 3, maxRedemptions: 100, planKeys: ['starter'], validUntil: new Date(Date.now() + 30 * DAY).toISOString() });
      expect(percent).toMatchObject({ percentOff: '25.00', amountOff: null, durationMonths: 3, maxRedemptions: 100, redeemedCount: 0, planKeys: ['starter'], isActive: true });
      const fixed = await newCoupon({ amountOff: '49.00' });
      expect(fixed).toMatchObject({ percentOff: null, amountOff: '49.00', durationMonths: null });
      await t.as(platform).post('/platform/coupons', { code: couponCode(), percentOff: 10, amountOff: '5.00' }).expect(400);
      await t.as(platform).post('/platform/coupons', { code: couponCode() }).expect(400);
      await t.as(platform).post('/platform/coupons', { code: couponCode(), percentOff: 101 }).expect(400);
      await t.as(platform).post('/platform/coupons', { code: percent.code, percentOff: 10 }).expect(409);
      expect((await t.as(platform).post('/platform/coupons', { code: couponCode(), percentOff: 10, planKeys: ['no-such-plan'] })).body.code).toBe('UNKNOWN_PLAN');
      const updated = await t.as(platform).patch(`/platform/coupons/${fixed.id}`, { isActive: false, maxRedemptions: 5 }).expect(200);
      expect(updated.body).toMatchObject({ isActive: false, maxRedemptions: 5, amountOff: '49.00' });
      expect((await t.as(platform).get('/platform/coupons').expect(200)).body.map((c: any) => c.code)).toEqual(expect.arrayContaining([percent.code, fixed.code]));
      await t.as(platform).delete(`/platform/coupons/${fixed.id}`).expect(200);
    });
  });

  // ---------------------------------------------------------------- starting
  describe('choosing a plan during onboarding', () => {
    it('starts a trial on a first subscription and leaves the tenant status to onboarding', async () => {
      const tenant = await signedUpTenant(t);
      const before = await t.as(tenant.owner).get('/subscription').expect(200);
      expect(before.body).toMatchObject({ subscription: null, tenantStatus: 'ONBOARDING' });

      const res = await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'ANNUAL' }).expect(201);
      expect(res.body.outcome).toBe('TRIAL_STARTED');
      expect(res.body.subscription).toMatchObject({ status: 'TRIALING', billingCycle: 'ANNUAL', trialDaysLeft: 14, cancelAtPeriodEnd: false, price: '1490.00' });
      expect(res.body.plan).toMatchObject({ key: 'starter', monthlyPrice: '149.00' });
      expect(res.body.openInvoices).toEqual([]);
      const days = (new Date(res.body.subscription.trialEndsAt).getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(13.99);
      expect(days).toBeLessThan(14.01);
      expect(res.body.subscription.currentPeriodEnd).toBe(res.body.subscription.trialEndsAt);
      // Usage against the plan limits, straight from UsageService.
      expect(res.body.usage.find((u: any) => u.metric === 'branches')).toEqual({ metric: 'branches', used: 1, limit: 1 });
      expect(res.body.usage.find((u: any) => u.metric === 'staffUsers')).toMatchObject({ used: 1, limit: 3 });

      expect(await invoicesOf(t, tenant.id)).toHaveLength(0);
      expect((await tenantOf(t, tenant.id)).status).toBe('ONBOARDING'); // not touched here
      expect((await eventsOf(t, tenant.id)).map((e) => e.type)).toEqual(['TRIAL_STARTED']);
      // Onboarding completion then makes the centre a TRIAL tenant.
      expect((await completeOnboarding(t, tenant)).status).toBe('TRIAL');
      // A second "start" is refused.
      const again = await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'professional', billingCycle: 'MONTHLY' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_SUBSCRIBED');
    });

    it('offers only features that exist: "API access" is gone from the catalogue, and an old key in a request or in a stored plan is ignored', async () => {
      const OFFERED = ['aiAssistant', 'automation', 'corporatePortal', 'customDomains', 'scheduledReports', 'whiteLabel'];
      // ---- the default plans and the pricing page
      expect(JSON.stringify(DEFAULT_PLANS)).not.toMatch(/apiAccess|API access/i);
      for (const plan of DEFAULT_PLANS) expect(Object.keys(plan.features).sort()).toEqual(OFFERED);
      const pricing = (await t.http.get('/api/v1/public/plans').expect(200)).body;
      expect(pricing.length).toBeGreaterThanOrEqual(4);
      for (const plan of pricing) expect([plan.key, Object.keys(plan.features).sort()]).toEqual([plan.key, OFFERED]);
      expect(JSON.stringify(pricing)).not.toMatch(/apiAccess|API access/i);
      expect(pricing.find((p: any) => p.key === 'enterprise')).toMatchObject({ description: 'Unlimited usage and dedicated deployment options.', features: { whiteLabel: true, customDomains: true } });

      // ---- an older console still sends the key: accepted, not stored, not returned
      const limits = { branches: 1, staffUsers: 3, monthlyRequests: 100, storageMb: 1024, aiPages: 0, notifications: 100, corporateClients: 0 };
      const offered = { whiteLabel: false, customDomains: false, corporatePortal: true, automation: false, aiAssistant: false, scheduledReports: false };
      const key = `legacy-${uniq()}`;
      const created = await t.as(platform).post('/platform/plans', { key, name: 'Legacy client', monthlyPrice: '10.00', annualPrice: '100.00', limits, features: { ...offered, apiAccess: true } }).expect(201);
      expect(created.body.features).toEqual(offered);
      expect((await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key } })).features).toEqual(offered);
      // A key nobody ever heard of is still a mistake.
      await t.as(platform).post('/platform/plans', { key: `x-${uniq()}`, name: 'Bad', monthlyPrice: '5.00', annualPrice: '10.00', limits, features: { ...offered, teleportation: true } }).expect(400);
      await t.as(platform).patch(`/platform/plans/${created.body.id}`, { features: { ...offered, apiAccess: 'yes' } }).expect(400);

      // ---- a plan stored by an earlier release still carries the key: every reader ignores it
      await t.sys.subscriptionPlan.update({ where: { key }, data: { features: { ...offered, apiAccess: true, somethingOlder: true } } });
      expect((await t.http.get('/api/v1/public/plans').expect(200)).body.find((p: any) => p.key === key).features).toEqual(offered);
      expect((await t.as(platform).get('/platform/plans').expect(200)).body.find((p: any) => p.key === key).features).toEqual(offered);
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: key, billingCycle: 'MONTHLY' }).expect(201);
      expect((await t.as(tenant.owner).get('/subscription').expect(200)).body.plan.features).toEqual(offered);
      const usage = await t.inTenant(tenant.id, () => t.get(UsageService).plan());
      expect(usage.features).toEqual(offered);
      expect(await t.inTenant(tenant.id, () => t.get(UsageService).hasFeature('corporatePortal'))).toBe(true);
      // Changing the plan rewrites its features as the offered set ...
      const patched = await t.as(platform).patch(`/platform/plans/${created.body.id}`, { features: { ...offered, automation: true } }).expect(200);
      expect(patched.body.features).toEqual({ ...offered, automation: true });
      expect((await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key } })).features).toEqual({ ...offered, automation: true });
      // ... and the start-up bootstrap takes the retired key out of plans nobody touched (other keys are left as they are).
      await t.sys.subscriptionPlan.update({ where: { key }, data: { features: { ...offered, apiAccess: true, somethingOlder: true } } });
      await t.sys.subscriptionPlan.update({ where: { key: 'enterprise' }, data: { description: 'Unlimited usage, API access and dedicated deployment options.' } });
      await t.get(ProvisioningService).bootstrapPlatform();
      expect((await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key } })).features).toEqual({ ...offered, somethingOlder: true });
      expect((await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } })).description).toBe('Unlimited usage and dedicated deployment options.');
      expect(await t.sys.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "subscription_plans" WHERE "features" ? 'apiAccess'`).toEqual([{ n: 0 }]);
      // A description somebody rewrote is not touched.
      await t.sys.subscriptionPlan.update({ where: { key: 'enterprise' }, data: { description: 'Our own words about API access.' } });
      await t.get(ProvisioningService).bootstrapPlatform();
      expect((await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } })).description).toBe('Our own words about API access.');
      await t.sys.subscriptionPlan.update({ where: { key: 'enterprise' }, data: { description: 'Unlimited usage and dedicated deployment options.' } });
    });

    it('a plan without trial days issues an invoice that must be paid', async () => {
      const key = `notrial-${uniq()}`;
      const limits = { branches: 1, staffUsers: 3, monthlyRequests: 100, storageMb: 1024, aiPages: 0, notifications: 100, corporateClients: 0 };
      const features = { whiteLabel: false, customDomains: false, corporatePortal: false, automation: false, aiAssistant: false, scheduledReports: false };
      await t.as(platform).post('/platform/plans', { key, name: 'No Trial', monthlyPrice: '99.00', annualPrice: '990.00', trialDays: 0, limits, features }).expect(201);
      const tenant = await signedUpTenant(t);
      const res = await t.as(tenant.owner).post('/onboarding/plan', { planKey: key, billingCycle: 'MONTHLY' }).expect(201);
      expect(res.body.outcome).toBe('PAYMENT_REQUIRED');
      expect(res.body.subscription).toMatchObject({ status: 'PAST_DUE', trialEndsAt: null });
      expect(res.body.openInvoices).toHaveLength(1);
      expect(res.body.openInvoices[0]).toMatchObject({ reason: 'FIRST_PERIOD', total: '99.00', currency: 'AED' });
      expect(res.body.openInvoices[0].number).toMatch(/^TE-SUB-\d{6}$/);
      expect(res.body.invoiceId).toBe(res.body.openInvoices[0].id);
      await paySandbox(t, tenant.owner, res.body.invoiceId);
      const after = await t.as(tenant.owner).get('/subscription').expect(200);
      expect(after.body.subscription.status).toBe('ACTIVE');
      expect(after.body.openInvoices).toEqual([]);
    });

    it('validates the plan, the cycle and the coupon', async () => {
      const tenant = await signedUpTenant(t);
      expect((await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'no-such-plan', billingCycle: 'MONTHLY' })).body.code).toBe('PLAN_NOT_AVAILABLE');
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'WEEKLY' }).expect(400);
      const bad = await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY', couponCode: 'DOESNOTEXIST' });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('INVALID_COUPON');
      // Nothing was created by the failed attempts.
      expect(await t.sys.subscription.findUnique({ where: { tenantId: tenant.id } })).toBeNull();
    });
  });

  // ---------------------------------------------------------------- upgrade / downgrade
  describe('changing plan', () => {
    const T0 = new Date('2026-03-01T00:00:00.000Z');
    const END = new Date('2026-03-31T00:00:00.000Z'); // 30 days

    it('upgrade: prorated invoice now, features unlock when it is paid (plan enforcement through UsageService)', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, T0, END);
      clockOf(t).set(new Date('2026-03-11T00:00:00.000Z')); // 20 of 30 days left

      // Starter includes one branch.
      const blocked = await t.as(tenant.owner).post('/branches', { code: 'B2', name: 'Second branch' });
      expect(blocked.status).toBe(402);
      expect(blocked.body.code).toBe('PLAN_LIMIT_REACHED');

      const res = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' }).expect(200);
      // (349 - 149) * 20/30 = 133.33
      expect(res.body.change).toMatchObject({ kind: 'UPGRADE', effective: 'AFTER_PAYMENT', amount: '133.33' });
      expect(res.body.plan.key).toBe('starter'); // not yet
      expect(res.body.pendingChange).toMatchObject({ plan: { key: 'professional', name: 'Professional' }, effective: 'AFTER_PAYMENT' });
      const invoice = await openInvoiceOf(t, tenant.id);
      expect(invoice).toMatchObject({ reason: 'UPGRADE', status: 'OPEN', currency: 'AED' });
      expect([invoice.subtotal, invoice.discount, invoice.tax, invoice.total].map((d) => d.toFixed(2))).toEqual(['133.33', '0.00', '0.00', '133.33']);
      expect((invoice.lines as any)[0].description).toMatch(/Upgrade from Starter to Professional - prorated/);
      // Still limited until the invoice is paid.
      await t.as(tenant.owner).post('/branches', { code: 'B2', name: 'Second branch' }).expect(402);

      await paySandbox(t, tenant.owner, invoice.id);
      const after = await t.as(tenant.owner).get('/subscription').expect(200);
      expect(after.body.plan.key).toBe('professional');
      expect(after.body.pendingChange).toBeNull();
      expect(after.body.subscription).toMatchObject({ status: 'ACTIVE', billingCycle: 'MONTHLY', currentPeriodEnd: END.toISOString() }); // the period does not move
      expect(after.body.usage.find((u: any) => u.metric === 'branches')).toEqual({ metric: 'branches', used: 1, limit: 2 });
      await t.as(tenant.owner).post('/branches', { code: 'B2', name: 'Second branch' }).expect(201);
      await t.as(tenant.owner).post('/branches', { code: 'B3', name: 'Third branch' }).expect(402); // professional includes two
      expect((await eventsOf(t, tenant.id, 'PLAN_CHANGED')).map((e) => e.data)).toEqual([expect.objectContaining({ from: 'starter', to: 'professional', at: 'UPGRADE_PAID' })]);
      // The same plan again: nothing to change.
      expect((await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' })).body.code).toBe('NO_CHANGE');
    });

    it('a second upgrade request replaces the first; choosing the current plan withdraws it', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, T0, END);
      clockOf(t).set(new Date('2026-03-16T00:00:00.000Z')); // half way
      await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' }).expect(200);
      const first = await openInvoiceOf(t, tenant.id);
      expect(first.total.toFixed(2)).toBe('100.00');
      const second = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'business' }).expect(200);
      expect(second.body.change.amount).toBe('300.00'); // (749 - 149) / 2
      expect((await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('VOID');
      expect((await openInvoiceOf(t, tenant.id)).total.toFixed(2)).toBe('300.00');
      // A voided invoice cannot be paid.
      expect((await t.as(tenant.owner).post(`/subscription/invoices/${first.id}/pay`)).body.code).toBe('INVOICE_NOT_PAYABLE');
      const withdrawn = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'starter' }).expect(200);
      expect(withdrawn.body.change.kind).toBe('WITHDRAWN');
      expect(withdrawn.body.pendingChange).toBeNull();
      expect(await t.sys.subscriptionInvoice.count({ where: { tenantId: tenant.id, status: 'OPEN' } })).toBe(0);
    });

    it('an upgrade that is not paid before the period ends is carried by the renewal instead', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, T0, END);
      clockOf(t).set(new Date('2026-03-16T00:00:00.000Z'));
      await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' }).expect(200);
      const upgrade = await openInvoiceOf(t, tenant.id);
      clockOf(t).set(new Date('2026-03-31T00:00:01.000Z'));
      await lifecycleOf(t).tick(tenant.id);
      // Paying for a proration of a period that is over would buy nothing: it is voided.
      expect((await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: upgrade.id } })).status).toBe('VOID');
      const renewal = await openInvoiceOf(t, tenant.id);
      expect(renewal.reason).toBe('RENEWAL');
      expect(renewal.total.toFixed(2)).toBe('349.00'); // the new plan's price
      expect((await subOf(t, tenant.id)).plan.key).toBe('starter');
      await paySandbox(t, tenant.owner, renewal.id);
      const sub = await subOf(t, tenant.id);
      expect(sub.plan.key).toBe('professional');
      expect(sub).toMatchObject({ status: 'ACTIVE', pendingPlanId: null });
    });

    it('during a trial the plan changes immediately, without an invoice', async () => {
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      const res = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'business', billingCycle: 'ANNUAL' }).expect(200);
      expect(res.body.change).toMatchObject({ kind: 'UPGRADE', effective: 'NOW', invoiceId: null });
      expect(res.body.plan.key).toBe('business');
      expect(res.body.subscription).toMatchObject({ status: 'TRIALING', billingCycle: 'ANNUAL' });
      expect(await invoicesOf(t, tenant.id)).toHaveLength(0);
      await t.as(tenant.owner).post('/branches', { code: 'B2', name: 'Second branch' }).expect(201); // business: five branches
    });

    it('downgrade: refused while current usage exceeds the new plan, otherwise scheduled for the period end', async () => {
      const tenant = await t.createTenant({ plan: 'professional' });
      await setPeriod(t, tenant.id, T0, END);
      clockOf(t).set(new Date('2026-03-11T00:00:00.000Z'));
      const branch = (await t.as(tenant.owner).post('/branches', { code: 'B2', name: 'Second branch' }).expect(201)).body;
      await t.addStaff(tenant, 'receptionist');
      await t.addStaff(tenant, 'operator');
      const extra = await t.addStaff(tenant, 'accountant'); // 4 staff users with the owner; starter includes 3

      const blocked = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'starter' });
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('DOWNGRADE_BLOCKED_BY_USAGE');
      expect(blocked.body.details.exceeded).toEqual([
        { metric: 'branches', used: 2, limit: 1 },
        { metric: 'staffUsers', used: 4, limit: 3 },
      ]);
      expect(blocked.body.message).toMatch(/2 active branches \(the Starter plan includes 1\) and 4 staff users/);
      expect((await subOf(t, tenant.id)).pendingPlanId).toBeNull();

      // Corporate clients and stored documents count too.
      await t.as(tenant.owner).patch(`/branches/${branch.id}`, { isActive: false }).expect(200);
      await t.sys.tenantMembership.updateMany({ where: { tenantId: tenant.id, userId: extra.userId }, data: { status: 'REMOVED' } });
      await t.sys.corporateAccount.create({ data: { tenantId: tenant.id, accountNo: `CORP-${uniq()}`, companyName: 'Gulf Trading LLC', status: 'ACTIVE' } });
      await t.sys.usageRecord.create({ data: { tenantId: tenant.id, metric: 'storageBytes', periodKey: 'total', quantity: 3000 * 1024 * 1024 } });
      const stillBlocked = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'starter' });
      expect(stillBlocked.body.details.exceeded).toEqual([
        { metric: 'corporateClients', used: 1, limit: 0 },
        { metric: 'storageMb', used: 3000, limit: 2048 },
      ]);
      await t.sys.corporateAccount.updateMany({ where: { tenantId: tenant.id }, data: { status: 'ARCHIVED' } });
      await t.sys.usageRecord.updateMany({ where: { tenantId: tenant.id, metric: 'storageBytes' }, data: { quantity: 100 * 1024 * 1024 } });

      const ok = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'starter' }).expect(200);
      expect(ok.body.change).toMatchObject({ kind: 'DOWNGRADE', effective: 'PERIOD_END', invoiceId: null });
      expect(ok.body.plan.key).toBe('professional'); // until the period ends
      expect(ok.body.pendingChange).toMatchObject({ plan: { key: 'starter' }, effective: 'PERIOD_END', effectiveAt: END.toISOString() });
      expect(await invoicesOf(t, tenant.id)).toHaveLength(0);

      // The renewal is invoiced at the NEW plan's price; when the period ends the downgrade takes effect.
      clockOf(t).set(new Date('2026-03-25T00:00:00.000Z'));
      await lifecycleOf(t).tick(tenant.id);
      const renewal = await openInvoiceOf(t, tenant.id);
      expect(renewal).toMatchObject({ reason: 'RENEWAL' });
      expect(renewal.total.toFixed(2)).toBe('149.00');
      await paySandbox(t, tenant.owner, renewal.id);
      expect((await subOf(t, tenant.id)).plan.key).toBe('professional'); // paid ahead; the period has not ended yet
      clockOf(t).set(new Date('2026-03-31T00:00:01.000Z'));
      await lifecycleOf(t).tick(tenant.id);
      const sub = await subOf(t, tenant.id);
      expect(sub.plan.key).toBe('starter');
      expect(sub).toMatchObject({ status: 'ACTIVE', pendingPlanId: null });
      expect(sub.currentPeriodStart.toISOString()).toBe(END.toISOString());
      expect(sub.currentPeriodEnd.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    });

    it('switching monthly <-> annual happens at the period end', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, T0, END);
      clockOf(t).set(new Date('2026-03-11T00:00:00.000Z'));
      const res = await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'starter', billingCycle: 'ANNUAL' }).expect(200);
      expect(res.body.change).toMatchObject({ kind: 'CYCLE_ONLY', effective: 'PERIOD_END' });
      expect(res.body.subscription.billingCycle).toBe('MONTHLY');
      expect(res.body.pendingChange).toMatchObject({ plan: null, billingCycle: 'ANNUAL' });
      clockOf(t).set(new Date('2026-03-31T00:00:01.000Z'));
      await lifecycleOf(t).tick(tenant.id);
      const renewal = await openInvoiceOf(t, tenant.id);
      expect(renewal.total.toFixed(2)).toBe('1490.00');
      expect(renewal.periodEnd.toISOString()).toBe('2027-03-31T00:00:00.000Z');
      await paySandbox(t, tenant.owner, renewal.id);
      const sub = await subOf(t, tenant.id);
      expect(sub).toMatchObject({ status: 'ACTIVE', billingCycle: 'ANNUAL', pendingCycle: null });
      expect(sub.currentPeriodEnd.toISOString()).toBe('2027-03-31T00:00:00.000Z');
    });

    it('is refused while an invoice is overdue or after the subscription ended', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await t.sys.subscription.update({ where: { tenantId: tenant.id }, data: { status: 'PAST_DUE' } });
      expect((await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' })).body.code).toBe('PAYMENT_OUTSTANDING');
      await t.sys.subscription.update({ where: { tenantId: tenant.id }, data: { status: 'CANCELLED' } });
      expect((await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' })).body.code).toBe('SUBSCRIPTION_NOT_ACTIVE');
    });
  });

  // ---------------------------------------------------------------- coupons on subscriptions
  describe('coupons on a subscription', () => {
    const T0 = new Date('2026-03-01T00:00:00.000Z');
    const END = new Date('2026-03-31T00:00:00.000Z');

    it('applies the discount to the next invoices, counts the months and is exhausted after the last redemption', async () => {
      const coupon = await newCoupon({ percentOff: 50, durationMonths: 2, maxRedemptions: 1 });
      const a = await t.createTenant({ plan: 'starter' });
      const b = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, a.id, T0, END);
      clockOf(t).set(new Date('2026-03-20T00:00:00.000Z'));

      const applied = await t.as(a.owner).post('/subscription/coupon', { code: coupon.code.toLowerCase() }).expect(200); // codes are case-insensitive
      expect(applied.body.coupon).toMatchObject({ code: coupon.code, percentOff: '50.00', endsAt: '2026-05-20T00:00:00.000Z' });
      expect((await t.sys.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redeemedCount).toBe(1);

      // Exhausted for everyone else; and not twice for the same centre.
      const exhausted = await t.as(b.owner).post('/subscription/coupon', { code: coupon.code });
      expect(exhausted.status).toBe(422);
      expect(exhausted.body.code).toBe('COUPON_EXHAUSTED');
      expect((await t.as(a.owner).post('/subscription/coupon', { code: coupon.code })).body.code).toBe('COUPON_ALREADY_APPLIED');
      expect((await t.sys.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redeemedCount).toBe(1);

      // Renewal 1 (period starts 31 March, before the coupon ends on 20 May): 50% off.
      clockOf(t).set(new Date('2026-03-31T00:00:01.000Z'));
      await lifecycleOf(t).tick(a.id);
      let invoice = await openInvoiceOf(t, a.id);
      expect([invoice.subtotal, invoice.discount, invoice.total].map((d) => d.toFixed(2))).toEqual(['149.00', '74.50', '74.50']);
      expect((invoice.lines as any)[0].couponCode).toBe(coupon.code);
      await paySandbox(t, a.owner, invoice.id);
      // Renewal 2 (30 April): still discounted. Renewal 3 (30 May): full price, coupon gone.
      clockOf(t).set(new Date('2026-04-30T00:00:01.000Z'));
      await lifecycleOf(t).tick(a.id);
      invoice = await openInvoiceOf(t, a.id);
      expect(invoice.total.toFixed(2)).toBe('74.50');
      await paySandbox(t, a.owner, invoice.id);
      expect((await subOf(t, a.id)).couponId).toBe(coupon.id);
      clockOf(t).set(new Date('2026-05-30T00:00:01.000Z'));
      await lifecycleOf(t).tick(a.id);
      invoice = await openInvoiceOf(t, a.id);
      expect([invoice.discount, invoice.total].map((d) => d.toFixed(2))).toEqual(['0.00', '149.00']);
      await paySandbox(t, a.owner, invoice.id);
      const sub = await subOf(t, a.id);
      expect(sub.couponId).toBeNull();
      expect((await eventsOf(t, a.id, 'COUPON_ENDED')).length).toBe(1);
      expect((await t.as(a.owner).get('/subscription')).body.coupon).toBeNull();
      // The same centre can never use the same coupon again, even after raising the limit.
      await t.as(platform).patch(`/platform/coupons/${coupon.id}`, { maxRedemptions: 10 }).expect(200);
      expect((await t.as(a.owner).post('/subscription/coupon', { code: coupon.code })).body.code).toBe('COUPON_ALREADY_USED');
      await t.as(b.owner).post('/subscription/coupon', { code: coupon.code }).expect(200);
      // A redeemed coupon can only be deactivated.
      expect((await t.as(platform).delete(`/platform/coupons/${coupon.id}`)).body.code).toBe('COUPON_IN_USE');
    });

    it('refuses expired, inactive, not-yet-valid and wrong-plan coupons', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      const apply = async (c: any) => (await t.as(tenant.owner).post('/subscription/coupon', { code: c.code })).body;
      const expiring = await newCoupon({ percentOff: 10, validUntil: new Date(Date.now() + 3_600_000).toISOString() });
      clockOf(t).advanceDays(1);
      expect(await apply(expiring)).toMatchObject({ code: 'INVALID_COUPON', details: { problem: 'EXPIRED' } });
      clockOf(t).reset();
      expect(await apply(await newCoupon({ percentOff: 10, validFrom: new Date(Date.now() + DAY).toISOString() }))).toMatchObject({ code: 'INVALID_COUPON', details: { problem: 'NOT_STARTED' } });
      expect(await apply(await newCoupon({ percentOff: 10, isActive: false }))).toMatchObject({ code: 'INVALID_COUPON', details: { problem: 'INACTIVE' } });
      expect(await apply(await newCoupon({ percentOff: 10, planKeys: ['business'] }))).toMatchObject({ code: 'INVALID_COUPON', details: { problem: 'WRONG_PLAN' } });
      expect((await subOf(t, tenant.id)).couponId).toBeNull();
    });

    it('a fixed-amount coupon chosen at sign-up reduces the first invoice; an open invoice is re-issued when a coupon is added', async () => {
      const fixed = await newCoupon({ amountOff: '49.00' });
      const tenant = await signedUpTenant(t);
      const started = await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY', couponCode: fixed.code }).expect(201);
      expect(started.body.coupon).toMatchObject({ code: fixed.code, amountOff: '49.00', endsAt: null });
      clockOf(t).advanceDays(14.01);
      await lifecycleOf(t).tick(tenant.id);
      const first = await openInvoiceOf(t, tenant.id);
      expect([first.subtotal, first.discount, first.total].map((d) => d.toFixed(2))).toEqual(['149.00', '49.00', '100.00']);

      // Another centre with an open, undiscounted invoice adds a coupon: the invoice is voided and re-issued.
      const half = await newCoupon({ percentOff: 50 });
      const other = await signedUpTenant(t);
      clockOf(t).reset();
      await t.as(other.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      clockOf(t).advanceDays(14.01);
      await lifecycleOf(t).tick(other.id);
      const original = await openInvoiceOf(t, other.id);
      expect(original.total.toFixed(2)).toBe('149.00');
      await t.as(other.owner).post('/subscription/coupon', { code: half.code }).expect(200);
      const reissued = await openInvoiceOf(t, other.id);
      expect(reissued.id).not.toBe(original.id);
      expect(reissued.total.toFixed(2)).toBe('74.50');
      expect(reissued).toMatchObject({ attemptCount: original.attemptCount + 0, reason: 'FIRST_PERIOD' });
      expect((await t.sys.subscriptionInvoice.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('VOID');
    });

    it('a 100% coupon makes the invoice free: it is settled without a payment', async () => {
      const free = await newCoupon({ percentOff: 100, durationMonths: 1 });
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY', couponCode: free.code }).expect(201);
      await completeOnboarding(t, tenant);
      clockOf(t).advanceDays(14.01);
      await lifecycleOf(t).tick(tenant.id);
      const invoices = await invoicesOf(t, tenant.id);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ status: 'PAID', paymentMethod: 'NONE' });
      expect(invoices[0].total.toFixed(2)).toBe('0.00');
      expect((await subOf(t, tenant.id)).status).toBe('ACTIVE');
      expect((await tenantOf(t, tenant.id)).status).toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------- access
  describe('access', () => {
    let alpha: TenantFixture;
    let beta: TenantFixture;
    let alphaInvoiceId: string;

    beforeAll(async () => {
      alpha = await t.createTenant({ plan: 'starter', name: 'Alpha Typing' });
      beta = await t.createTenant({ plan: 'professional', name: 'Beta Typing' });
      await setPeriod(t, alpha.id, new Date(Date.now() - 15 * DAY), new Date(Date.now() + 15 * DAY));
      await t.as(alpha.owner).post('/subscription/change-plan', { planKey: 'professional' }).expect(200);
      alphaInvoiceId = (await openInvoiceOf(t, alpha.id)).id;
    });

    it('a tenant cannot see or pay another tenant\'s subscription or invoices', async () => {
      const mine = await t.as(alpha.owner).get('/subscription/invoices').expect(200);
      expect(mine.body.data.map((i: any) => i.id)).toEqual([alphaInvoiceId]);
      expect(mine.body.data[0].gatewayRef).toBeUndefined();
      await t.as(alpha.owner).get(`/subscription/invoices/${alphaInvoiceId}`).expect(200);
      const theirs = await t.as(beta.owner).get('/subscription/invoices').expect(200);
      expect(theirs.body.data).toHaveLength(0);
      await t.as(beta.owner).get(`/subscription/invoices/${alphaInvoiceId}`).expect(404);
      await t.as(beta.owner).get(`/subscription/invoices/${alphaInvoiceId}/pdf`).expect(404);
      await t.as(beta.owner).post(`/subscription/invoices/${alphaInvoiceId}/pay`).expect(404);
      const betaView = await t.as(beta.owner).get('/subscription').expect(200);
      expect(betaView.body.plan.key).toBe('professional');
      expect(betaView.body.subscription.id).toBe((await subOf(t, beta.id)).id);
      expect(betaView.body.openInvoices).toEqual([]);
      // The owner's own invoice as PDF.
      const pdf = await t.as(alpha.owner).get(`/subscription/invoices/${alphaInvoiceId}/pdf`).buffer(true).parse(binary).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('row-level security: billing state is read-only for the tenant connection and invisible across tenants', async () => {
      const rows = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.subscriptionInvoice.findMany()));
      expect(rows.every((r) => r.tenantId === beta.id)).toBe(true);
      const subs = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.subscription.findMany()));
      expect(subs.map((s) => s.tenantId)).toEqual([beta.id]);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.subscription.updateMany({ where: { tenantId: alpha.id }, data: { status: 'ACTIVE', currentPeriodEnd: new Date('2099-01-01') } })))).rejects.toThrow(/permission denied/);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.subscriptionInvoice.updateMany({ where: { id: alphaInvoiceId }, data: { status: 'PAID' } })))).rejects.toThrow(/permission denied/);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.coupon.findMany()))).rejects.toThrow(/permission denied/);
    });

    it('only the owner (subscription.manage) can see or manage the subscription', async () => {
      const manager = await t.addStaff(alpha, 'manager');
      const accountant = await t.addStaff(alpha, 'accountant');
      const customer = await t.addCustomer(alpha);
      for (const actor of [manager, accountant, customer]) {
        await t.as(actor).get('/subscription').expect(403);
        await t.as(actor).get('/subscription/invoices').expect(403);
        await t.as(actor).post('/subscription/change-plan', { planKey: 'business' }).expect(403);
        await t.as(actor).post('/subscription/cancel', { reason: 'not allowed' }).expect(403);
        await t.as(actor).post('/subscription/resume').expect(403);
        await t.as(actor).post('/subscription/coupon', { code: 'ANYCODE' }).expect(403);
        await t.as(actor).post(`/subscription/invoices/${alphaInvoiceId}/pay`).expect(403);
        await t.as(actor).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(403);
      }
      await t.as(null).get('/subscription').expect(401);
      expect((await subOf(t, alpha.id)).cancelAtPeriodEnd).toBe(false);
    });

    it('answers 503 when no platform payment gateway is configured', async () => {
      const e = env() as { PAYMENT_SANDBOX_ENABLED: boolean };
      e.PAYMENT_SANDBOX_ENABLED = false;
      try {
        const res = await t.as(alpha.owner).post(`/subscription/invoices/${alphaInvoiceId}/pay`);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('INTEGRATION_NOT_CONFIGURED');
        await t.http.post('/api/v1/public/webhooks/subscriptions/sandbox').send({ id: 'x' }).expect(404);
      } finally {
        e.PAYMENT_SANDBOX_ENABLED = true;
      }
    });
  });

  // ---------------------------------------------------------------- platform billing administration
  describe('platform billing administration', () => {
    it('lists subscriptions with filters and shows a centre\'s billing history', async () => {
      const tenant = await t.createTenant({ plan: 'business', name: `Zenith ${uniq()}` });
      const list = await t.as(platform).get(`/platform/billing/subscriptions?planKey=business&status=ACTIVE&q=${encodeURIComponent(tenant.name)}`).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ tenantId: tenant.id, status: 'ACTIVE', plan: { key: 'business', monthlyPrice: '749.00' }, tenant: { slug: tenant.slug, status: 'ACTIVE' } });
      const none = await t.as(platform).get(`/platform/billing/subscriptions?status=EXPIRED&tenantId=${tenant.id}`).expect(200);
      expect(none.body.data).toHaveLength(0);
      const history = await t.as(platform).get(`/platform/billing/tenants/${tenant.id}`).expect(200);
      expect(history.body.tenant.id).toBe(tenant.id);
      expect(history.body.subscription.plan.key).toBe('business');
      expect(history.body).toMatchObject({ invoices: [], events: [] });
      await t.as(platform).get('/platform/billing/tenants/00000000-0000-4000-8000-000000000000').expect(404);
      await t.as(tenant.owner).get(`/platform/billing/tenants/${tenant.id}`).expect(403);
      await t.as(support).get(`/platform/billing/tenants/${tenant.id}`).expect(403);
    });

    it('records an offline bank transfer for a subscription invoice', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, new Date(Date.now() - 15 * DAY), new Date(Date.now() + 15 * DAY));
      await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' }).expect(200);
      const invoice = await openInvoiceOf(t, tenant.id);
      await t.as(platform).post(`/platform/billing/invoices/${invoice.id}/pay-offline`, {}).expect(400);
      await t.as(tenant.owner).post(`/platform/billing/invoices/${invoice.id}/pay-offline`, { reference: 'TRF-1' }).expect(403);
      const res = await t.as(platform).post(`/platform/billing/invoices/${invoice.id}/pay-offline`, { reference: 'ENBD TRF 20260310-7781' }).expect(200);
      expect(res.body.invoice).toMatchObject({ status: 'PAID', paymentMethod: 'OFFLINE:BANK_TRANSFER', gatewayRef: 'ENBD TRF 20260310-7781' });
      expect(res.body.subscription.plan.key).toBe('professional');
      expect(res.body.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['INVOICE_PAID', 'PLAN_CHANGED']));
      expect((await t.as(platform).post(`/platform/billing/invoices/${invoice.id}/pay-offline`, { reference: 'again' })).body.code).toBe('INVOICE_NOT_PAYABLE');
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'platform.subscription_offline_payment' } });
      expect(audit).toMatchObject({ actorUserId: platform.userId, actorType: 'PLATFORM' });
      // Never a tenant payment.
      expect(await t.sys.payment.count({ where: { tenantId: tenant.id } })).toBe(0);
    });

    it('extends a trial, also one that has just run out unpaid', async () => {
      const tenant = await signedUpTenant(t);
      await t.as(tenant.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      await completeOnboarding(t, tenant);
      const before = await subOf(t, tenant.id);
      await t.as(platform).post(`/platform/billing/tenants/${tenant.id}/extend-trial`, { days: 10 }).expect(400); // reason required
      const res = await t.as(platform).post(`/platform/billing/tenants/${tenant.id}/extend-trial`, { days: 10, reason: 'Owner travelling' }).expect(200);
      expect(new Date(res.body.subscription.trialEndsAt).getTime()).toBe(before.trialEndsAt!.getTime() + 10 * DAY);
      expect(res.body.subscription.currentPeriodEnd).toBe(res.body.subscription.trialEndsAt);

      clockOf(t).advanceDays(24.01);
      await lifecycleOf(t).tick(tenant.id);
      expect((await subOf(t, tenant.id)).status).toBe('PAST_DUE');
      expect((await tenantOf(t, tenant.id)).status).toBe('PAST_DUE');
      const reopened = await t.as(platform).post(`/platform/billing/tenants/${tenant.id}/extend-trial`, { days: 7, reason: 'Second chance' }).expect(200);
      expect(reopened.body.subscription.status).toBe('TRIALING');
      expect((await tenantOf(t, tenant.id)).status).toBe('TRIAL');
      expect(await t.sys.subscriptionInvoice.count({ where: { tenantId: tenant.id, status: 'OPEN' } })).toBe(0);
      // A paying centre is not "in trial".
      const paying = await t.createTenant({ plan: 'starter' });
      expect((await t.as(platform).post(`/platform/billing/tenants/${paying.id}/extend-trial`, { days: 7, reason: 'Asked for more time' })).body.code).toBe('NOT_IN_TRIAL');
    });

    it('applies a coupon, voids an invoice and changes the plan on a centre\'s behalf', async () => {
      const tenant = await t.createTenant({ plan: 'starter' });
      await setPeriod(t, tenant.id, new Date(Date.now() - 15 * DAY), new Date(Date.now() + 15 * DAY));
      const coupon = await newCoupon({ percentOff: 20 });
      const applied = await t.as(platform).post(`/platform/billing/tenants/${tenant.id}/coupon`, { code: coupon.code }).expect(200);
      expect(applied.body.subscription.coupon.code).toBe(coupon.code);

      // The centre asks for an upgrade, then changes its mind: billing voids the invoice.
      await t.as(tenant.owner).post('/subscription/change-plan', { planKey: 'professional' }).expect(200);
      const invoice = await openInvoiceOf(t, tenant.id);
      expect(invoice.discount.toFixed(2)).toBe('20.00'); // 20% of the 100.00 proration
      const voided = await t.as(platform).post(`/platform/billing/invoices/${invoice.id}/void`, { reason: 'Requested by the owner' }).expect(200);
      expect(voided.body.invoices.find((i: any) => i.id === invoice.id).status).toBe('VOID');
      expect(voided.body.subscription.pendingPlanId).toBeNull();
      expect((await t.as(platform).post(`/platform/billing/invoices/${invoice.id}/void`, { reason: 'twice' })).body.code).toBe('INVOICE_NOT_OPEN');

      // TypEase moves the centre to a non-public plan immediately, without a proration invoice.
      const key = `partner-${uniq()}`;
      const limits = { branches: 10, staffUsers: 50, monthlyRequests: -1, storageMb: -1, aiPages: -1, notifications: -1, corporateClients: -1 };
      const features = { whiteLabel: true, customDomains: true, corporatePortal: true, automation: true, aiAssistant: true, scheduledReports: true };
      await t.as(platform).post('/platform/plans', { key, name: 'Partner', monthlyPrice: '999.00', annualPrice: '9990.00', trialDays: 0, limits, features, isPublic: false }).expect(201);
      // The centre itself cannot choose a private plan.
      expect((await t.as(tenant.owner).post('/subscription/change-plan', { planKey: key })).body.code).toBe('PLAN_NOT_AVAILABLE');
      const changed = await t.as(platform).post(`/platform/billing/tenants/${tenant.id}/change-plan`, { planKey: key, immediate: true, reason: 'Partner agreement signed' }).expect(200);
      expect(changed.body.change).toMatchObject({ kind: 'UPGRADE', effective: 'NOW' });
      expect(changed.body.subscription.plan.key).toBe(key);
      expect(await t.sys.subscriptionInvoice.count({ where: { tenantId: tenant.id, status: 'OPEN' } })).toBe(0);
      await t.as(tenant.owner).post('/branches', { code: 'B2', name: 'Second branch' }).expect(201);
      // On behalf, the usage rule still protects the centre from an impossible downgrade.
      const blocked = await t.as(platform).post(`/platform/billing/tenants/${tenant.id}/change-plan`, { planKey: 'starter', immediate: true, reason: 'Agreement ended' });
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('DOWNGRADE_BLOCKED_BY_USAGE');
    });
  });

  // ---------------------------------------------------------------- numbering
  describe('SaaS invoice numbering', () => {
    it('is global, sequential and safe under concurrency', async () => {
      const core = t.get(BillingCore);
      const tenants = await Promise.all([t.createTenant({ plan: 'starter' }), t.createTenant({ plan: 'starter' }), t.createTenant({ plan: 'professional' })]);
      const subs = await Promise.all(tenants.map((x) => subOf(t, x.id)));
      const before = await t.sys.subscriptionInvoice.count();
      const start = new Date('2030-01-01T00:00:00Z');
      const created = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          core.tx((tx) => core.createInvoice(tx, subs[i % 3] as any, { reason: 'RENEWAL', plan: subs[i % 3].plan, cycle: 'MONTHLY', periodStart: new Date(start.getTime() + i * DAY), periodEnd: new Date(start.getTime() + (i + 30) * DAY), dueAt: start })),
        ),
      );
      const numbers = created.map((c) => Number(c.number.replace('TE-SUB-', ''))).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(12);
      expect(created.every((c) => /^TE-SUB-\d{6}$/.test(c.number))).toBe(true);
      // Consecutive: no gaps and no duplicates across tenants.
      expect(numbers[numbers.length - 1] - numbers[0]).toBe(11);
      expect(await t.sys.subscriptionInvoice.count()).toBe(before + 12);
      // A rolled-back invoice does not burn a number.
      await expect(
        core.tx(async (tx) => {
          await core.createInvoice(tx, subs[0] as any, { reason: 'RENEWAL', plan: subs[0].plan, cycle: 'MONTHLY', periodStart: start, periodEnd: new Date(start.getTime() + 30 * DAY), dueAt: start });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const next = await core.tx((tx) => core.createInvoice(tx, subs[0] as any, { reason: 'RENEWAL', plan: subs[0].plan, cycle: 'MONTHLY', periodStart: start, periodEnd: new Date(start.getTime() + 30 * DAY), dueAt: start }));
      expect(Number(next.number.replace('TE-SUB-', ''))).toBe(numbers[numbers.length - 1] + 1);
    });
  });
});

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
