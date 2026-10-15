import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MAX_LIVE_SESSIONS_PER_APP } from '../src/modules/auth/auth.service';
import { Actor, PASSWORD, TenantFixture, TestApp } from './helpers';

describe('Sessions: a cap per user and app, a bounded list, signing out everywhere else', () => {
  let t: TestApp;
  let alpha: TenantFixture;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
  });
  afterAll(() => t.close());

  const signIn = async (email: string, app: string, deviceName?: string) => {
    const res = await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD, app, tenantSlug: app === 'centre' ? undefined : alpha.slug, deviceName });
    if (res.status !== 200 || res.body.status !== 'OK') throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    // The mobile app gets its refresh token in the body, a browser app as an HttpOnly cookie.
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`te_rt_${app}=`))?.split(';')[0];
    const refreshToken = res.body.refreshToken as string | undefined;
    if (!refreshToken && !cookie) throw new Error('login returned neither a refresh token nor a refresh cookie');
    return {
      token: res.body.accessToken as string,
      refreshToken,
      sessionId: JSON.parse(Buffer.from((res.body.accessToken as string).split('.')[1], 'base64url').toString()).sid as string,
      /** Tries to refresh this session the way its app would. */
      refresh: () => (refreshToken ? t.http.post('/api/v1/auth/refresh').send({ refreshToken, app }) : t.http.post('/api/v1/auth/refresh').set('X-Requested-With', 'typease').set('X-Client-App', app).set('Cookie', cookie!).send({})),
    };
  };
  type SignedIn = Awaited<ReturnType<typeof signIn>>;
  const as = (actor: Actor, token: string): Actor => ({ ...actor, token });
  const live = (userId: string, app?: string) => t.sys.session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() }, ...(app ? { app } : {}) }, orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }] });
  /** Sessions as an earlier, unlimited version of the system could have left them behind. */
  const seedOldSessions = async (userId: string, app: string, count: number, membershipId: string | null, tenantId: string | null) => {
    const base = Date.now() - 10 * 86_400_000;
    await t.sys.session.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        userId, tenantId, membershipId, app, refreshTokenHash: createHash('sha256').update(randomBytes(24)).digest('hex'), familyId: randomUUID(),
        createdAt: new Date(base + i * 1000), lastUsedAt: new Date(base + i * 1000), expiresAt: new Date(Date.now() + 20 * 86_400_000), deviceName: `old-${i}`,
      })),
    });
  };

  it('keeps at most 20 live sessions per user and app: a further sign-in ends the oldest', async () => {
    expect(MAX_LIVE_SESSIONS_PER_APP).toBe(20);
    const customer = await t.addCustomer(alpha);
    await t.sys.session.updateMany({ where: { userId: customer.userId }, data: { revokedAt: new Date(), revokedReason: 'TEST_RESET' } });
    const sessions: SignedIn[] = [];
    for (let i = 0; i < 20; i++) sessions.push(await signIn(customer.email, 'customer', `device-${i}`));
    expect(await live(customer.userId, 'customer')).toHaveLength(20);
    // All twenty work.
    await t.as(as(customer, sessions[0].token)).get('/auth/me').expect(200);
    await t.as(as(customer, sessions[19].token)).get('/auth/me').expect(200);

    // Number 21, 22 and 23: each one ends the oldest that is left.
    for (let i = 20; i < 23; i++) sessions.push(await signIn(customer.email, 'customer', `device-${i}`));
    const now = await live(customer.userId, 'customer');
    expect(now).toHaveLength(20);
    expect(now.map((s) => s.deviceName).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `device-${i + 3}`).sort());
    const ended = await t.sys.session.findMany({ where: { id: { in: sessions.slice(0, 3).map((s) => s.sessionId) } } });
    expect(ended.map((s) => s.revokedReason)).toEqual(['SESSION_LIMIT', 'SESSION_LIMIT', 'SESSION_LIMIT']);
    // An ended session stops working at once - access token and refresh token - and the others are untouched.
    for (const old of sessions.slice(0, 3)) {
      expect((await t.as(as(customer, old.token)).get('/auth/me').expect(401)).body.code).toBe('SESSION_EXPIRED');
      await old.refresh().expect(401);
    }
    await t.as(as(customer, sessions[3].token)).get('/auth/me').expect(200);
    await t.as(as(customer, sessions[22].token)).get('/auth/me').expect(200);
    // A live browser session still refreshes through its cookie.
    await sessions[22].refresh().expect(200);
    expect(await live(customer.userId, 'customer')).toHaveLength(20);
    // Raised while signing in (nobody is signed in yet): filed under the person it is about.
    expect(await t.sys.securityEvent.count({ where: { type: 'SESSION_LIMIT_REACHED', userId: customer.userId, details: { path: ['userId'], equals: customer.userId } } })).toBe(3);
  });

  it('counts per app, and refreshing a session never adds one', async () => {
    const customer = await t.addCustomer(alpha);
    await t.sys.session.updateMany({ where: { userId: customer.userId }, data: { revokedAt: new Date(), revokedReason: 'TEST_RESET' } });
    for (let i = 0; i < 21; i++) await signIn(customer.email, 'customer');
    const mobile: SignedIn[] = [];
    for (let i = 0; i < 4; i++) mobile.push(await signIn(customer.email, 'mobile'));
    expect(await live(customer.userId, 'customer')).toHaveLength(20);
    expect(await live(customer.userId, 'mobile')).toHaveLength(4);
    // The portal being full does not cost the phone its sessions.
    for (const m of mobile) await t.as(as(customer, m.token)).get('/auth/me').expect(200);
    // Refresh rotates the session (the old row is closed, a new one takes its place): the count stays.
    let refreshToken = mobile[0].refreshToken!;
    for (let i = 0; i < 5; i++) {
      const res = await t.http.post('/api/v1/auth/refresh').send({ refreshToken, app: 'mobile' }).expect(200);
      refreshToken = res.body.refreshToken;
    }
    expect(await live(customer.userId, 'mobile')).toHaveLength(4);
    expect(await live(customer.userId, 'customer')).toHaveLength(20);
    expect(await t.sys.session.count({ where: { userId: customer.userId, app: 'mobile', revokedReason: 'SESSION_LIMIT' } })).toBe(0);
  });

  it('an account that already has 150 live sessions is brought back to 20 by its next sign-in', async () => {
    const staff = await t.addStaff(alpha, 'operator');
    await seedOldSessions(staff.userId, 'centre', 150, staff.membershipId, alpha.id);
    expect((await live(staff.userId, 'centre')).length).toBeGreaterThanOrEqual(150);
    const fresh = await signIn(staff.email, 'centre', 'today');
    const left = await live(staff.userId, 'centre');
    expect(left).toHaveLength(20);
    expect(left[0]).toMatchObject({ id: fresh.sessionId, deviceName: 'today' });
    // The ones that stay are the most recent ones.
    const oldLeft = left.filter((s) => s.deviceName?.startsWith('old-')).map((s) => Number(s.deviceName!.slice(4)));
    expect(Math.min(...oldLeft)).toBeGreaterThanOrEqual(150 - 19);
    expect(await t.sys.session.count({ where: { userId: staff.userId, revokedReason: 'SESSION_LIMIT' } })).toBeGreaterThanOrEqual(131);
    await t.as(as(staff, fresh.token)).get('/auth/me').expect(200);
  });

  it('lists sessions most recent first, bounded, with the current one always included and flagged', async () => {
    const customer = await t.addCustomer(alpha);
    await t.sys.session.updateMany({ where: { userId: customer.userId }, data: { revokedAt: new Date(), revokedReason: 'TEST_RESET' } });
    const portal: SignedIn[] = [];
    for (let i = 0; i < 8; i++) {
      portal.push(await signIn(customer.email, 'customer', `portal-${i}`));
      // Distinct moments, so that "most recent first" is unambiguous.
      await t.sys.session.update({ where: { id: portal[i].sessionId }, data: { createdAt: new Date(Date.now() - (20 - i) * 60_000), lastUsedAt: new Date(Date.now() - (20 - i) * 60_000) } });
    }
    const phone = await signIn(customer.email, 'mobile', 'phone');
    const newest = as(customer, phone.token);
    const oldest = as(customer, portal[0].token);

    const all = await t.as(newest).get('/auth/sessions').expect(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.headers['x-total-count']).toBe('9');
    expect(all.body.map((s: any) => s.deviceName)).toEqual(['phone', 'portal-7', 'portal-6', 'portal-5', 'portal-4', 'portal-3', 'portal-2', 'portal-1', 'portal-0']);
    expect(all.body.filter((s: any) => s.current).map((s: any) => s.id)).toEqual([phone.sessionId]);
    expect(Object.keys(all.body[0]).sort()).toEqual(['app', 'createdAt', 'current', 'deviceName', 'expiresAt', 'id', 'ip', 'lastUsedAt', 'supportSession', 'tenantId', 'userAgent']);
    expect(JSON.stringify(all.body)).not.toMatch(/refreshToken|familyId/);

    // A limit: the most recent ones ...
    const three = await t.as(newest).get('/auth/sessions?limit=3').expect(200);
    expect(three.body.map((s: any) => s.deviceName)).toEqual(['phone', 'portal-7', 'portal-6']);
    expect(three.headers['x-total-count']).toBe('9');
    // The session that asks is in use at this moment, so it normally leads the list ("last used" follows use) ...
    const inUse = await t.as(oldest).get('/auth/sessions?limit=3').expect(200);
    expect(inUse.body.map((s: any) => [s.deviceName, s.current])).toEqual([['portal-0', true], ['phone', false], ['portal-7', false]]);
    // ... and when it is not among the most recent (others were used in the last seconds), it takes the last place - still flagged.
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
    await t.sys.session.update({ where: { id: portal[0].sessionId }, data: { lastUsedAt: ago(40) } });
    await t.sys.session.update({ where: { id: phone.sessionId }, data: { lastUsedAt: ago(5) } });
    await t.sys.session.update({ where: { id: portal[7].sessionId }, data: { lastUsedAt: ago(10) } });
    await t.sys.session.update({ where: { id: portal[6].sessionId }, data: { lastUsedAt: ago(20) } });
    const fromOldest = await t.as(oldest).get('/auth/sessions?limit=3').expect(200);
    expect(fromOldest.body.map((s: any) => [s.deviceName, s.current])).toEqual([['phone', false], ['portal-7', false], ['portal-0', true]]);
    expect((await t.as(oldest).get('/auth/sessions?limit=1').expect(200)).body.map((s: any) => [s.deviceName, s.current])).toEqual([['portal-0', true]]);
    // One app only.
    const mobileOnly = await t.as(newest).get('/auth/sessions?app=mobile').expect(200);
    expect(mobileOnly.body.map((s: any) => s.deviceName)).toEqual(['phone']);
    expect(mobileOnly.headers['x-total-count']).toBe('1');
    // The default bound is 20, the highest 100.
    await seedOldSessions(customer.userId, 'corporate', 30, null, null);
    const bounded = await t.as(newest).get('/auth/sessions').expect(200);
    expect(bounded.body).toHaveLength(20);
    expect(bounded.headers['x-total-count']).toBe('39');
    expect(bounded.body[0]).toMatchObject({ deviceName: 'phone', current: true });
    expect((await t.as(newest).get('/auth/sessions?limit=100').expect(200)).body).toHaveLength(39);
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'app=nonsense']) await t.as(newest).get(`/auth/sessions?${bad}`).expect(400);
    // Somebody else's sessions are never in the list.
    const other = await t.addCustomer(alpha);
    expect((await t.as(other).get('/auth/sessions?limit=100').expect(200)).body.every((s: any) => !portal.some((p) => p.sessionId === s.id))).toBe(true);
    await t.http.get('/api/v1/auth/sessions').expect(401);
  });

  it('"last used" follows use, written at most once a minute per session; a refresh starts the new session at "now"', async () => {
    const customer = await t.addCustomer(alpha);
    const session = await signIn(customer.email, 'customer', 'phone');
    const row = () => t.sys.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    const me = as(customer, session.token);

    // Used again within the minute: nothing is written.
    const fresh = (await row()).lastUsedAt;
    await t.as(me).get('/auth/me').expect(200);
    await t.as(me).get('/auth/sessions').expect(200);
    expect((await row()).lastUsedAt).toEqual(fresh);
    // 59 seconds: not yet.
    const almost = new Date(Date.now() - 59_000);
    await t.sys.session.update({ where: { id: session.sessionId }, data: { lastUsedAt: almost } });
    await t.as(me).get('/auth/me').expect(200);
    expect((await row()).lastUsedAt).toEqual(almost);

    // Five minutes of silence, then a request: moved forward once, and not again by the requests that follow.
    await t.sys.session.update({ where: { id: session.sessionId }, data: { lastUsedAt: new Date(Date.now() - 5 * 60_000) } });
    const before = Date.now();
    await t.as(me).get('/auth/me').expect(200);
    const touched = (await row()).lastUsedAt;
    expect(touched.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(touched.getTime()).toBeLessThanOrEqual(Date.now());
    await Promise.all([t.as(me).get('/auth/me').expect(200), t.as(me).get('/auth/me').expect(200), t.as(me).get('/auth/sessions').expect(200)]);
    expect((await row()).lastUsedAt).toEqual(touched);
    // The list of sessions shows it.
    const listed = (await t.as(me).get('/auth/sessions').expect(200)).body;
    expect(new Date(listed.find((x: any) => x.current).lastUsedAt).getTime()).toBe(touched.getTime());
    // A request that is refused for lack of permission is use as well (the person is there); one without a valid session is not.
    await t.sys.session.update({ where: { id: session.sessionId }, data: { lastUsedAt: new Date(Date.now() - 5 * 60_000) } });
    await t.as(me).get('/customers').expect(403);
    expect((await row()).lastUsedAt.getTime()).toBeGreaterThanOrEqual(before - 5);

    // Refresh: the old session ends (ROTATED, untouched from then on), the one that replaces it was last used now.
    await t.sys.session.update({ where: { id: session.sessionId }, data: { lastUsedAt: new Date(Date.now() - 20 * 60_000) } });
    const stale = (await row()).lastUsedAt;
    const at = Date.now();
    const refreshed = await session.refresh();
    expect(refreshed.status).toBe(200);
    expect(await row()).toMatchObject({ revokedReason: 'ROTATED', lastUsedAt: stale });
    const next = (await live(customer.userId, 'customer')).find((x) => x.deviceName === 'phone')!;
    expect(next.id).not.toBe(session.sessionId);
    expect(next.lastUsedAt.getTime()).toBeGreaterThanOrEqual(at - 5);
    // The rotated token no longer opens anything, and a revoked session is never touched.
    await t.as(me).get('/auth/me').expect(401);
    expect((await row()).lastUsedAt).toEqual(stale);
  });

  it('a rotated refresh token that is presented again ends the family and is filed under the person it belongs to', async () => {
    const customer = await t.addCustomer(alpha);
    const first = await signIn(customer.email, 'customer', 'tablet');
    const family = (await t.sys.session.findUniqueOrThrow({ where: { id: first.sessionId } })).familyId;
    const second = await first.refresh();
    expect(second.status).toBe(200);
    expect(await t.sys.securityEvent.count({ where: { type: 'REFRESH_TOKEN_REUSE', userId: customer.userId } })).toBe(0);

    // The old token again (stolen, or replayed): refused, and everything of that sign-in ends.
    const replay = await first.refresh();
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SESSION_EXPIRED');
    expect(await t.sys.session.count({ where: { familyId: family, revokedAt: null } })).toBe(0);
    await t.as(as(customer, second.body.accessToken)).get('/auth/me').expect(401);

    // The security event names the person in its own column (it is raised without a signed-in caller), and the centre.
    const events = await t.sys.securityEvent.findMany({ where: { type: 'REFRESH_TOKEN_REUSE', userId: customer.userId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: 'HIGH', userId: customer.userId, tenantId: alpha.id, details: expect.objectContaining({ userId: customer.userId, familyId: family }) });
    // So the platform's security log can be filtered by that person.
    const admin = await t.createPlatformAdmin('SUPER_ADMIN');
    const found = await t.as(admin).get(`/platform/security-events?type=REFRESH_TOKEN_REUSE&userId=${customer.userId}`);
    if (found.status === 200) expect(found.body.data.map((e: any) => e.id)).toEqual([events[0].id]);
    // Other sign-ins of the same person are not affected.
    const other = await signIn(customer.email, 'customer', 'laptop');
    await t.as(as(customer, other.token)).get('/auth/me').expect(200);
  });

  it('signs out everywhere else, in every app, and keeps the session that asked', async () => {
    const customer = await t.addCustomer(alpha);
    await t.sys.session.updateMany({ where: { userId: customer.userId }, data: { revokedAt: new Date(), revokedReason: 'TEST_RESET' } });
    const portal = [await signIn(customer.email, 'customer'), await signIn(customer.email, 'customer'), await signIn(customer.email, 'customer')];
    const phone = [await signIn(customer.email, 'mobile'), await signIn(customer.email, 'mobile')];
    const bystander = await t.addCustomer(alpha);
    const mine = as(customer, portal[1].token);

    const res = await t.as(mine).post('/auth/sessions/revoke-others').expect(200);
    expect(res.body).toEqual({ revoked: 4 });
    const left = await live(customer.userId);
    expect(left.map((s) => s.id)).toEqual([portal[1].sessionId]);
    expect(await t.sys.session.count({ where: { userId: customer.userId, revokedReason: 'REVOKED_BY_USER' } })).toBe(4);
    await t.as(mine).get('/auth/me').expect(200);
    for (const gone of [portal[0], portal[2], ...phone]) {
      await t.as(as(customer, gone.token)).get('/auth/me').expect(401);
      await gone.refresh().expect(401);
    }
    // Nobody else is affected, and doing it again finds nothing to end.
    await t.as(bystander).get('/auth/me').expect(200);
    expect((await t.as(mine).post('/auth/sessions/revoke-others').expect(200)).body).toEqual({ revoked: 0 });
    expect((await t.as(mine).get('/auth/sessions').expect(200)).body).toHaveLength(1);

    // One session can be ended by id - one's own only.
    const extra = await signIn(customer.email, 'mobile');
    await t.as(bystander).delete(`/auth/sessions/${extra.sessionId}`).expect(404);
    await t.as(mine).delete(`/auth/sessions/${extra.sessionId}`).expect(200);
    await t.as(as(customer, extra.token)).get('/auth/me').expect(401);
    await t.as(mine).get('/auth/me').expect(200);
  });
});
