import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { env } from '../../config/env';
import { createCustomer, issueInvoice } from '../finance/fixtures';
import { completeOnboarding, lifecycleOf, signedUpTenant } from '../subscriptions/fixtures';
import { auditOf, newCentre, subscriptionRow, tenantRow } from './fixtures';

describe('Platform: tenants', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let agent: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing Centre', plan: 'professional' });
    beta = await t.createTenant({ name: 'Beta Documents', plan: 'business' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------ access
  it('is for platform staff only; a support agent can read but not manage', async () => {
    const customer = await t.addCustomer(alpha);
    const manager = await t.addStaff(alpha, 'manager');
    for (const actor of [alpha.owner, manager, customer]) {
      await t.as(actor).get('/platform/tenants').expect(403);
      await t.as(actor).get(`/platform/tenants/${alpha.id}`).expect(403);
      await t.as(actor).post('/platform/tenants', newCentre()).expect(403);
      await t.as(actor).post(`/platform/tenants/${beta.id}/suspend`, { reason: 'I would like to' }).expect(403);
      await t.as(actor).get('/platform/dashboard').expect(403);
    }
    await t.as(null).get('/platform/tenants').expect(401);
    await t.as(agent).get('/platform/tenants').expect(200);
    await t.as(agent).get(`/platform/tenants/${alpha.id}`).expect(200);
    await t.as(agent).post('/platform/tenants', newCentre()).expect(403);
    for (const action of ['approve', 'reject', 'suspend', 'reactivate', 'archive', 'offboard', 'cancel-offboarding', 'owner-invitation']) {
      await t.as(agent).post(`/platform/tenants/${alpha.id}/${action}`, { reason: 'Not allowed to do this', note: 'x' }).expect(403);
    }
    expect((await tenantRow(t, alpha.id)).status).toBe('ACTIVE');
  });

  // ------------------------------------------------------------------ list
  it('lists centres with search, status, plan and creation-date filters', async () => {
    const all = await t.as(admin).get('/platform/tenants?pageSize=100').expect(200);
    const ids = all.body.data.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    expect(all.body.meta.total).toBe(await t.sys.tenant.count());
    const row = all.body.data.find((r: any) => r.id === alpha.id);
    expect(row).toMatchObject({ slug: alpha.slug, name: 'Alpha Typing Centre', status: 'ACTIVE', plan: { key: 'professional', name: 'Professional' }, subscription: { status: 'ACTIVE', billingCycle: 'MONTHLY' }, offboardingAt: null });
    expect(Object.keys(row).sort()).toEqual(['archivedAt', 'contactEmail', 'contactPhone', 'createdAt', 'emirate', 'id', 'legalName', 'name', 'offboardingAt', 'plan', 'slug', 'status', 'subscription', 'suspendedAt', 'suspensionReason']);

    const list = async (qs: string) => (await t.as(admin).get(`/platform/tenants?pageSize=100&${qs}`).expect(200)).body.data.map((r: any) => r.id) as string[];
    // Other suites share this database and also create centres called "Alpha Typing": every hit must match, ours must be among them.
    const byName = (await t.as(admin).get('/platform/tenants?pageSize=100&q=alpha%20typing').expect(200)).body.data as Array<{ id: string; name: string; legalName: string | null }>;
    expect(byName.map((r) => r.id)).toContain(alpha.id);
    expect(byName.map((r) => r.id)).not.toContain(beta.id);
    expect(byName.every((r) => /alpha typing/i.test(`${r.name} ${r.legalName ?? ''}`))).toBe(true);
    expect(await list(`q=${alpha.slug}`)).toEqual([alpha.id]);
    expect(await list('plan=business')).toContain(beta.id);
    expect(await list('plan=business')).not.toContain(alpha.id);
    expect(await list('plan=professional')).toContain(alpha.id);
    expect(await list('status=ARCHIVED')).not.toContain(alpha.id);
    const noPlan = await signedUpTenant(t, 'No Plan Yet');
    expect(await list('plan=none')).toContain(noPlan.id);
    expect(await list('status=ONBOARDING')).toContain(noPlan.id);
    const today = new Date().toISOString().slice(0, 10);
    expect(await list(`createdFrom=${today}&createdTo=${today}`)).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    expect(await list('createdTo=2010-01-01')).toEqual([]); // other suites back-date centres to 2019 - 2021
    expect(await list('offboarding=true')).not.toContain(alpha.id);
    // Sorting is restricted to an allow-list; paging works.
    const page = await t.as(admin).get('/platform/tenants?pageSize=1&page=2&sort=name:asc').expect(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, pageSize: 1 });
    await t.as(admin).get('/platform/tenants?status=NOPE').expect(400);
  });

  // ------------------------------------------------------------------ detail
  it('shows centre-level metadata only: no customers, documents or financial records of the centre', async () => {
    // Things that exist inside the centre and must not leak into the platform view.
    const customer = await createCustomer(t, alpha, { fullName: 'Zubaida Qasimi-Leaktest' });
    const invoice = await issueInvoice(t, alpha.owner, customer.id);
    await t.sys.document.create({ data: { tenantId: alpha.id, customerId: customer.id, documentTypeKey: 'passport', title: 'Passport copy LEAKTEST-DOC' } });
    await t.as(alpha.owner).post('/branches', { code: 'DXB2', name: 'Second Branch' }).expect(201);
    await t.addStaff(alpha, 'receptionist');
    await t.sys.tenantDomain.create({ data: { tenantId: alpha.id, domain: `portal-${uniq()}.example.ae`, verificationToken: 'tok', status: 'VERIFIED', isPrimary: true, verifiedAt: new Date() } });

    const res = await t.as(agent).get(`/platform/tenants/${alpha.id}`).expect(200);
    expect(res.body).toMatchObject({
      id: alpha.id, slug: alpha.slug, name: 'Alpha Typing Centre', status: 'ACTIVE', offboardingAt: null,
      profile: { country: 'AE', emirate: 'Dubai', timezone: 'Asia/Dubai', defaultCurrency: 'AED' },
      subscription: { status: 'ACTIVE', billingCycle: 'MONTHLY', plan: { key: 'professional', currency: 'AED' } },
      counts: { branches: { total: 2, active: 2 } },
      support: { openPlatformTickets: 0, pendingAccessRequests: 0, activeAccessGrants: 0 },
    });
    expect(res.body.owners).toHaveLength(1);
    expect(res.body.owners[0]).toMatchObject({ userId: alpha.owner.userId, email: alpha.owner.email, status: 'ACTIVE', emailVerified: true });
    expect(res.body.owners[0].phone).toMatch(/^\+9715/);
    expect(res.body.counts.staff.active).toBeGreaterThanOrEqual(3);
    // Usage against the plan limits, exactly as the owner sees it.
    const ownerView = await t.as(alpha.owner).get('/tenant/usage').expect(200);
    expect(res.body.usage).toEqual(ownerView.body.usage);
    expect(res.body.usage.find((u: any) => u.metric === 'branches')).toEqual({ metric: 'branches', used: 2, limit: 2 });
    expect(res.body.domains).toHaveLength(1);
    expect(res.body.domains[0]).toMatchObject({ status: 'VERIFIED', isPrimary: true });
    expect(res.body.onboarding.steps.map((s: any) => s.key)).toEqual(['account', 'business', 'plan', 'branding', 'services', 'branches', 'staff']);
    expect(res.body.onboarding.steps.find((s: any) => s.key === 'plan').done).toBe(true);
    expect(res.body.lastActivity.at).toBeTruthy();
    expect(res.body.lastActivity.lastLoginAt).toBeTruthy();

    const text = JSON.stringify(res.body);
    for (const secret of ['Zubaida', 'Leaktest', 'LEAKTEST-DOC', invoice.invoiceNo, customer.customerNo, customer.email!]) expect(text).not.toContain(secret);
    for (const key of ['customers', 'documents', 'invoices', 'payments', 'requests', 'settings', 'onboardingData', 'passwordHash']) expect(text).not.toContain(`"${key}"`);
    await t.as(admin).get('/platform/tenants/6f1c3c9e-2a54-4d0b-9d3e-8b1c5a7f0e11').expect(404);
    await t.as(admin).get('/platform/tenants/not-a-uuid').expect(400);
  });

  // ------------------------------------------------------------------ create on behalf
  describe('creating a centre on behalf of a customer', () => {
    it('provisions the workspace and invites the owner, who chooses their own password', async () => {
      const body = newCentre({ legalName: 'Invited Centre LLC', emirate: 'Sharjah', ownerPhone: '+971 50 765 4321'.replace('4321', String(Math.floor(1000 + Math.random() * 8999))), planKey: 'starter', billingCycle: 'ANNUAL' });
      const res = await t.as(admin).post('/platform/tenants', body).expect(201);
      expect(res.body).toMatchObject({
        slug: body.slug, name: body.businessName, legalName: 'Invited Centre LLC', status: 'ONBOARDING',
        profile: { emirate: 'Sharjah', contactEmail: body.ownerEmail },
        plan: { outcome: 'TRIAL_STARTED', invoiceId: null },
        subscription: { status: 'TRIALING', billingCycle: 'ANNUAL', plan: { key: 'starter' } },
        invitation: { email: body.ownerEmail, status: 'SENT' },
        counts: { branches: { total: 1, active: 1 }, staff: { active: 0, invited: 1 } },
      });
      expect(res.body.owners).toHaveLength(1);
      expect(res.body.owners[0]).toMatchObject({ email: body.ownerEmail, status: 'INVITED', emailVerified: false });
      const id = res.body.id;
      // Provisioned like a self-service sign-up: system roles, head office, default categories.
      expect(await t.sys.role.count({ where: { tenantId: id } })).toBeGreaterThanOrEqual(7);
      expect(await t.sys.branch.count({ where: { tenantId: id, isHeadOffice: true } })).toBe(1);
      expect(await t.sys.serviceCategory.count({ where: { tenantId: id } })).toBeGreaterThan(0);
      // The owner account has NO password: platform staff never set or see one.
      const user = await t.sys.user.findUniqueOrThrow({ where: { email: body.ownerEmail } });
      expect(user.passwordHash).toBeNull();
      // The invitation went out through the normal invitation mail.
      const mail = t.messenger.lastFor(body.ownerEmail, 'staff.invitation');
      expect(mail).toBeTruthy();
      expect(mail!.data).toMatchObject({ centre: body.businessName, role: 'Centre Owner' });
      expect(String(mail!.data.link)).toContain(res.body.invitation.dev.invitationToken);
      // Both audit trails.
      const audit = await auditOf(t, 'tenant.created_by_platform', id);
      expect(audit.platform).toHaveLength(1);
      expect(audit.platform[0]).toMatchObject({ actorUserId: admin.userId, actorType: 'PLATFORM' });
      expect(audit.centre.map((r) => r.tenantId)).toEqual([id]);

      // The owner cannot sign in before accepting; then accepts and works in the centre.
      await t.http.post('/api/v1/auth/login').send({ email: body.ownerEmail, password: PASSWORD, app: 'centre' }).expect(401);
      const again = await t.as(admin).post(`/platform/tenants/${id}/owner-invitation`).expect(200);
      expect(again.body.dev.invitationToken).not.toBe(res.body.invitation.dev.invitationToken);
      // The first link was replaced by the second.
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: res.body.invitation.dev.invitationToken, password: PASSWORD, app: 'centre' }).expect(400);
      const accepted = await t.http.post('/api/v1/auth/invitations/accept').send({ token: again.body.dev.invitationToken, password: PASSWORD, app: 'centre' }).expect(200);
      expect(accepted.body).toMatchObject({ status: 'OK', session: { tenant: { id, slug: body.slug }, membership: { roleKey: 'owner' } } });
      const owner = await t.login(body.ownerEmail);
      expect((await t.as(owner).get('/tenant').expect(200)).body).toMatchObject({ id, status: 'ONBOARDING' });
      expect((await t.as(owner).get('/subscription').expect(200)).body.subscription).toMatchObject({ status: 'TRIALING' });
      expect((await t.as(admin).post(`/platform/tenants/${id}/owner-invitation`).expect(409)).body.code).toBe('NO_PENDING_INVITATION');
      expect((await t.as(admin).get(`/platform/tenants/${id}`).expect(200)).body.owners[0]).toMatchObject({ status: 'ACTIVE', emailVerified: true });
    });

    it('refuses bad input without creating anything', async () => {
      const before = await t.sys.tenant.count();
      expect((await t.as(admin).post('/platform/tenants', newCentre({ slug: 'admin' })).expect(409)).body.code).toBe('SLUG_TAKEN');
      expect((await t.as(admin).post('/platform/tenants', newCentre({ slug: alpha.slug })).expect(409)).body.code).toBe('SLUG_TAKEN');
      expect((await t.as(admin).post('/platform/tenants', newCentre({ ownerEmail: admin.email })).expect(409)).body.code).toBe('EMAIL_IN_USE');
      expect((await t.as(admin).post('/platform/tenants', newCentre({ planKey: 'does-not-exist' })).expect(422)).body.code).toBe('PLAN_NOT_AVAILABLE');
      const alphaOwner = await t.sys.user.findUniqueOrThrow({ where: { id: alpha.owner.userId } });
      expect((await t.as(admin).post('/platform/tenants', newCentre({ ownerPhone: alphaOwner.phone })).expect(409)).body.code).toBe('PHONE_IN_USE');
      await t.as(admin).post('/platform/tenants', newCentre({ slug: 'Not A Slug!' })).expect(400);
      await t.as(admin).post('/platform/tenants', newCentre({ ownerEmail: 'not-an-email' })).expect(400);
      expect(await t.sys.tenant.count()).toBe(before);
    });

    it('can invite somebody who already owns another centre (no second account, no password asked)', async () => {
      const body = newCentre({ ownerEmail: beta.owner.email });
      const res = await t.as(admin).post('/platform/tenants', body).expect(201);
      expect(res.body.plan).toBeNull();
      expect(res.body.subscription).toBeNull();
      expect(await t.sys.user.count({ where: { email: beta.owner.email } })).toBe(1);
      const accepted = await t.http.post('/api/v1/auth/invitations/accept').send({ token: res.body.invitation.dev.invitationToken, app: 'centre' }).expect(200);
      expect(accepted.body.session.tenant.id).toBe(res.body.id);
      // The existing password still works; the person now chooses between two centres.
      const login = await t.http.post('/api/v1/auth/login').send({ email: beta.owner.email, password: PASSWORD, app: 'centre' }).expect(200);
      expect(login.body.status).toBe('SELECT_TENANT');
      expect(login.body.memberships.map((m: any) => m.tenantId).sort()).toEqual([beta.id, res.body.id].sort());
    });
  });

  // ------------------------------------------------------------------ approval
  describe('approval of new centres', () => {
    it('a centre that finished onboarding waits in PENDING_APPROVAL and becomes TRIAL when approved', async () => {
      const centre = await signedUpTenant(t, 'Needs Approval');
      await t.as(centre.owner).post('/onboarding/plan', { planKey: 'starter', billingCycle: 'MONTHLY' }).expect(201);
      (env() as any).TENANT_APPROVAL_REQUIRED = true;
      try {
        expect((await completeOnboarding(t, centre)).status).toBe('PENDING_APPROVAL');
      } finally {
        (env() as any).TENANT_APPROVAL_REQUIRED = false;
      }
      expect((await t.as(admin).get('/platform/tenants?status=PENDING_APPROVAL&pageSize=100').expect(200)).body.data.map((r: any) => r.id)).toContain(centre.id);
      // The billing job leaves a centre that is waiting for approval alone.
      await lifecycleOf(t).run();
      expect((await tenantRow(t, centre.id)).status).toBe('PENDING_APPROVAL');

      const approved = await t.as(admin).post(`/platform/tenants/${centre.id}/approve`, { note: 'Trade licence checked.' }).expect(200);
      expect(approved.body).toMatchObject({ status: 'TRIAL', suspensionReason: null });
      const row = await tenantRow(t, centre.id);
      expect(row).toMatchObject({ status: 'TRIAL', approvedById: admin.userId });
      expect(row.approvedAt).toBeTruthy();
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/approve`, {}).expect(409)).body.code).toBe('NOT_PENDING_APPROVAL');
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/reject`, { reason: 'Too late for that' }).expect(409)).body.code).toBe('NOT_PENDING_APPROVAL');
      const audit = await auditOf(t, 'tenant.approved', centre.id);
      expect(audit.platform).toHaveLength(1);
      expect(audit.centre).toHaveLength(1);
      expect(audit.centre[0].after).toMatchObject({ status: 'TRIAL', note: 'Trade licence checked.' });
      expect(await t.sys.securityEvent.count({ where: { tenantId: centre.id, type: 'TENANT_APPROVED' } })).toBe(1);
    });

    it('approval follows the subscription: a paid plan becomes ACTIVE', async () => {
      const centre = await t.createTenant({ plan: 'business', status: 'PENDING_APPROVAL' });
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/approve`, {}).expect(200)).body.status).toBe('ACTIVE');
      const overdue = await t.createTenant({ plan: 'starter', status: 'PENDING_APPROVAL' });
      await t.sys.subscription.update({ where: { tenantId: overdue.id }, data: { status: 'PAST_DUE' } });
      expect((await t.as(admin).post(`/platform/tenants/${overdue.id}/approve`, {}).expect(200)).body.status).toBe('PAST_DUE');
    });

    it('a rejected centre is closed with the reason shown to its owner, and can be approved later after all', async () => {
      const centre = await t.createTenant({ plan: 'starter', status: 'PENDING_APPROVAL' });
      await t.as(admin).post(`/platform/tenants/${centre.id}/reject`, { reason: 'no' }).expect(400);
      const rejected = await t.as(admin).post(`/platform/tenants/${centre.id}/reject`, { reason: 'The trade licence number could not be verified.' }).expect(200);
      expect(rejected.body).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'APPROVAL_REJECTED: The trade licence number could not be verified.' });
      // The owner is locked out of normal work but can still read why.
      expect((await t.as(centre.owner).get('/branches').expect(403)).body.code).toBe('TENANT_UNAVAILABLE');
      expect((await t.as(centre.owner).get('/tenant').expect(200)).body).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'APPROVAL_REJECTED: The trade licence number could not be verified.' });
      // Billing never lifts this suspension.
      await lifecycleOf(t).run();
      expect((await tenantRow(t, centre.id)).status).toBe('SUSPENDED');
      const reactivated = await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, { note: 'Licence received by email.' }).expect(200);
      expect(reactivated.body).toMatchObject({ status: 'ACTIVE', suspensionReason: null, suspendedAt: null });
      expect((await tenantRow(t, centre.id)).approvedById).toBe(admin.userId);
      await t.as(centre.owner).get('/branches').expect(200);
    });
  });

  // ------------------------------------------------------------------ suspend / reactivate
  describe('suspension', () => {
    it('suspends with a reason that billing respects, and reactivates to the subscription\'s state', async () => {
      const centre = await t.createTenant({ plan: 'starter', name: 'Suspend Me' });
      const customer = await t.addCustomer(centre);
      await t.as(admin).post(`/platform/tenants/${centre.id}/suspend`, { reason: 'x' }).expect(400);
      const res = await t.as(admin).post(`/platform/tenants/${centre.id}/suspend`, { reason: 'Reported for misuse of customer data; under review.' }).expect(200);
      expect(res.body).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'PLATFORM: Reported for misuse of customer data; under review.' });
      expect(res.body.suspendedAt).toBeTruthy();
      // Effective on the very next request, for staff and customers alike.
      expect((await t.as(centre.owner).get('/branches').expect(403)).body.code).toBe('TENANT_UNAVAILABLE');
      expect((await t.as(customer).get('/feature-flags')).status).toBe(200); // allowSuspended read-only route
      expect((await t.as(centre.owner).get('/subscription').expect(200)).body).toMatchObject({ tenantStatus: 'SUSPENDED', suspendedForNonPayment: false });
      // The subscription is still ACTIVE: the hourly billing job must NOT undo the suspension.
      expect((await subscriptionRow(t, centre.id))!.status).toBe('ACTIVE');
      await lifecycleOf(t).run();
      await lifecycleOf(t).run();
      expect(await tenantRow(t, centre.id)).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'PLATFORM: Reported for misuse of customer data; under review.' });
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/suspend`, { reason: 'Suspend it again please' }).expect(409)).body.code).toBe('ALREADY_SUSPENDED');

      const audit = await auditOf(t, 'tenant.suspended', centre.id);
      expect(audit.platform).toHaveLength(1);
      expect(audit.centre[0]).toMatchObject({ tenantId: centre.id, actorUserId: admin.userId });
      expect(audit.centre[0].before).toMatchObject({ status: 'ACTIVE' });
      expect(await t.sys.securityEvent.count({ where: { tenantId: centre.id, type: 'TENANT_SUSPENDED', severity: 'MEDIUM' } })).toBe(1);

      const back = await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, {}).expect(200);
      expect(back.body).toMatchObject({ status: 'ACTIVE', suspensionReason: null, suspendedAt: null });
      await t.as(centre.owner).get('/branches').expect(200);
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, {}).expect(409)).body.code).toBe('NOT_SUSPENDED');
    });

    it('a centre suspended for non-payment is reactivated through billing, not by flipping its status', async () => {
      const centre = await t.createTenant({ plan: 'starter' });
      await t.sys.subscription.update({ where: { tenantId: centre.id }, data: { status: 'EXPIRED' } });
      await lifecycleOf(t).run();
      expect(await tenantRow(t, centre.id)).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'SUBSCRIPTION_UNPAID' });
      const refused = await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, {}).expect(409);
      expect(refused.body.code).toBe('SUSPENDED_FOR_NON_PAYMENT');
      expect(refused.body.message).toMatch(/Billing/);
      // A platform suspension can be put on top: paying will then no longer bring the centre back.
      await t.as(admin).post(`/platform/tenants/${centre.id}/suspend`, { reason: 'Also under investigation.' }).expect(200);
      await t.sys.subscription.update({ where: { tenantId: centre.id }, data: { status: 'ACTIVE' } });
      await lifecycleOf(t).run();
      expect(await tenantRow(t, centre.id)).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'PLATFORM: Also under investigation.' });
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, {}).expect(200)).body.status).toBe('ACTIVE');
    });

    it('a centre that never finished onboarding returns to onboarding', async () => {
      const centre = await signedUpTenant(t, 'Half Way');
      await t.sys.tenant.update({ where: { id: centre.id }, data: { onboardingStep: 3 } });
      await t.as(admin).post(`/platform/tenants/${centre.id}/suspend`, { reason: 'Suspicious sign-up pattern.' }).expect(200);
      const back = await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, {}).expect(200);
      expect(back.body.status).toBe('ONBOARDING');
      expect((await tenantRow(t, centre.id)).approvedAt).toBeNull();
    });
  });

  // ------------------------------------------------------------------ archive
  describe('archive', () => {
    it('retires a centre: everybody is signed out, the subscription ends, nothing is deleted', async () => {
      const centre = await t.createTenant({ plan: 'starter', name: 'Archive Me' });
      const customer = await t.addCustomer(centre);
      const sub = (await subscriptionRow(t, centre.id))!;
      await t.sys.subscriptionInvoice.create({ data: { tenantId: centre.id, subscriptionId: sub.id, number: `TE-TEST-${uniq()}`, status: 'OPEN', periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400_000), subtotal: '149.00', total: '149.00', dueAt: new Date() } });
      const customersBefore = await t.sys.customer.count({ where: { tenantId: centre.id } });

      const res = await t.as(admin).post(`/platform/tenants/${centre.id}/archive`, { reason: 'Centre closed its business.' }).expect(200);
      expect(res.body).toMatchObject({ status: 'ARCHIVED', offboardingAt: null, subscription: { status: 'CANCELLED' } });
      expect(res.body.archivedAt).toBeTruthy();
      // Sessions are revoked and nobody can sign in again.
      await t.as(centre.owner).get('/tenant').expect(401);
      await t.as(customer).get('/feature-flags').expect(401);
      expect((await t.http.post('/api/v1/auth/login').send({ email: centre.owner.email, password: PASSWORD, app: 'centre' })).status).toBe(403);
      // Billing stops: the open invoice is void, and the job never touches an archived centre.
      expect((await t.sys.subscriptionInvoice.findMany({ where: { tenantId: centre.id } })).map((i) => i.status)).toEqual(['VOID']);
      await lifecycleOf(t).run();
      expect((await tenantRow(t, centre.id)).status).toBe('ARCHIVED');
      expect(await t.sys.subscriptionInvoice.count({ where: { tenantId: centre.id, status: 'OPEN' } })).toBe(0);
      // Nothing was deleted.
      expect(await t.sys.customer.count({ where: { tenantId: centre.id } })).toBe(customersBefore);
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/archive`, { reason: 'Archive it twice' }).expect(409)).body.code).toBe('ALREADY_ARCHIVED');
      expect((await t.as(admin).post(`/platform/tenants/${centre.id}/suspend`, { reason: 'Suspend an archive' }).expect(409)).body.code).toBe('TENANT_NOT_ACTIVE');
      expect((await auditOf(t, 'tenant.archived', centre.id)).centre[0].after).toMatchObject({ status: 'ARCHIVED', reason: 'Centre closed its business.' });

      // It can come back: the owner signs in again and has to restart the subscription.
      const back = await t.as(admin).post(`/platform/tenants/${centre.id}/reactivate`, { note: 'Reopened under new management.' }).expect(200);
      expect(back.body).toMatchObject({ status: 'CANCELLED', archivedAt: null });
      const owner = await t.login(centre.owner.email);
      expect((await t.as(owner).get('/subscription').expect(200)).body.subscription.status).toBe('CANCELLED');
      expect((await t.as(owner).get('/branches').expect(403)).body.code).toBe('TENANT_UNAVAILABLE');
    });
  });
});
