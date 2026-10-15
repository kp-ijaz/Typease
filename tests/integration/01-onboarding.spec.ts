import { Actor, anonymous, api, createService, expectRefused, mailTo, PASSWORD, samplePhone, signUpCentre, TestApp, uniq } from '../support';

/**
 * Scenarios 1-5: a centre comes into existence and its first colleague signs in.
 *
 * One story: a TypEase administrator creates the centre for a customer, the
 * owner accepts the invitation and completes onboarding, opens a second branch,
 * invites a receptionist for that branch, and the receptionist signs in.
 * Everything is driven through the public HTTP API. The only row written
 * directly is the first platform administrator (the API deliberately has no
 * endpoint that creates one; production uses the `platform-admin` CLI).
 */
describe('Onboarding (scenarios 1-5)', () => {
  let t: TestApp;
  let admin: Actor;

  // The story, carried from one scenario to the next.
  const id = uniq();
  const centre = { businessName: `Al Noor Typing ${id}`, slug: `alnoor-${id}`, ownerName: 'Noura Al Suwaidi', ownerEmail: `noura-${id}@example.test` };
  let tenantId: string;
  let invitationToken: string;
  let owner: Actor;
  let headOfficeId: string;
  let secondBranchId: string;
  const receptionistEmail = `reception-${id}@example.test`;
  let receptionistInvitation: string;
  let receptionistMembershipId: string;

  beforeAll(async () => {
    t = await TestApp.create();
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
  });
  afterAll(() => t.close());

  it('S01 platform admin creates a tenant', async () => {
    const created = await api(t, admin).post('/platform/tenants', { ...centre, ownerPhone: samplePhone(), emirate: 'Sharjah', planKey: 'professional', billingCycle: 'MONTHLY' }, 201);
    tenantId = created.id;
    invitationToken = created.invitation.dev.invitationToken;

    // The centre exists, is not operational yet, and its owner is invited - not created with a password.
    expect(created).toMatchObject({ slug: centre.slug, name: centre.businessName, status: 'ONBOARDING' });
    expect(created.plan.outcome).toBe('TRIAL_STARTED');
    expect(created.subscription).toMatchObject({ status: 'TRIALING', plan: { key: 'professional' } });
    expect(created.invitation).toMatchObject({ email: centre.ownerEmail, status: 'SENT' });
    expect(created.owners).toHaveLength(1);
    expect(created.owners[0]).toMatchObject({ email: centre.ownerEmail, status: 'INVITED' });

    // It is provisioned like a self-service sign-up: the admin sees a head office, and the list knows the centre.
    expect(created.counts.branches).toMatchObject({ total: 1, active: 1 });
    const list = await api(t, admin).get(`/platform/tenants?q=${centre.slug}`);
    expect(list.data.map((r: any) => r.id)).toEqual([tenantId]);

    // Nobody can sign in as the owner before the invitation is accepted (there is no password).
    const early = await anonymous(t).req('POST', '/auth/login', { email: centre.ownerEmail, password: PASSWORD, app: 'centre' });
    expectRefused(early, 401, 'INVALID_CREDENTIALS');

    // The slug is taken from now on, for self-service sign-ups too.
    const taken = await anonymous(t).get(`/public/slug-available?slug=${centre.slug}`);
    expect(taken.available).toBe(false);

    // Creating centres is for platform staff with the right permission only.
    const agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    expectRefused(await api(t, agent).req('POST', '/platform/tenants', { businessName: 'Nope', slug: `nope-${id}`, ownerName: 'No Body', ownerEmail: `nobody-${id}@example.test` }), 403);
    expectRefused(await anonymous(t).req('POST', '/platform/tenants', {}), 401);
  });

  it('S02 tenant owner completes onboarding', async () => {
    // The owner opens the invitation link, sees which centre invites them, and chooses a password.
    const preview = await anonymous(t).get(`/auth/invitations/preview?token=${invitationToken}`);
    expect(JSON.stringify(preview)).toContain(centre.businessName);
    const accepted = await anonymous(t).post('/auth/invitations/accept', { token: invitationToken, password: PASSWORD, app: 'centre' }, 200);
    expect(accepted.status).toBe('OK');
    owner = await t.login(centre.ownerEmail);
    expect(owner.roleKey).toBe('owner');
    const o = api(t, owner);

    // The centre is not operational before onboarding is complete, and the wizard says what is missing.
    const before = await o.get('/onboarding');
    expect(before).toMatchObject({ tenantStatus: 'ONBOARDING', completed: false, canComplete: false });
    const stepsBefore = Object.fromEntries(before.steps.map((s: any) => [s.key, s.done]));
    expect(stepsBefore).toMatchObject({ account: true, plan: true, business: false, services: false, branches: true });
    const tooEarly = await o.req('POST', '/onboarding/complete');
    expectRefused(tooEarly, 422, 'ONBOARDING_INCOMPLETE');

    // Business details, then a first service.
    await o.put('/onboarding/business', { legalName: `${centre.businessName} LLC`, tradeLicenceNo: `SAMPLE-TL-${id}`.toUpperCase(), emirate: 'Sharjah', contactEmail: centre.ownerEmail, contactPhone: samplePhone(), defaultLanguage: 'en' });
    await createService(t, owner, { name: 'Tenancy contract typing', price: { serviceFee: '120.00' } });
    const ready = await o.get('/onboarding');
    expect(ready.canComplete).toBe(true);

    const done = await o.post('/onboarding/complete');
    expect(done.status).toBe('TRIAL');

    // The owner now works in an operational centre with the provisioned roles and head office ...
    const tenant = await o.get('/tenant');
    expect(tenant).toMatchObject({ id: tenantId, slug: centre.slug, status: 'TRIAL', legalName: `${centre.businessName} LLC` });
    const roles: any[] = await o.get('/roles');
    expect(roles.map((r) => r.key)).toEqual(expect.arrayContaining(['owner', 'manager', 'receptionist', 'operator', 'reviewer', 'accountant', 'customer', 'corporate_admin', 'corporate_employee']));
    const branches: any[] = await o.get('/branches');
    expect(branches).toHaveLength(1);
    expect(branches[0].isHeadOffice).toBe(true);
    headOfficeId = branches[0].id;
    const after = await o.get('/onboarding');
    expect(after).toMatchObject({ completed: true, tenantStatus: 'TRIAL' });

    // ... the platform administrator sees the same state (metadata only) ...
    const seen = await api(t, admin).get(`/platform/tenants/${tenantId}`);
    expect(seen).toMatchObject({ status: 'TRIAL', onboarding: { completed: true } });
    expect(seen.owners[0]).toMatchObject({ email: centre.ownerEmail, status: 'ACTIVE' });

    // ... the centre's public configuration is served to its portal ...
    const config = await anonymous(t).get(`/public/tenant-config?slug=${centre.slug}`);
    expect(config.tenantId).toBe(tenantId);

    // ... and both steps are in the centre's own audit trail.
    const audit = await o.get('/audit-logs?pageSize=100');
    const actions = audit.data.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['tenant.created_by_platform', 'tenant.business_info_saved', 'tenant.onboarding_completed']));

    // The invitation link cannot be used a second time.
    expectRefused(await anonymous(t).req('POST', '/auth/invitations/accept', { token: invitationToken, password: PASSWORD, app: 'centre' }), 400, 'TOKEN_INVALID');
  });

  it('S02 a centre can also sign up by itself and complete onboarding (public flow)', async () => {
    const self = await signUpCentre(t, { plan: 'starter', name: `Self Service ${id}` });
    expect(self.status).toBe('TRIAL');
    const sub = await api(t, self.owner).get('/subscription');
    expect(sub).toMatchObject({ tenantStatus: 'TRIAL', plan: { key: 'starter' }, subscription: { status: 'TRIALING' } });
    // A second sign-up with the same web address or the same email is refused.
    const again = await anonymous(t).req('POST', '/public/signup', { businessName: 'Copycat', slug: self.slug, ownerName: 'Copy Cat', email: `copy-${id}@example.test`, phone: samplePhone(), password: PASSWORD, acceptTerms: true });
    expectRefused(again, 409, 'SLUG_TAKEN');
    const sameEmail = await anonymous(t).req('POST', '/public/signup', { businessName: 'Copycat', slug: `copy-${id}`, ownerName: 'Copy Cat', email: self.ownerEmail, phone: samplePhone(), password: PASSWORD, acceptTerms: true });
    expectRefused(sameEmail, 409, 'ACCOUNT_EXISTS');
  });

  it('S03 tenant owner creates a branch', async () => {
    const o = api(t, owner);
    const branch = await o.post('/branches', { code: 'SHJ2', name: 'Al Majaz Branch', emirate: 'Sharjah', address: 'Sample address (fictional)', phone: samplePhone() }, 201);
    secondBranchId = branch.id;
    expect(branch).toMatchObject({ code: 'SHJ2', name: 'Al Majaz Branch', isHeadOffice: false, tenantId });

    const branches: any[] = await o.get('/branches');
    expect(branches.map((b) => b.id).sort()).toEqual([headOfficeId, secondBranchId].sort());
    // The plan counts it (professional: two branches), so a third one is refused with a plan message, not created.
    const usage = await o.get('/tenant/usage');
    expect(usage.usage.find((u: any) => u.metric === 'branches')).toEqual({ metric: 'branches', used: 2, limit: 2 });
    expectRefused(await o.req('POST', '/branches', { code: 'SHJ3', name: 'One too many' }), 402, 'PLAN_LIMIT_REACHED');
    expect(await o.get('/branches')).toHaveLength(2);
    // The platform console counts the branch as well.
    const seen = await api(t, admin).get(`/platform/tenants/${tenantId}`);
    expect(seen.counts.branches).toMatchObject({ total: 2, active: 2 });
    const audit = await o.get('/audit-logs?pageSize=100');
    expect(audit.data.some((e: any) => e.resourceId === secondBranchId)).toBe(true);
  });

  it('S04 owner invites a staff member', async () => {
    const o = api(t, owner);
    // The role and the branch must exist in this centre.
    expectRefused(await o.req('POST', '/staff/invitations', { email: receptionistEmail, fullName: 'Mariam Hassan', roleKey: 'no_such_role', allBranches: true }), 404);

    const invite = await o.post('/staff/invitations', { email: receptionistEmail, fullName: 'Mariam Hassan', roleKey: 'receptionist', jobTitle: 'Front desk', allBranches: false, branchIds: [secondBranchId] }, 201);
    receptionistInvitation = invite.dev.invitationToken;

    const staff: any[] = await o.get('/staff');
    const row = staff.find((s) => s.email === receptionistEmail || s.user?.email === receptionistEmail);
    expect(row).toBeTruthy();
    expect(row.status).toBe('INVITED');
    receptionistMembershipId = row.id;

    // The invitation went out by email, to the invited address, and the link in it is the one that works.
    await t.settle();
    const mails = mailTo(receptionistEmail);
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails.at(-1)!.text).toContain(receptionistInvitation);
    // ... while the stored notification never contains the secret link.
    const log = await o.get(`/notifications?q=${encodeURIComponent(receptionistEmail)}`);
    expect(log.data.length).toBeGreaterThanOrEqual(1);
    for (const n of log.data) {
      const detail = await o.get(`/notifications/${n.id}`);
      expect(JSON.stringify(detail)).not.toContain(receptionistInvitation);
    }

    // An invited member cannot sign in yet.
    expectRefused(await anonymous(t).req('POST', '/auth/login', { email: receptionistEmail, password: PASSWORD, app: 'centre' }), 401, 'INVALID_CREDENTIALS');
    // The same person cannot be invited twice.
    expectRefused(await o.req('POST', '/staff/invitations', { email: receptionistEmail, fullName: 'Mariam Hassan', roleKey: 'operator', allBranches: true }), 409, 'ALREADY_MEMBER');
  });

  it('S05 staff member logs in', async () => {
    // The invitation shows who invites and for which role; a weak password is refused and uses nothing up.
    const preview = await anonymous(t).get(`/auth/invitations/preview?token=${receptionistInvitation}`);
    expect(JSON.stringify(preview)).toContain(centre.businessName);
    expectRefused(await anonymous(t).req('POST', '/auth/invitations/accept', { token: receptionistInvitation, password: 'short', app: 'centre' }), 400);
    // The form knows the policy before the user types (the invitation and the centre's public configuration publish
    // it), and the API enforces exactly that: one character short of the minimum is refused, naming the field.
    expect(preview.passwordPolicy).toMatchObject({ requires: ['lowercase', 'uppercase', 'digit'] });
    expect(preview.passwordPolicy.minLength).toBeGreaterThanOrEqual(10);
    expect((await anonymous(t).get(`/public/tenant-config?slug=${centre.slug}`)).passwordPolicy).toEqual(preview.passwordPolicy);
    const oneShort = `Aa1${'x'.repeat(preview.passwordPolicy.minLength - 4)}`;
    const refused = await anonymous(t).req('POST', '/auth/invitations/accept', { token: receptionistInvitation, password: oneShort, app: 'centre' });
    expectRefused(refused, 400, 'VALIDATION_FAILED');
    expect(refused.body.details.map((d: any) => d.path)).toEqual(['password']);
    for (const weak of [`${'a'.repeat(preview.passwordPolicy.minLength)}1`, `${'A'.repeat(preview.passwordPolicy.minLength)}1`, `Aa${'x'.repeat(preview.passwordPolicy.minLength)}`]) {
      expectRefused(await anonymous(t).req('POST', '/auth/invitations/accept', { token: receptionistInvitation, password: weak, app: 'centre' }), 400, 'VALIDATION_FAILED');
    }
    const accepted = await anonymous(t).post('/auth/invitations/accept', { token: receptionistInvitation, password: PASSWORD, app: 'centre' }, 200);
    expect(accepted.status).toBe('OK');

    // Wrong password: refused without saying whether the account exists.
    const wrong = await anonymous(t).req('POST', '/auth/login', { email: receptionistEmail, password: 'Wrong-Password-99', app: 'centre' });
    expectRefused(wrong, 401, 'INVALID_CREDENTIALS');

    // Signing in gives a session bound to this centre, this role and this branch.
    const login = await anonymous(t).req('POST', '/auth/login', { email: receptionistEmail, password: PASSWORD, app: 'centre' });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('OK');
    expect(login.body.accessToken).toBeTruthy();
    const receptionist: Actor = { token: login.body.accessToken, userId: login.body.session.user.id, email: receptionistEmail, membershipId: login.body.session.membership.id, customerId: null, roleKey: login.body.session.membership.roleKey };
    expect(receptionist.membershipId).toBe(receptionistMembershipId);

    const me = await api(t, receptionist).get('/auth/me');
    expect(me.tenant.id).toBe(tenantId);
    expect(me.membership.roleKey).toBe('receptionist');
    expect(me.user.email).toBe(receptionistEmail);

    // The session carries the receptionist's permissions - no more.
    const r = api(t, receptionist);
    await r.get('/customers');
    await r.get('/branches');
    expectRefused(await r.req('POST', '/staff/invitations', { email: `x-${id}@example.test`, fullName: 'Not Allowed', roleKey: 'owner', allBranches: true }), 403);
    expectRefused(await r.req('GET', '/subscription'), 403);
    expectRefused(await r.req('POST', '/branches', { code: 'R1', name: 'Not allowed' }), 403);

    // The staff account is not a customer account and not a platform account.
    expectRefused(await anonymous(t).req('POST', '/auth/login', { email: receptionistEmail, password: PASSWORD, app: 'customer', tenantSlug: centre.slug }), 403);
    expectRefused(await anonymous(t).req('POST', '/auth/login', { email: receptionistEmail, password: PASSWORD, app: 'platform' }), 403);

    // The owner sees the colleague as active, limited to the second branch, and the sign-in is recorded.
    const staff: any[] = await api(t, owner).get('/staff');
    const row = staff.find((s) => s.id === receptionistMembershipId);
    expect(row.status).toBe('ACTIVE');
    const activity: any[] = await r.get('/auth/login-activity');
    expect(activity.some((a) => a.success === true)).toBe(true);
    expect(activity.some((a) => a.success === false)).toBe(true); // the wrong password above

    // Signing out ends the session: the same token is refused afterwards.
    await r.post('/auth/logout', {}, [200, 201]);
    expectRefused(await r.req('GET', '/auth/me'), 401);
  });
});
