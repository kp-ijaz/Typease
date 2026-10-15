import { authenticator } from 'otplib';
import { TestApp, TenantFixture, Actor, PASSWORD, uniq } from './helpers';

describe('Foundation: authentication, roles and tenant isolation', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
  });
  afterAll(() => t.close());

  it('provisions a new centre with roles, head office and default categories', async () => {
    const roles = await t.as(alpha.owner).get('/roles').expect(200);
    expect(roles.body.map((r: any) => r.key)).toEqual(expect.arrayContaining(['owner', 'manager', 'receptionist', 'operator', 'reviewer', 'accountant', 'customer']));
    const branches = await t.as(alpha.owner).get('/branches').expect(200);
    expect(branches.body).toHaveLength(1);
    expect(branches.body[0].isHeadOffice).toBe(true);
    const me = await t.as(alpha.owner).get('/auth/me').expect(200);
    expect(me.body.tenant.id).toBe(alpha.id);
    expect(me.body.membership.roleKey).toBe('owner');
  });

  it('rejects unauthenticated and malformed tokens', async () => {
    await t.as(null).get('/branches').expect(401);
    await t.http.get('/api/v1/branches').set('Authorization', 'Bearer not-a-token').expect(401);
  });

  it('never lets tenant A read or change tenant B data', async () => {
    const betaBranch = (await t.as(beta.owner).post('/branches', { code: 'B2', name: 'Beta Second' }).expect(201)).body;
    // Listing shows only own rows.
    const list = await t.as(alpha.owner).get('/branches?includeInactive=true').expect(200);
    expect(list.body.every((b: any) => b.tenantId === alpha.id)).toBe(true);
    // Direct access by id is indistinguishable from "does not exist".
    await t.as(alpha.owner).patch(`/branches/${betaBranch.id}`, { name: 'Hijacked' }).expect(404);
    const still = await t.sys.branch.findUniqueOrThrow({ where: { id: betaBranch.id } });
    expect(still.name).toBe('Beta Second');
  });

  it('row-level security blocks cross-tenant access even for unfiltered queries', async () => {
    const rows = await t.inTenant(alpha.id, () => t.db.tx((tx) => tx.branch.findMany()));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === alpha.id)).toBe(true);
    await expect(
      t.inTenant(alpha.id, () => t.db.tx((tx) => tx.branch.create({ data: { tenantId: beta.id, code: 'X', name: 'Injected' } }))),
    ).rejects.toThrow();
    // A cross-tenant foreign key is rejected by the database guard.
    await expect(
      t.inTenant(alpha.id, () =>
        t.db.tx((tx) => tx.staffSchedule.create({ data: { tenantId: alpha.id, membershipId: alpha.owner.membershipId!, branchId: beta.headOfficeId, weekday: 1, startTime: '09:00', endTime: '17:00' } })),
      ),
    ).rejects.toThrow(/cross-tenant|violates|security/i);
  });

  it('the tenant-scoped connection cannot read credentials or sessions', async () => {
    await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.$queryRaw`SELECT "passwordHash" FROM users LIMIT 1`))).rejects.toThrow(/permission denied/i);
    await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.$queryRaw`SELECT count(*) FROM sessions`))).rejects.toThrow(/permission denied/i);
    const users = await t.inTenant(alpha.id, () => t.db.tx((tx) => tx.user.findMany()));
    expect(users.length).toBeGreaterThan(0);
    for (const u of users as any[]) expect(u.passwordHash).toBeUndefined();
  });

  describe('staff roles', () => {
    let receptionist: Actor;
    let manager: Actor;
    beforeAll(async () => {
      receptionist = await t.addStaff(alpha, 'receptionist');
      manager = await t.addStaff(alpha, 'manager');
    });

    it('enforces permissions per role', async () => {
      await t.as(receptionist).get('/branches').expect(200);
      await t.as(receptionist).post('/branches', { code: 'R1', name: 'Nope' }).expect(403);
      await t.as(receptionist).get('/roles').expect(403);
      await t.as(receptionist).post('/staff/invitations', { email: 'x@example.test', fullName: 'X Y', roleKey: 'owner', allBranches: true }).expect(403);
    });

    it('blocks privilege escalation through role management', async () => {
      // A manager has no role.manage permission at all.
      await t.as(manager).post('/roles', { key: 'super_role', name: 'Super', permissions: ['refund.approve'] }).expect(403);
      // An owner can create a custom role, but only with staff permissions.
      await t.as(alpha.owner).post('/roles', { key: 'front_desk_plus', name: 'Front desk +', permissions: ['customer.read', 'self.requests'] }).expect(400);
      const role = await t.as(alpha.owner).post('/roles', { key: 'front_desk_plus', name: 'Front desk +', permissions: ['customer.read', 'payment.record'] }).expect(201);
      expect(role.body.permissions).toEqual(['customer.read', 'payment.record']);
      // Built-in owner role is locked.
      const roles = (await t.as(alpha.owner).get('/roles')).body;
      const owner = roles.find((r: any) => r.key === 'owner');
      await t.as(alpha.owner).patch(`/roles/${owner.id}`, { permissions: [] }).expect(409);
    });

    it('keeps at least one owner and ends sessions when a member is suspended', async () => {
      const staff = (await t.as(alpha.owner).get('/staff')).body;
      const me = staff.find((s: any) => s.userId === alpha.owner.userId);
      await t.as(alpha.owner).patch(`/staff/${me.id}`, { status: 'SUSPENDED' }).expect(403);
      const victim = staff.find((s: any) => s.userId === receptionist.userId);
      await t.as(alpha.owner).patch(`/staff/${victim.id}`, { status: 'SUSPENDED' }).expect(200);
      await t.as(receptionist).get('/branches').expect(401);
    });
  });

  describe('sessions', () => {
    it('rotates refresh tokens and revokes the family on reuse', async () => {
      const email = `rot-${uniq()}@example.test`;
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
      await t.sys.user.create({ data: { email, fullName: 'Rot Ate', emailVerifiedAt: new Date(), passwordHash: await require('../src/modules/auth/auth.service').hashPassword(PASSWORD), platformRole: 'SUPER_ADMIN' } });
      const login = await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD, app: 'mobile' });
      expect(login.status).toBe(403); // platform users cannot use tenant apps
      const ok = await t.http.post('/api/v1/auth/login').set('x-client-app', 'mobile').send({ email, password: PASSWORD, app: 'platform' });
      expect(ok.body.status).toBe('OK');
      const cookie = ok.headers['set-cookie'][0].split(';')[0];
      const first = await t.http.post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-requested-with', 'typease').set('x-client-app', 'platform').send({});
      expect(first.status).toBe(200);
      // Cookie refresh without the anti-CSRF header is refused.
      await t.http.post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-client-app', 'platform').send({}).expect(403);
      // Replaying the old (rotated) token kills the whole family, including the new token.
      await t.http.post('/api/v1/auth/refresh').set('Cookie', cookie).set('x-requested-with', 'typease').set('x-client-app', 'platform').send({}).expect(401);
      const newCookie = first.headers['set-cookie'][0].split(';')[0];
      await t.http.post('/api/v1/auth/refresh').set('Cookie', newCookie).set('x-requested-with', 'typease').set('x-client-app', 'platform').send({}).expect(401);
      await t.http.get('/api/v1/auth/me').set('Authorization', `Bearer ${first.body.accessToken}`).expect(401);
    });

    it('locks the account after repeated failures and never reveals whether an email exists', async () => {
      const unknown = await t.http.post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: 'whatever-1A', app: 'centre' });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      const victim = await t.addStaff(alpha, 'operator');
      for (let i = 0; i < 5; i++) {
        const r = await t.http.post('/api/v1/auth/login').send({ email: victim.email, password: 'Wrong-Password-1', app: 'centre' });
        expect(r.body.code).toBe('INVALID_CREDENTIALS');
      }
      const locked = await t.http.post('/api/v1/auth/login').send({ email: victim.email, password: PASSWORD, app: 'centre' });
      expect(locked.status).toBe(429);
    });

    it('supports TOTP MFA with recovery codes', async () => {
      const admin = await t.addStaff(alpha, 'accountant');
      const setup = await t.as(admin).post('/auth/mfa/setup').expect(200);
      await t.as(admin).post('/auth/mfa/enable', { code: '000000' }).expect(400);
      const enabled = await t.as(admin).post('/auth/mfa/enable', { code: authenticator.generate(setup.body.secret) }).expect(200);
      expect(enabled.body.recoveryCodes).toHaveLength(10);
      const login = await t.http.post('/api/v1/auth/login').send({ email: admin.email, password: PASSWORD, app: 'centre' });
      expect(login.body.status).toBe('MFA_REQUIRED');
      await t.http.post('/api/v1/auth/mfa/verify').send({ challengeToken: login.body.challengeToken, code: '123456' }).expect(401);
      const done = await t.http.post('/api/v1/auth/mfa/verify').send({ challengeToken: login.body.challengeToken, code: authenticator.generate(setup.body.secret) });
      expect(done.body.status).toBe('OK');
      // A recovery code works once.
      const again = await t.http.post('/api/v1/auth/login').send({ email: admin.email, password: PASSWORD, app: 'centre' });
      const rc = await t.http.post('/api/v1/auth/mfa/verify').send({ challengeToken: again.body.challengeToken, code: enabled.body.recoveryCodes[0] });
      expect(rc.body.status).toBe('OK');
      const third = await t.http.post('/api/v1/auth/login').send({ email: admin.email, password: PASSWORD, app: 'centre' });
      await t.http.post('/api/v1/auth/mfa/verify').send({ challengeToken: third.body.challengeToken, code: enabled.body.recoveryCodes[0] }).expect(401);
    });
  });

  describe('customers and centres are separate login spaces', () => {
    it('a customer of Alpha cannot sign in to Beta or to the staff app', async () => {
      const customer = await t.addCustomer(alpha);
      expect(customer.customerId).toBeTruthy();
      const beta_ = await t.http.post('/api/v1/auth/login').send({ email: customer.email, password: PASSWORD, app: 'customer', tenantSlug: beta.slug });
      expect(beta_.status).toBe(403);
      const staffApp = await t.http.post('/api/v1/auth/login').send({ email: customer.email, password: PASSWORD, app: 'centre' });
      expect(staffApp.status).toBe(403);
      await t.as(customer).get('/branches').expect(403);
      await t.as(customer).get('/staff').expect(403);
    });
  });

  describe('white label and custom domains', () => {
    it('serves TypEase branding by default and tenant branding once white label is on', async () => {
      const before = await t.http.get(`/api/v1/public/tenant-config?slug=${alpha.slug}`).expect(200);
      expect(before.body.mode).toBe('TYPEASE');
      expect(before.body.colors.primary).toBe('#0B2240');
      await t.as(alpha.owner).put('/branding', { mode: 'WHITE_LABEL', businessName: 'Al Noor Typing', primaryColor: '#7A1F5C', accentColor: '#F59E0B', websiteTitle: 'Al Noor' }).expect(200);
      const after = await t.http.get(`/api/v1/public/tenant-config?slug=${alpha.slug}`).expect(200);
      expect(after.body).toMatchObject({ mode: 'WHITE_LABEL', name: 'Al Noor Typing', websiteTitle: 'Al Noor', colors: { primary: '#7A1F5C', secondary: '#0B7AD1', accent: '#F59E0B' } });
      await t.as(alpha.owner).put('/branding', { primaryColor: 'red' }).expect(400);
      // Beta is unaffected.
      const other = await t.http.get(`/api/v1/public/tenant-config?slug=${beta.slug}`).expect(200);
      expect(other.body.mode).toBe('TYPEASE');
    });

    it('white label is a plan feature', async () => {
      const starter = await t.createTenant({ plan: 'starter' });
      const res = await t.as(starter.owner).put('/branding', { mode: 'WHITE_LABEL', primaryColor: '#112233' });
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
      await t.as(starter.owner).post('/branches', { code: 'B2', name: 'Second' }).expect(402);
    });

    it('verifies custom domains by DNS TXT and never lets two tenants claim one domain', async () => {
      const domain = `portal-${uniq()}.example.ae`;
      const added = await t.as(alpha.owner).post('/domains', { domain }).expect(201);
      expect(added.body.status).toBe('PENDING');
      expect(added.body.dns.txt.name).toBe(`_typease-verify.${domain}`);
      // Another tenant cannot claim the same domain.
      const dup = await t.as(beta.owner).post('/domains', { domain });
      expect(dup.status).toBe(409);
      // Not routed and no certificate before verification.
      await t.http.get(`/api/v1/internal/tls/ask?domain=${domain}`).expect(404);
      await t.http.get(`/api/v1/public/tenant-config?host=${domain}`).expect(404);
      const fail = await t.as(alpha.owner).post(`/domains/${added.body.id}/verify`).expect(200);
      expect(fail.body.verified).toBe(false);
      // Wrong value does not verify.
      t.dns.records.set(`_typease-verify.${domain}`, ['typease-verify=someone-elses-token']);
      expect((await t.as(alpha.owner).post(`/domains/${added.body.id}/verify`)).body.verified).toBe(false);
      t.dns.records.set(`_typease-verify.${domain}`, [added.body.dns.txt.value]);
      const ok = await t.as(alpha.owner).post(`/domains/${added.body.id}/verify`).expect(200);
      expect(ok.body).toMatchObject({ verified: true, status: 'VERIFIED', isPrimary: true });
      await t.http.get(`/api/v1/internal/tls/ask?domain=${domain}`).expect(200);
      const cfg = await t.http.get(`/api/v1/public/tenant-config?host=${domain}`).expect(200);
      expect(cfg.body.tenantId).toBe(alpha.id);
      // Platform subdomain also resolves; unknown hosts do not.
      await t.http.get(`/api/v1/internal/tls/ask?domain=${alpha.slug}.typease.test`).expect(200);
      await t.http.get('/api/v1/internal/tls/ask?domain=evil.example.com').expect(404);
      // Beta cannot verify or delete Alpha's domain.
      await t.as(beta.owner).post(`/domains/${added.body.id}/verify`).expect(404);
      await t.as(beta.owner).delete(`/domains/${added.body.id}`).expect(404);
    });
  });
});
