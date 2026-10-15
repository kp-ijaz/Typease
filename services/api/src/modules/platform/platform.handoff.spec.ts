import { createHash } from 'node:crypto';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { createCustomer } from '../finance/fixtures';
import { requestAccess } from './fixtures';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('Platform: support-session hand-off (console -> staff app)', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let customerId: string;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    customerId = (await createCustomer(t, alpha, { fullName: 'Mariam Al Hashimi' })).id;
    await t.settle();
  });
  afterAll(() => t.close());

  /** A fresh support agent with an approved grant for the centre. */
  const approved = async (scopes = ['customer.read'], over: Record<string, unknown> = {}) => {
    const staff = await t.createPlatformAdmin('SUPPORT_AGENT');
    const grant = await requestAccess(t, staff, alpha, scopes, over);
    const res = await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, {}).expect(200);
    return { staff, grantId: grant.id, expiresAt: res.body.expiresAt as string };
  };
  const enter = async (staff: Actor, grantId: string) => (await t.as(staff).post(`/platform/access-grants/${grantId}/enter`).expect(200)).body;
  const exchange = (code: string, headers: Record<string, string> = { 'X-Requested-With': 'typease' }) => {
    let r = t.http.post('/api/v1/auth/support-session/exchange');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send({ code });
  };
  const cookieOf = (res: { headers: Record<string, any> }) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('te_rt_centre=')) ?? '';

  it('enter returns a one-time code in a URL fragment; the staff app exchanges it for its own session', async () => {
    const { staff, grantId, expiresAt } = await approved(['customer.read', 'branch.read']);
    const before = Date.now();
    const entered = await enter(staff, grantId);
    expect(entered.handoff).toEqual({ code: expect.any(String), expiresAt: expect.any(String), url: `${env().CENTRE_WEB_URL}/support-session#code=${entered.handoff.code}` });
    expect(entered.handoff.code.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    const ttl = new Date(entered.handoff.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
    // Not in the query string (which servers log), and nowhere in the database in readable form.
    expect(new URL(entered.handoff.url).search).toBe('');
    const stored = await t.sys.authToken.findFirstOrThrow({ where: { type: 'SUPPORT_HANDOFF', userId: staff.userId } });
    expect(stored).toMatchObject({ tokenHash: sha(entered.handoff.code), tenantId: alpha.id, consumedAt: null, meta: { grantId } });
    expect(JSON.stringify(stored)).not.toContain(entered.handoff.code);

    // The code is not a token: it opens nothing by itself.
    expect((await t.http.get('/api/v1/customers').set('Authorization', `Bearer ${entered.handoff.code}`)).status).toBe(401);

    const res = await exchange(entered.handoff.code).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'expiresIn', 'landing', 'session', 'status']);
    expect(res.body).toMatchObject({ status: 'OK', landing: '/', expiresIn: expect.any(Number) });
    expect(res.body.session).toMatchObject({
      user: { id: staff.userId, platformRole: 'SUPPORT_AGENT' },
      tenant: { id: alpha.id, slug: alpha.slug, name: 'Alpha Typing' },
      membership: null,
      permissions: ['customer.read', 'branch.read'],
      supportGrant: { id: grantId, scopes: ['customer.read', 'branch.read'], writeScopes: [], readOnly: true, expiresAt, tenantId: alpha.id, tenantName: 'Alpha Typing', reason: 'Investigating support ticket about missing invoices' },
    });
    // The refresh token travels only as an HttpOnly cookie of the staff app, scoped to the auth path, and it
    // does not outlive the approved access.
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^te_rt_centre=[^;]{40,}; /);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
    expect(maxAge).toBeLessThanOrEqual(30 * 60);
    expect(maxAge).toBeGreaterThan(29 * 60 - 5);
    expect(JSON.stringify(res.body)).not.toContain('refreshToken');

    // The session works, within the granted scopes, and says what it is.
    const support: Actor = { ...staff, token: res.body.accessToken };
    expect((await t.as(support).get('/customers').expect(200)).body.data.map((c: any) => c.id)).toContain(customerId);
    await t.as(support).get('/invoices').expect(403);
    expect((await t.as(support).get('/auth/me').expect(200)).body.supportGrant).toMatchObject({ id: grantId, expiresAt, tenantName: 'Alpha Typing' });
    const row = await t.sys.session.findFirstOrThrow({ where: { supportGrantId: grantId, app: 'centre', revokedAt: null }, orderBy: { createdAt: 'desc' } });
    expect(row.expiresAt.toISOString()).toBe(expiresAt);
    expect(row).toMatchObject({ userId: staff.userId, tenantId: alpha.id, membershipId: null });

    // The cookie refreshes the session like any other session of the staff app.
    const refreshed = await t.http.post('/api/v1/auth/refresh').set('X-Requested-With', 'typease').set('X-Client-App', 'centre').set('Cookie', cookie.split(';')[0]).send({}).expect(200);
    expect(refreshed.body.session.supportGrant).toMatchObject({ id: grantId });
    await t.as({ ...staff, token: refreshed.body.accessToken }).get('/customers').expect(200);

    // Recorded on both trails and as a security event.
    const entries = await t.sys.auditLog.findMany({ where: { action: 'support_access.entered', resourceId: grantId, after: { path: ['via'], equals: 'HANDOFF' } } });
    expect(entries.map((e) => e.tenantId).sort()).toEqual([alpha.id, null].sort());
    for (const e of entries) expect(e).toMatchObject({ actorUserId: staff.userId, actorType: 'PLATFORM', supportGrantId: grantId, actorLabel: 'Platform SUPPORT_AGENT (TypEase support)' });
    expect(await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'SUPPORT_ACCESS_ENTERED', userId: staff.userId, details: { path: ['via'], equals: 'HANDOFF' } } })).toBe(1);
    // The centre's owner sees it.
    const seen = await t.as(alpha.owner).get(`/audit-logs?supportGrantId=${grantId}&pageSize=100`).expect(200);
    expect(seen.body.data.filter((r: any) => r.action === 'support_access.entered').length).toBe(2); // console + staff app
  });

  it('a code works once; without the custom header nothing happens and the code is not burned', async () => {
    const { staff, grantId } = await approved();
    const { handoff } = await enter(staff, grantId);
    // A cross-site form post cannot send the header: refused before the code is looked at.
    expect((await exchange(handoff.code, {}).expect(403)).body.code).toBe('CSRF_CHECK_FAILED');
    expect((await exchange(handoff.code, { 'X-Requested-With': 'XMLHttpRequest' }).expect(403)).body.code).toBe('CSRF_CHECK_FAILED');
    const first = await exchange(handoff.code).expect(200);
    const second = await exchange(handoff.code).expect(400);
    expect(second.body).toMatchObject({ code: 'HANDOFF_INVALID' });
    expect(cookieOf(second)).toBe('');
    expect(await t.sys.securityEvent.count({ where: { type: 'SUPPORT_HANDOFF_REJECTED', tenantId: alpha.id, details: { path: ['reason'], equals: 'CODE_REUSED' } } })).toBe(1);
    // The first session is unaffected by the replay.
    await t.as({ ...staff, token: first.body.accessToken }).get('/customers').expect(200);
    // Garbage: too short is a validation error, a well-formed unknown code is simply invalid.
    await exchange('short').expect(400);
    expect((await exchange('A'.repeat(43)).expect(400)).body.code).toBe('HANDOFF_INVALID');
    await t.http.post('/api/v1/auth/support-session/exchange').set('X-Requested-With', 'typease').send({}).expect(400);
  });

  it('an expired code is refused, and a new enter replaces the code that was not used', async () => {
    const { staff, grantId } = await approved();
    const first = (await enter(staff, grantId)).handoff;
    await t.sys.authToken.updateMany({ where: { type: 'SUPPORT_HANDOFF', tokenHash: sha(first.code) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await exchange(first.code).expect(400)).body.code).toBe('HANDOFF_INVALID');
    expect(await t.sys.securityEvent.count({ where: { type: 'SUPPORT_HANDOFF_REJECTED', details: { path: ['reason'], equals: 'CODE_EXPIRED' } } })).toBe(1);

    const second = (await enter(staff, grantId)).handoff;
    const third = (await enter(staff, grantId)).handoff;
    expect(new Set([first.code, second.code, third.code]).size).toBe(3);
    expect((await exchange(second.code).expect(400)).body.code).toBe('HANDOFF_INVALID');
    await exchange(third.code).expect(200);
  });

  it('the grant, the account and the centre are checked again at the moment of the exchange', async () => {
    // Revoked by the centre between enter and exchange.
    const revoked = await approved();
    const a = (await enter(revoked.staff, revoked.grantId)).handoff;
    await t.as(alpha.owner).post(`/support-access/${revoked.grantId}/revoke`, {}).expect(200);
    const refused = await exchange(a.code).expect(403);
    expect(refused.body.code).toBe('SUPPORT_ACCESS_ENDED');
    expect(cookieOf(refused)).toBe('');
    // The refusal used the code up: it cannot be tried again.
    expect((await exchange(a.code).expect(400)).body.code).toBe('HANDOFF_INVALID');
    expect(await t.sys.session.count({ where: { supportGrantId: revoked.grantId, revokedAt: null } })).toBe(0);

    // The approved time ran out.
    const lapsed = await approved(['customer.read'], { durationMinutes: 5 });
    const b = (await enter(lapsed.staff, lapsed.grantId)).handoff;
    await t.sys.accessGrant.update({ where: { id: lapsed.grantId }, data: { startsAt: new Date(Date.now() - 6 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await exchange(b.code).expect(403)).body.code).toBe('SUPPORT_ACCESS_ENDED');

    // The platform account was switched off.
    const gone = await approved();
    const c = (await enter(gone.staff, gone.grantId)).handoff;
    await t.sys.user.update({ where: { id: gone.staff.userId }, data: { status: 'DISABLED' } });
    expect((await exchange(c.code).expect(403)).body.code).toBe('ACCOUNT_DISABLED');

    // The person is no longer platform staff.
    const demoted = await approved();
    const d = (await enter(demoted.staff, demoted.grantId)).handoff;
    await t.sys.user.update({ where: { id: demoted.staff.userId }, data: { platformRole: null } });
    expect((await exchange(d.code).expect(403)).body.code).toBe('ACCOUNT_DISABLED');
    expect(await t.sys.auditLog.count({ where: { action: 'support_access.entered', resourceId: { in: [lapsed.grantId, gone.grantId, demoted.grantId] }, after: { path: ['via'], equals: 'HANDOFF' } } })).toBe(0);
  });

  it('two exchanges at the same moment: exactly one gets the session', async () => {
    for (let round = 0; round < 3; round++) {
      const { staff, grantId } = await approved();
      const { handoff } = await enter(staff, grantId);
      const sessionsBefore = await t.sys.session.count({ where: { supportGrantId: grantId } });
      const results = await Promise.all([exchange(handoff.code), exchange(handoff.code), exchange(handoff.code), exchange(handoff.code)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400]);
      expect(results.filter((r) => r.status === 400).every((r) => r.body.code === 'HANDOFF_INVALID')).toBe(true);
      expect(results.filter((r) => cookieOf(r)).length).toBe(1);
      expect((await t.sys.session.count({ where: { supportGrantId: grantId } })) - sessionsBefore).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'support_access.entered', resourceId: grantId, after: { path: ['via'], equals: 'HANDOFF' } } })).toBe(1);
    }
  });

  it('the session opened by the hand-off ends with the grant: revocation and expiry, on the next request', async () => {
    const one = await approved();
    const first = await exchange((await enter(one.staff, one.grantId)).handoff.code).expect(200);
    const cookie = cookieOf(first).split(';')[0];
    const support: Actor = { ...one.staff, token: first.body.accessToken };
    await t.as(support).get('/customers').expect(200);
    await t.as(alpha.owner).post(`/support-access/${one.grantId}/revoke`, {}).expect(200);
    await t.as(support).get('/customers').expect(401);
    await t.as(support).get('/auth/me').expect(401);
    await t.http.post('/api/v1/auth/refresh').set('X-Requested-With', 'typease').set('X-Client-App', 'centre').set('Cookie', cookie).send({}).expect(401);

    const two = await approved(['customer.read'], { durationMinutes: 5 });
    const second = await exchange((await enter(two.staff, two.grantId)).handoff.code).expect(200);
    const live: Actor = { ...two.staff, token: second.body.accessToken };
    await t.as(live).get('/customers').expect(200);
    await t.sys.accessGrant.update({ where: { id: two.grantId }, data: { startsAt: new Date(Date.now() - 6 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await t.as(live).get('/customers').expect(401)).body.code).toBe('SUPPORT_ACCESS_ENDED');
    expect((await t.as(live).get('/auth/me').expect(401)).body.code).toBe('SUPPORT_ACCESS_ENDED');
    await t.http.post('/api/v1/auth/refresh').set('X-Requested-With', 'typease').set('X-Client-App', 'centre').set('Cookie', cookieOf(second).split(';')[0]).send({}).expect(401);
  });

  it('only the person who asked gets a code, and only while the access is approved', async () => {
    const { staff, grantId } = await approved();
    const other = await t.createPlatformAdmin('SUPPORT_AGENT');
    const admin = await t.createPlatformAdmin('SUPER_ADMIN');
    await t.as(other).post(`/platform/access-grants/${grantId}/enter`).expect(404);
    await t.as(admin).post(`/platform/access-grants/${grantId}/enter`).expect(404);
    await t.as(alpha.owner).post(`/platform/access-grants/${grantId}/enter`).expect(403);
    expect(await t.sys.authToken.count({ where: { type: 'SUPPORT_HANDOFF', meta: { path: ['grantId'], equals: grantId } } })).toBe(0);
    const waiting = await requestAccess(t, other, alpha, ['customer.read']);
    await t.as(other).post(`/platform/access-grants/${waiting.id}/enter`).expect(409);
    expect(await t.sys.authToken.count({ where: { type: 'SUPPORT_HANDOFF', userId: other.userId } })).toBe(0);
    await enter(staff, grantId);
    expect(await t.sys.authToken.count({ where: { type: 'SUPPORT_HANDOFF', userId: staff.userId } })).toBe(1);
  });
});
