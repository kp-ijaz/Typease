import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { BillingCore } from '../subscriptions/billing.core';
import { FeatureFlags } from './feature-flags.service';
import { supportSession } from './fixtures';

describe('Platform: feature flags, settings, staff, audit and security', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let agent: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
  });
  afterAll(async () => {
    await t.sys.platformSetting.deleteMany({ where: { key: { in: ['subscriptions.policy', 'integrations.approvedProviders', 'supportAccess.policy', 'offboarding.policy'] } } });
    await t.close();
  });

  // ------------------------------------------------------------------ feature flags
  describe('feature flags', () => {
    const key = `new_editor_${uniq()}`;
    const other = `beta_only.${uniq()}`;
    const flags = () => t.get(FeatureFlags);
    const enabledFor = (tenant: TenantFixture, k: string) => t.inTenant(tenant.id, () => flags().isEnabled(k));
    const mine = async (actor: Actor) => (await t.as(actor).get('/feature-flags').expect(200)).body as Record<string, boolean>;

    it('is managed by Super Admins only', async () => {
      for (const actor of [agent, alpha.owner]) {
        await t.as(actor).get('/platform/feature-flags').expect(403);
        await t.as(actor).put(`/platform/feature-flags/${key}`, { enabled: true }).expect(403);
        await t.as(actor).delete(`/platform/feature-flags/${key}`).expect(403);
        await t.as(actor).put(`/platform/tenants/${alpha.id}/feature-flags/${key}`, { enabled: true }).expect(403);
        await t.as(actor).get(`/platform/tenants/${alpha.id}/feature-flags`).expect(403);
      }
      await t.as(admin).put('/platform/feature-flags/Not%20A%20Key', { enabled: true }).expect(400);
      await t.as(admin).put(`/platform/feature-flags/${key}`, { enabled: 'yes' }).expect(400);
    });

    it('an unknown flag is off; the global default applies to every centre', async () => {
      expect(await enabledFor(alpha, key)).toBe(false);
      expect(await mine(alpha.owner)).not.toHaveProperty(key);
      const created = await t.as(admin).put(`/platform/feature-flags/${key}`, { enabled: true, payload: { description: 'New quotation editor', maxLines: 50 } }).expect(200);
      expect(created.body).toMatchObject({ key, enabled: true, hasGlobalDefault: true, payload: { maxLines: 50 }, overrides: { total: 0 } });
      expect(await enabledFor(alpha, key)).toBe(true);
      expect(await enabledFor(beta, key)).toBe(true);
      expect((await mine(alpha.owner))[key]).toBe(true);
      expect(await t.inTenant(alpha.id, () => flags().payload(key))).toEqual({ description: 'New quotation editor', maxLines: 50 });
      // Customers of the centre get the same answer (it drives what their portal shows).
      const customer = await t.addCustomer(beta);
      expect((await mine(customer))[key]).toBe(true);
      // Outside a tenant context only the global default exists.
      expect(await flags().isEnabled(key)).toBe(true);
      expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'platform.feature_flag_created', resourceId: key, actorUserId: admin.userId } })).toBe(1);
    });

    it('a centre override wins over the global default, in both directions', async () => {
      const off = await t.as(admin).put(`/platform/tenants/${alpha.id}/feature-flags/${key}`, { enabled: false }).expect(200);
      expect(off.body).toMatchObject({ key, enabled: false, source: 'TENANT', globalDefault: true });
      expect(await enabledFor(alpha, key)).toBe(false);
      expect(await enabledFor(beta, key)).toBe(true);
      expect((await mine(alpha.owner))[key]).toBe(false);
      // An override carries its own payload (empty here); it does not inherit the default's.
      expect(await t.inTenant(alpha.id, () => flags().payload(key))).toEqual({});

      // Default off, switched on for one centre only.
      await t.as(admin).put(`/platform/feature-flags/${other}`, { enabled: false }).expect(200);
      await t.as(admin).put(`/platform/tenants/${beta.id}/feature-flags/${other}`, { enabled: true, payload: { cohort: 'pilot' } }).expect(200);
      expect(await enabledFor(beta, other)).toBe(true);
      expect(await enabledFor(alpha, other)).toBe(false);
      // An override may exist without any global default.
      const solo = `solo_${uniq()}`;
      await t.as(admin).put(`/platform/tenants/${beta.id}/feature-flags/${solo}`, { enabled: true }).expect(200);
      expect(await enabledFor(beta, solo)).toBe(true);
      expect(await enabledFor(alpha, solo)).toBe(false);
      expect(await flags().isEnabled(solo)).toBe(false);

      const list = await t.as(admin).get('/platform/feature-flags').expect(200);
      expect(list.body.find((f: any) => f.key === key)).toMatchObject({ enabled: true, overrides: { total: 1, enabled: 0, disabled: 1 } });
      expect(list.body.find((f: any) => f.key === other)).toMatchObject({ enabled: false, overrides: { total: 1, enabled: 1, disabled: 0 } });
      expect(list.body.find((f: any) => f.key === solo)).toMatchObject({ enabled: false, hasGlobalDefault: false, overrides: { total: 1 } });
      const overrides = await t.as(admin).get(`/platform/feature-flags/${key}/overrides`).expect(200);
      expect(overrides.body).toEqual([expect.objectContaining({ centre: expect.objectContaining({ id: alpha.id, slug: alpha.slug }), enabled: false })]);
      const forBeta = await t.as(admin).get(`/platform/tenants/${beta.id}/feature-flags`).expect(200);
      expect(forBeta.body.find((f: any) => f.key === key)).toMatchObject({ enabled: true, source: 'GLOBAL' });
      expect(forBeta.body.find((f: any) => f.key === other)).toMatchObject({ enabled: true, source: 'TENANT', globalDefault: false, payload: { cohort: 'pilot' } });
      // The centre sees the change on its own audit trail.
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'platform.feature_override_set', resourceId: key } })).toBe(1);

      const cleared = await t.as(admin).delete(`/platform/tenants/${alpha.id}/feature-flags/${key}`).expect(200);
      expect(cleared.body).toMatchObject({ key, enabled: true, source: 'GLOBAL' });
      expect(await enabledFor(alpha, key)).toBe(true);
      await t.as(admin).delete(`/platform/tenants/${alpha.id}/feature-flags/${key}`).expect(404);
      await t.as(admin).put('/platform/tenants/6f1c3c9e-2a54-4d0b-9d3e-8b1c5a7f0e11/feature-flags/x_flag', { enabled: true }).expect(404);
    });

    it('a centre can read its own flags and the defaults, never another centre\'s, and cannot write any', async () => {
      const visible = await t.inTenant(alpha.id, () => t.db.tx((tx) => tx.featureFlag.findMany()));
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((f) => f.tenantId === null || f.tenantId === alpha.id)).toBe(true);
      expect(visible.some((f) => f.key === other && f.tenantId === beta.id)).toBe(false);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.featureFlag.create({ data: { key: 'self_service', tenantId: alpha.id, enabled: true } })))).rejects.toThrow(/permission denied/i);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.featureFlag.updateMany({ where: { key }, data: { enabled: false } })))).rejects.toThrow(/permission denied/i);
      await t.as(alpha.owner).put(`/feature-flags/${key}`, { enabled: true }).expect(404);
    });

    it('removing a flag removes the default and every override', async () => {
      expect((await t.as(admin).delete(`/platform/feature-flags/${other}`).expect(200)).body).toEqual({ status: 'DELETED' });
      expect(await t.sys.featureFlag.count({ where: { key: other } })).toBe(0);
      expect(await enabledFor(beta, other)).toBe(false);
      await t.as(admin).delete(`/platform/feature-flags/${other}`).expect(404);
    });
  });

  // ------------------------------------------------------------------ settings
  describe('platform settings', () => {
    it('only the documented keys exist as far as the API is concerned', async () => {
      await t.sys.platformSetting.upsert({ where: { key: 'internal.secret_thing' }, create: { key: 'internal.secret_thing', value: { apiKey: 'do-not-show' } }, update: {} });
      const list = await t.as(admin).get('/platform/settings').expect(200);
      expect(list.body.map((s: any) => s.key)).toEqual(['subscriptions.policy', 'integrations.approvedProviders', 'supportAccess.policy', 'offboarding.policy']);
      expect(JSON.stringify(list.body)).not.toContain('do-not-show');
      expect(list.body.find((s: any) => s.key === 'offboarding.policy')).toMatchObject({ value: { minPurgeDelayDays: 30 }, isDefault: true, updatedAt: null });
      for (const hidden of ['internal.secret_thing', 'subscriptions.invoice_sequence', 'nope']) {
        await t.as(admin).get(`/platform/settings/${hidden}`).expect(404);
        await t.as(admin).put(`/platform/settings/${hidden}`, { value: { next: 1 } }).expect(404);
        await t.as(admin).delete(`/platform/settings/${hidden}`).expect(404);
      }
      expect((await t.sys.platformSetting.findUniqueOrThrow({ where: { key: 'internal.secret_thing' } })).value).toEqual({ apiKey: 'do-not-show' });
      await t.sys.platformSetting.delete({ where: { key: 'internal.secret_thing' } });
      for (const actor of [agent, alpha.owner]) {
        await t.as(actor).get('/platform/settings').expect(403);
        await t.as(actor).put('/platform/settings/offboarding.policy', { value: { minPurgeDelayDays: 60 } }).expect(403);
      }
    });

    it('validates each value and the consuming module really reads it', async () => {
      const bad = await t.as(admin).put('/platform/settings/subscriptions.policy', { value: { graceDays: 500 } }).expect(422);
      expect(bad.body).toMatchObject({ code: 'INVALID_SETTING', details: [{ path: 'graceDays' }] });
      await t.as(admin).put('/platform/settings/subscriptions.policy', { value: { graceDays: 10, madeUp: true } }).expect(422);
      await t.as(admin).put('/platform/settings/offboarding.policy', { value: { minPurgeDelayDays: 29 } }).expect(422);
      await t.as(admin).put('/platform/settings/supportAccess.policy', { value: 'soon' }).expect(422);

      const set = await t.as(admin).put('/platform/settings/subscriptions.policy', { value: { graceDays: 10, taxRatePercent: 5 } }).expect(200);
      expect(set.body).toMatchObject({ key: 'subscriptions.policy', value: { graceDays: 10, taxRatePercent: 5 }, isDefault: false });
      const policy = await t.get(BillingCore).policy(t.sys as any);
      expect(policy).toMatchObject({ graceDays: 10, taxRatePercent: 5, renewalLeadDays: 7 });
      const entry = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: null, action: 'platform.setting_changed', resourceId: 'subscriptions.policy' }, orderBy: { createdAt: 'desc' } });
      expect(entry).toMatchObject({ actorUserId: admin.userId, after: { value: { graceDays: 10, taxRatePercent: 5 } } });

      const reset = await t.as(admin).delete('/platform/settings/subscriptions.policy').expect(200);
      expect(reset.body).toMatchObject({ isDefault: true, value: { graceDays: 7 } });
      expect((await t.get(BillingCore).policy(t.sys as any)).graceDays).toBe(7);
    });

    it('the approved-provider list is the same setting the integrations module enforces', async () => {
      expect((await t.as(admin).put('/platform/settings/integrations.approvedProviders', { value: ['EMAIL/smtp', 'SMS/carrier-pigeon'] }).expect(422)).body.code).toBe('INVALID_SETTING');
      const set = await t.as(admin).put('/platform/settings/integrations.approvedProviders', { value: ['EMAIL/smtp', 'PAYMENT/stripe'] }).expect(200);
      expect(set.body).toMatchObject({ value: ['EMAIL/smtp', 'PAYMENT/stripe'], isDefault: false });
      const view = await t.as(admin).get('/platform/integrations/approved-providers').expect(200);
      expect(view.body.restricted).toBe(true);
      expect(view.body.providers.filter((p: any) => p.approved).map((p: any) => p.code).sort()).toEqual(['EMAIL/smtp', 'PAYMENT/stripe']);
      expect((await t.as(alpha.owner).post('/integrations', { category: 'SMS', provider: 'twilio', config: { accountSid: 'ACx', from: 'Alpha' } }).expect(422)).body.code).toBe('PROVIDER_NOT_APPROVED');
      const reset = await t.as(admin).delete('/platform/settings/integrations.approvedProviders').expect(200);
      expect(reset.body).toMatchObject({ value: null, isDefault: true });
      expect((await t.as(admin).get('/platform/integrations/approved-providers').expect(200)).body.restricted).toBe(false);
    });
  });

  // ------------------------------------------------------------------ staff
  describe('platform staff', () => {
    let newcomer: { id: string; email: string; token: string };

    it('lists staff; only Super Admins manage them', async () => {
      const list = await t.as(admin).get('/platform/staff').expect(200);
      const me = list.body.find((s: any) => s.id === admin.userId);
      expect(me).toMatchObject({ email: admin.email, role: 'SUPER_ADMIN', roleName: 'Platform Super Admin', status: 'ACTIVE', invitationPending: false, isYou: true });
      expect(list.body.find((s: any) => s.id === agent.userId)).toMatchObject({ role: 'SUPPORT_AGENT', isYou: false });
      expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|mfaSecret/);
      // Tenant users never show up here.
      expect(list.body.some((s: any) => s.email === alpha.owner.email)).toBe(false);
      expect((await t.as(admin).get('/platform/staff?role=SUPPORT_AGENT').expect(200)).body.every((s: any) => s.role === 'SUPPORT_AGENT')).toBe(true);
      for (const actor of [agent, alpha.owner]) {
        await t.as(actor).get('/platform/staff').expect(403);
        await t.as(actor).post('/platform/staff', { email: `x-${uniq()}@typease.test`, fullName: 'Nope Nope', role: 'SUPER_ADMIN' }).expect(403);
        await t.as(actor).patch(`/platform/staff/${agent.userId}`, { role: 'SUPER_ADMIN' }).expect(403);
        await t.as(actor).post(`/platform/staff/${admin.userId}/disable`).expect(403);
      }
    });

    it('invites a new member by email; they choose their own password through the reset link', async () => {
      const email = `new-agent-${uniq()}@typease.test`;
      const created = await t.as(admin).post('/platform/staff', { email: email.toUpperCase(), fullName: 'Noura Support', role: 'SUPPORT_AGENT' }).expect(201);
      expect(created.body).toMatchObject({ email, fullName: 'Noura Support', role: 'SUPPORT_AGENT', status: 'ACTIVE', invitationPending: true });
      const mail = t.messenger.lastFor(email, 'staff.invitation');
      expect(mail!.data).toMatchObject({ name: 'Noura Support', role: 'Platform Support Agent', days: 3 });
      expect(String(mail!.data.link)).toMatch(/^http:\/\/localhost:3004\/reset-password\?token=/);
      expect(String(mail!.data.link)).toContain(created.body.dev.passwordResetToken);
      // No password yet: signing in is impossible.
      await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD, app: 'platform' }).expect(401);
      // A second invitation replaces the first link.
      const again = await t.as(admin).post(`/platform/staff/${created.body.id}/invitation`).expect(200);
      await t.http.post('/api/v1/auth/password/reset').send({ token: created.body.dev.passwordResetToken, password: PASSWORD }).expect(400);
      await t.http.post('/api/v1/auth/password/reset').send({ token: again.body.dev.passwordResetToken, password: PASSWORD }).expect(200);
      const actor = await t.login(email, PASSWORD, 'platform');
      newcomer = { id: created.body.id, email, token: actor.token };
      await t.as(actor).get('/platform/tenants').expect(200);
      await t.as(actor).get('/platform/staff').expect(403);
      expect((await t.as(admin).post(`/platform/staff/${created.body.id}/invitation`).expect(409)).body.code).toBe('ALREADY_ACTIVATED');
      expect((await t.as(admin).get('/platform/staff?q=noura').expect(200)).body).toEqual([expect.objectContaining({ id: created.body.id, invitationPending: false })]);

      expect((await t.as(admin).post('/platform/staff', { email, fullName: 'Noura Again', role: 'SUPPORT_AGENT' }).expect(409)).body.code).toBe('ALREADY_STAFF');
      // A typing-centre account can never be turned into a platform account.
      expect((await t.as(admin).post('/platform/staff', { email: alpha.owner.email, fullName: 'Centre Owner', role: 'SUPER_ADMIN' }).expect(409)).body.code).toBe('EMAIL_IN_USE');
      expect((await t.sys.user.findUniqueOrThrow({ where: { id: alpha.owner.userId } })).platformRole).toBeNull();
      await t.as(admin).post('/platform/staff', { email: 'someone@typease.test', fullName: 'X Y', role: 'OWNER' }).expect(400);
      expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'platform.staff_created', resourceId: created.body.id } })).toBe(1);
      expect(await t.sys.securityEvent.count({ where: { type: 'PLATFORM_STAFF_CREATED', userId: admin.userId } })).toBeGreaterThanOrEqual(1);
    });

    it('changes a role with immediate effect; nobody changes or disables their own account', async () => {
      const promoted = await t.as(admin).patch(`/platform/staff/${newcomer.id}`, { role: 'SUPER_ADMIN', fullName: 'Noura Admin' }).expect(200);
      expect(promoted.body).toMatchObject({ role: 'SUPER_ADMIN', fullName: 'Noura Admin' });
      // The token she already had now carries the new role.
      await t.as({ token: newcomer.token } as Actor).get('/platform/staff').expect(200);
      const demoted = await t.as(admin).patch(`/platform/staff/${newcomer.id}`, { role: 'SUPPORT_AGENT' }).expect(200);
      expect(demoted.body.role).toBe('SUPPORT_AGENT');
      await t.as({ token: newcomer.token } as Actor).get('/platform/staff').expect(403);
      expect(await t.sys.securityEvent.count({ where: { type: 'PLATFORM_ROLE_CHANGED', severity: 'HIGH' } })).toBeGreaterThanOrEqual(2);

      expect((await t.as(admin).patch(`/platform/staff/${admin.userId}`, { role: 'SUPPORT_AGENT' }).expect(403)).body.code).toBe('SELF_CHANGE');
      expect((await t.as(admin).post(`/platform/staff/${admin.userId}/disable`).expect(403)).body.code).toBe('SELF_CHANGE');
      expect((await t.as(admin).post(`/platform/staff/${admin.userId}/enable`).expect(403)).body.code).toBe('SELF_CHANGE');
      // Renaming yourself is harmless and allowed.
      await t.as(admin).patch(`/platform/staff/${admin.userId}`, { fullName: 'Platform SUPER_ADMIN' }).expect(200);
      await t.as(admin).patch(`/platform/staff/${newcomer.id}`, {}).expect(400);
      await t.as(admin).patch(`/platform/staff/${alpha.owner.userId}`, { role: 'SUPER_ADMIN' }).expect(404);
      expect(await t.sys.user.findUniqueOrThrow({ where: { id: admin.userId } })).toMatchObject({ platformRole: 'SUPER_ADMIN', status: 'ACTIVE' });
    });

    it('disabling ends the sessions and every support access the person had', async () => {
      const victim = await t.createPlatformAdmin('SUPPORT_AGENT');
      const session = await supportSession(t, victim, alpha, ['customer.read']);
      const pending = await t.as(victim).post(`/platform/tenants/${beta.id}/access-grants`, { reason: 'Second request that is still waiting', scopes: ['customer.read'] }).expect(201);
      await t.as(session.support).get('/customers').expect(200);

      const disabled = await t.as(admin).post(`/platform/staff/${victim.userId}/disable`).expect(200);
      expect(disabled.body.status).toBe('DISABLED');
      await t.as(victim).get('/platform/tenants').expect(401);
      await t.as(session.support).get('/customers').expect(401);
      expect((await t.http.post('/api/v1/auth/login').send({ email: victim.email, password: PASSWORD, app: 'platform' })).status).toBe(403);
      expect((await t.sys.accessGrant.findMany({ where: { requestedById: victim.userId } })).map((g) => g.status).sort()).toEqual(['REVOKED', 'REVOKED']);
      expect(await t.sys.auditLog.count({ where: { tenantId: { in: [alpha.id, beta.id] }, action: 'support_access.revoked', resourceId: { in: [session.grantId, pending.body.id] } } })).toBe(2);
      expect((await t.as(admin).post(`/platform/staff/${victim.userId}/disable`).expect(409)).body.code).toBe('ALREADY_DISABLED');
      expect((await t.as(admin).post(`/platform/staff/${victim.userId}/invitation`).expect(409)).body.code).toBe('ALREADY_ACTIVATED');

      const enabled = await t.as(admin).post(`/platform/staff/${victim.userId}/enable`).expect(200);
      expect(enabled.body.status).toBe('ACTIVE');
      await t.login(victim.email, PASSWORD, 'platform');
      // Enabling does not bring the old access back.
      await t.as(session.support).get('/customers').expect(401);
      expect((await t.as(admin).post(`/platform/staff/${victim.userId}/enable`).expect(409)).body.code).toBe('ALREADY_ACTIVE');
    });

    it('always keeps one active Super Admin, even when two of them act at the same moment', async () => {
      // Make "a" and "b" the only two Super Admins for the duration of this test.
      const a = await t.createPlatformAdmin('SUPER_ADMIN');
      const b = await t.createPlatformAdmin('SUPER_ADMIN');
      const others = await t.sys.user.findMany({ where: { platformRole: 'SUPER_ADMIN', status: 'ACTIVE', id: { notIn: [a.userId, b.userId] } }, select: { id: true } });
      await t.sys.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { platformRole: 'SUPPORT_AGENT' } });
      try {
        const results = await Promise.all([t.as(a).post(`/platform/staff/${b.userId}/disable`), t.as(b).post(`/platform/staff/${a.userId}/disable`)]);
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([200, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe('LAST_SUPER_ADMIN');
        expect(await t.sys.user.count({ where: { platformRole: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
        // The same guard protects demotion.
        const survivor = results[0].status === 200 ? a : b;
        const loser = survivor === a ? b : a;
        await t.sys.user.update({ where: { id: loser.userId }, data: { status: 'ACTIVE' } });
        const loserNow = await t.login(loser.email, PASSWORD, 'platform');
        const both = await Promise.all([t.as(survivor).patch(`/platform/staff/${loser.userId}`, { role: 'SUPPORT_AGENT' }), t.as(loserNow).patch(`/platform/staff/${survivor.userId}`, { role: 'SUPPORT_AGENT' })]);
        expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await t.sys.user.count({ where: { platformRole: 'SUPER_ADMIN', status: 'ACTIVE' } })).toBe(1);
      } finally {
        await t.sys.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { platformRole: 'SUPER_ADMIN' } });
      }
      await t.as(admin).get('/platform/staff').expect(200);
    });
  });

  // ------------------------------------------------------------------ audit + security
  describe('platform audit and security events', () => {
    it('shows platform-level audit entries only, never a centre\'s own trail', async () => {
      await t.as(alpha.owner).post('/branches', { code: 'AUD1', name: 'Confidential Branch Name' }).expect(201);
      const tenantRow = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, resourceType: 'Branch' }, orderBy: { createdAt: 'desc' } });
      expect(JSON.stringify(tenantRow.after)).toContain('Confidential Branch Name');

      const list = await t.as(admin).get('/platform/audit-logs?pageSize=100').expect(200);
      expect(list.body.meta.total).toBe(await t.sys.auditLog.count({ where: { tenantId: null } }));
      const ids = new Set(list.body.data.map((r: any) => r.id));
      expect(ids.has(tenantRow.id)).toBe(false);
      expect(JSON.stringify(list.body)).not.toContain('Confidential Branch Name');
      for (const row of list.body.data) expect(row).not.toHaveProperty('before');
      expect(list.body.data.map((r: any) => r.action)).toEqual(expect.arrayContaining(['platform.staff_created', 'platform.setting_changed', 'platform.feature_flag_created']));
      await t.as(admin).get(`/platform/audit-logs/${tenantRow.id}`).expect(404);
      // Filters never widen the scope.
      expect((await t.as(admin).get(`/platform/audit-logs?resourceType=Branch`).expect(200)).body.meta.total).toBe(0);
      expect((await t.as(admin).get(`/platform/audit-logs?actorUserId=${alpha.owner.userId}`).expect(200)).body.meta.total).toBe(0);
      const staffRows = await t.as(admin).get('/platform/audit-logs?action=platform.staff_&pageSize=100').expect(200);
      expect(staffRows.body.data.length).toBeGreaterThan(0);
      expect(staffRows.body.data.every((r: any) => r.action.startsWith('platform.staff_'))).toBe(true);
      const detail = await t.as(admin).get(`/platform/audit-logs/${staffRows.body.data.at(-1).id}`).expect(200);
      expect(detail.body).toHaveProperty('after');
      expect(detail.body).not.toHaveProperty('tenantId');
      for (const actor of [agent, alpha.owner]) {
        await t.as(actor).get('/platform/audit-logs').expect(403);
        await t.as(actor).get('/platform/security-events').expect(403);
        await t.as(actor).get('/platform/security-events/summary').expect(403);
      }
    });

    it('lists security events with filters and a summary', async () => {
      // A real one: a wrong password at a centre.
      await t.http.post('/api/v1/auth/login').send({ email: alpha.owner.email, password: 'Wrong-Password-1', app: 'centre' }).expect(401);
      await t.sys.securityEvent.create({ data: { type: 'WEBHOOK_SIGNATURE_INVALID', severity: 'HIGH', tenantId: beta.id, details: { gateway: 'stripe' }, createdAt: new Date('2026-02-03T10:00:00Z') } });
      await t.sys.securityEvent.create({ data: { type: 'REFRESH_TOKEN_REUSE', severity: 'HIGH', tenantId: null, details: {}, createdAt: new Date('2026-02-04T10:00:00Z') } });

      const all = await t.as(admin).get('/platform/security-events?pageSize=100').expect(200);
      expect(all.body.meta.total).toBe(await t.sys.securityEvent.count());
      const failed = await t.as(admin).get('/platform/security-events?type=login_failed&pageSize=100').expect(200);
      expect(failed.body.data.length).toBeGreaterThanOrEqual(1);
      expect(failed.body.data.every((e: any) => e.type === 'LOGIN_FAILED')).toBe(true);
      const high = await t.as(admin).get(`/platform/security-events?severity=HIGH&centreId=${beta.id}`).expect(200);
      expect(high.body.data).toHaveLength(1);
      expect(high.body.data[0]).toMatchObject({ type: 'WEBHOOK_SIGNATURE_INVALID', severity: 'HIGH', centre: { id: beta.id, name: 'Beta Typing', slug: beta.slug }, details: { gateway: 'stripe' } });
      expect(high.body.data[0]).not.toHaveProperty('tenantId');
      const platformOnly = await t.as(admin).get('/platform/security-events?platformOnly=true&pageSize=100').expect(200);
      expect(platformOnly.body.data.every((e: any) => e.centre === null)).toBe(true);
      expect(platformOnly.body.data.map((e: any) => e.type)).toContain('REFRESH_TOKEN_REUSE');
      const ranged = await t.as(admin).get('/platform/security-events?from=2026-02-03&to=2026-02-04').expect(200);
      expect(ranged.body.data.map((e: any) => e.type)).toEqual(['REFRESH_TOKEN_REUSE', 'WEBHOOK_SIGNATURE_INVALID']);
      await t.as(admin).get('/platform/security-events?severity=SEVERE').expect(400);

      const summary = await t.as(admin).get('/platform/security-events/summary?from=2026-02-01&to=2026-02-28').expect(200);
      expect(summary.body).toMatchObject({ total: 2, bySeverity: { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 2, CRITICAL: 0 } });
      expect(summary.body.byType).toEqual([{ type: 'REFRESH_TOKEN_REUSE', severity: 'HIGH', count: 1 }, { type: 'WEBHOOK_SIGNATURE_INVALID', severity: 'HIGH', count: 1 }]);
      const recent = await t.as(admin).get('/platform/security-events/summary').expect(200);
      expect(recent.body.total).toBeGreaterThan(0);
      await t.as(admin).get('/platform/security-events/summary?from=2026-03-01&to=2026-02-01').expect(400);
    });
  });
});
