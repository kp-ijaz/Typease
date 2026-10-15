import { createHmac } from 'node:crypto';
import { Actor, anonymous, api, call, Centre, inviteStaff, isIdParam, nameParam, NO_SUCH_ID, PASSWORD, registerPortalCustomer, Route, routeName, routeTable, signUpCentre, TestApp, textOf, uniq, urlOf } from '../support';

/**
 * Who are you? The boundary in front of all the others:
 *
 *   - every route that is not declared public refuses a caller without a valid
 *     session (the whole route table is walked, with several kinds of bad token);
 *   - the routes that ARE public are a reviewed list, and each of them either
 *     shows presentation data only or asks for a credential of its own;
 *   - a refresh token is single-use, and using one twice ends the whole
 *     session family;
 *   - signing out, signing out everywhere, the list of sessions and the cap of
 *     twenty live sessions per user and app.
 */

/** A JSON Web Token made by hand (HS256 / none), so that the test controls every bit of it. */
function makeToken(payload: Record<string, unknown>, secret: string, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const alg = String(header.alg);
  const signature = alg === 'none' ? '' : createHmac(alg === 'HS512' ? 'sha512' : 'sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, any>;

/**
 * The reviewed list of routes that need no session. A new public route makes the first test fail until
 * somebody adds it here - and says in the second test what it gives to a stranger.
 */
const PUBLIC_ROUTES = [
  'GET /api/v1/auth/invitations/preview',
  'GET /api/v1/internal/tls/ask',
  'GET /api/v1/public/appointments/availability',
  'GET /api/v1/public/appointments/options',
  'GET /api/v1/public/assets/:key',
  'GET /api/v1/public/payments/sandbox/checkout/:sessionRef',
  'GET /api/v1/public/plans',
  'GET /api/v1/public/queue/display',
  'GET /api/v1/public/queue/display/stream',
  'GET /api/v1/public/services',
  'GET /api/v1/public/services/:id',
  'GET /api/v1/public/shared-documents/:token',
  'GET /api/v1/public/slug-available',
  'GET /api/v1/public/tenant-config',
  'GET /api/v1/storage/local/download/:token',
  'GET /health',
  'GET /health/ready',
  'POST /api/v1/auth/invitations/accept',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/mfa/verify',
  'POST /api/v1/auth/otp/request',
  'POST /api/v1/auth/otp/verify',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/auth/select-tenant',
  'POST /api/v1/auth/support-session/exchange',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/public/appointments',
  'POST /api/v1/public/appointments/cancel',
  'POST /api/v1/public/payments/sandbox/checkout/:sessionRef/complete',
  'POST /api/v1/public/payments/sandbox/checkout/:sessionRef/fail',
  'POST /api/v1/public/signup',
  'POST /api/v1/public/track',
  'POST /api/v1/public/webhooks/payments/:gateway',
  'POST /api/v1/public/webhooks/subscriptions/:gateway',
  'PUT /api/v1/storage/local/upload/:token',
];

describe('Authentication and sessions', () => {
  let t: TestApp;
  let centre: Centre;
  let receptionist: Actor;
  let customer: Actor;
  let routes: Route[];
  const id = uniq();
  const SECRET = () => process.env.JWT_ACCESS_SECRET!;
  const customerEmail = `session-${id}@example.test`;

  /** Signs in like the mobile app does: the refresh token comes back in the body. */
  async function mobileSignIn(email = customerEmail, deviceName = 'Test phone') {
    const res = await t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD, app: 'mobile', tenantSlug: centre.slug, deviceName });
    if (res.status !== 200 || res.body.status !== 'OK') throw new Error(`mobile sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { access: res.body.accessToken as string, refresh: res.body.refreshToken as string, sessionId: claimsOf(res.body.accessToken).sid as string };
  }
  const refreshWith = (refreshToken: string) => t.http.post('/api/v1/auth/refresh').send({ refreshToken, app: 'mobile' });
  const me = (token: string) => t.http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Front Door ${id}` });
    receptionist = await inviteStaff(t, centre, 'receptionist');
    customer = await registerPortalCustomer(t, centre, { fullName: `Session Holder ${id}`, email: customerEmail });
    routes = routeTable(t);
    await t.settle();
  });
  afterAll(() => t.close());

  it('unauthenticated access to every non-public route is refused (the whole route table)', async () => {
    // The list of public routes is the reviewed one - nothing more, nothing less.
    expect(routes.filter((r) => !r.rule).map(routeName)).toEqual([]);
    expect(routes.filter((r) => r.rule!.type === 'public').map(routeName).sort()).toEqual(PUBLIC_ROUTES);
    const guarded = routes.filter((r) => r.rule!.type !== 'public');
    expect(guarded.length).toBeGreaterThan(540);

    const real = claimsOf(receptionist.token);
    const now = Math.floor(Date.now() / 1000);
    const badTokens: Record<string, string | null> = {
      'no token': null,
      'not a token': 'not-a-token',
      'expired, correctly signed': makeToken({ ...real, iat: now - 7200, exp: now - 3600 }, SECRET()),
      'signed with another key': makeToken(real, 'another-secret-0123456789abcdef0123456789abcdef'),
    };
    // Control: a hand-made token with the real key and unchanged claims IS accepted - the forgeries below fail
    // for the one thing that is wrong with each of them.
    expect((await me(makeToken(real, SECRET()))).status).toBe(200);

    const wrong: string[] = [];
    let calls = 0;
    for (const r of guarded) {
      const url = urlOf(r, (param) => (isIdParam(param) ? NO_SUCH_ID : nameParam(param)));
      for (const [label, token] of Object.entries(badTokens)) {
        const res = await call(t, null, r, url, {}, token ? { Authorization: `Bearer ${token}` } : {});
        calls += 1;
        if (res.status !== 401) wrong.push(`${routeName(r)} with ${label} -> ${res.status} ${res.body?.code ?? ''}`);
        // A refusal says "sign in" and nothing else.
        else if (Object.keys(res.body).some((k) => !['statusCode', 'code', 'message', 'requestId'].includes(k))) wrong.push(`${routeName(r)} with ${label} -> the refusal carries ${Object.keys(res.body).join(', ')}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(calls).toBe(guarded.length * 4);

    // More ways to be wrong, on a sample that has one route of every kind of access rule.
    const sample = ['GET /api/v1/customers', 'GET /api/v1/auth/me', 'GET /api/v1/platform/tenants', 'GET /api/v1/me/customer', 'POST /api/v1/refunds/:id/approve', 'GET /api/v1/documents/:id', 'GET /api/v1/internal/metrics'].map((name) => guarded.find((r) => routeName(r) === name)!);
    expect(sample.every(Boolean)).toBe(true);
    const moreBad: Record<string, Record<string, string>> = {
      'algorithm "none"': { Authorization: `Bearer ${makeToken(real, '', { alg: 'none', typ: 'JWT' })}` },
      'another algorithm (HS512)': { Authorization: `Bearer ${makeToken(real, SECRET(), { alg: 'HS512', typ: 'JWT' })}` },
      'another audience': { Authorization: `Bearer ${makeToken({ ...real, aud: 'somebody-else' }, SECRET())}` },
      'another issuer': { Authorization: `Bearer ${makeToken({ ...real, iss: 'somebody-else' }, SECRET())}` },
      'a session that does not exist': { Authorization: `Bearer ${makeToken({ ...real, sid: NO_SUCH_ID }, SECRET())}` },
      'another user on this session': { Authorization: `Bearer ${makeToken({ ...real, sub: customer.userId }, SECRET())}` },
      'the token without "Bearer"': { Authorization: receptionist.token },
      'basic authentication': { Authorization: `Basic ${Buffer.from(`${receptionist.email}:${PASSWORD}`).toString('base64')}` },
      'the token in a cookie': { Cookie: `access_token=${receptionist.token}; token=${receptionist.token}; te_at=${receptionist.token}` },
      'the token in another header': { 'x-access-token': receptionist.token, 'x-auth-token': receptionist.token },
      'a guessed internal token': { 'x-internal-token': 'internal', Authorization: 'Bearer internal' },
    };
    for (const r of sample) {
      const url = urlOf(r, () => NO_SUCH_ID);
      for (const [label, headers] of Object.entries(moreBad)) {
        const res = await call(t, null, r, url, {}, headers);
        expect([routeName(r), label, res.status]).toEqual([routeName(r), label, 401]);
      }
      // ... and the token in the query string is not read either.
      const viaQuery = await call(t, null, r, `${url}?access_token=${receptionist.token}&token=${receptionist.token}`, {});
      expect([routeName(r), 'the token in the query string', viaQuery.status]).toEqual([routeName(r), 'the token in the query string', 401]);
    }
    // The receptionist's real token still works after all that (nothing was locked or revoked by the attempts).
    expect((await me(receptionist.token)).status).toBe(200);
  }, 300_000);

  it('the public routes give a stranger presentation data or ask for a credential of their own', async () => {
    const anon = anonymous(t);
    const garbage = 'x'.repeat(43);
    const refused = async (what: string, res: Promise<any> | any, statuses: number[]) => {
      const answer = await res;
      expect([what, statuses.includes(answer.status) ? 'refused' : `${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`]).toEqual([what, 'refused']);
      return answer;
    };
    // --- routes that exchange a credential: without the credential, nothing
    await refused('sign in with a wrong password', anon.req('POST', '/auth/login', { email: customerEmail, password: 'Wrong-Password-99', app: 'customer', tenantSlug: centre.slug }), [401]);
    await refused('refresh without a token', anon.req('POST', '/auth/refresh', {}), [401, 403]);
    await refused('refresh without a token, as a browser app', anon.with({ 'X-Requested-With': 'typease', 'X-Client-App': 'customer' }).req('POST', '/auth/refresh', {}), [401]);
    await refused('refresh with a made-up token', anon.req('POST', '/auth/refresh', { refreshToken: garbage, app: 'mobile' }), [401]);
    await refused('MFA challenge', anon.req('POST', '/auth/mfa/verify', { challengeToken: garbage, code: '123456' }), [400, 401]);
    await refused('one-time code', anon.req('POST', '/auth/otp/verify', { phone: '+971500000001', code: '123456', app: 'customer', tenantSlug: centre.slug }), [400, 401, 403, 404]);
    await refused('centre selection', anon.req('POST', '/auth/select-tenant', { selectionToken: garbage, membershipId: receptionist.membershipId }), [400, 401]);
    await refused('password reset', anon.req('POST', '/auth/password/reset', { token: garbage, password: 'Another-Horse-43' }), [400, 401, 404]);
    await refused('email verification', anon.req('POST', '/auth/verify-email', { token: garbage }), [400, 401, 404]);
    await refused('invitation', anon.req('POST', '/auth/invitations/accept', { token: garbage, password: PASSWORD }), [400, 401, 404]);
    await refused('invitation preview', anon.req('GET', `/auth/invitations/preview?token=${garbage}`), [400, 401, 404]);
    await refused('support hand-off', anon.with({ 'X-Requested-With': 'typease' }).req('POST', '/auth/support-session/exchange', { code: garbage }), [400]);
    await refused('share link', anon.req('GET', `/public/shared-documents/${garbage}`), [403, 404]);
    await refused('download link', t.http.get(`/api/v1/storage/local/download/${garbage}`), [403]);
    await refused('upload link', t.http.put(`/api/v1/storage/local/upload/${garbage}`).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4')), [403]);
    await refused('asset', anon.req('GET', '/public/assets/no-such-asset.png'), [400, 404]);
    await refused('checkout page', anon.req('GET', '/public/payments/sandbox/checkout/cs_unknown'), [404]);
    await refused('checkout completion', anon.req('POST', '/public/payments/sandbox/checkout/cs_unknown/complete', {}), [404]);
    await refused('unsigned payment webhook', anon.req('POST', '/public/webhooks/payments/sandbox', { type: 'payment.succeeded' }), [400]);
    await refused('unsigned billing webhook', anon.req('POST', '/public/webhooks/subscriptions/sandbox', { type: 'payment.succeeded' }), [400]);
    await refused('tracking without the code', anon.req('POST', '/public/track', { tenantSlug: centre.slug, requestNo: 'TE-000001', trackingCode: 'AAAAA-BBBBB' }), [404]);
    await refused('appointment cancellation', anon.req('POST', '/public/appointments/cancel', { token: garbage }), [400, 401, 403, 404]);
    await refused('queue display', anon.req('GET', `/public/queue/display?token=${garbage}`), [400, 401, 403, 404]);
    await refused('certificate for an unknown host', anon.req('GET', '/internal/tls/ask?domain=unknown.example.com'), [404]);
    // Signing out without a session is not an error, and tells nothing.
    expect((await anon.req('POST', '/auth/logout', {})).body).toEqual(expect.objectContaining({ status: 'SIGNED_OUT' }));

    // --- routes that must not say whether an account exists
    const known = await anon.req('POST', '/auth/password/forgot', { email: customerEmail, app: 'customer', tenantSlug: centre.slug });
    const unknown = await anon.req('POST', '/auth/password/forgot', { email: `nobody-${id}@example.test`, app: 'customer', tenantSlug: centre.slug });
    expect([known.status, unknown.status]).toEqual([200, 200]);
    const withoutDev = (body: any) => JSON.stringify({ ...body, dev: undefined, requestId: undefined });
    expect(withoutDev(unknown.body)).toBe(withoutDev(known.body));
    const resendKnown = await anon.req('POST', '/auth/resend-verification', { email: customerEmail });
    const resendUnknown = await anon.req('POST', '/auth/resend-verification', { email: `nobody-${id}@example.test` });
    expect(withoutDev(resendUnknown.body)).toBe(withoutDev(resendKnown.body));
    const wrongPassword = await anon.req('POST', '/auth/login', { email: receptionist.email, password: 'Wrong-Password-99', app: 'centre' });
    const noSuchUser = await anon.req('POST', '/auth/login', { email: `nobody-${id}@example.test`, password: 'Wrong-Password-99', app: 'centre' });
    expect([wrongPassword.status, wrongPassword.body.code, wrongPassword.body.message]).toEqual([noSuchUser.status, noSuchUser.body.code, noSuchUser.body.message]);

    // --- presentation data: what a visitor of the centre's website may see, and nobody's personal data in it
    // (the owner's address is not in the list: the owner entered it as the centre's public contact address)
    const personal = [customerEmail, customer.customerId!, `Session Holder ${id}`, receptionist.email, receptionist.userId, centre.owner.userId];
    for (const path of [`/public/tenant-config?slug=${centre.slug}`, `/public/services?slug=${centre.slug}`, `/public/services/${centre.firstService.id}?slug=${centre.slug}`, `/public/appointments/options?tenant=${centre.slug}`, '/public/plans', `/public/slug-available?slug=${centre.slug}`, `/internal/tls/ask?domain=${centre.slug}.typease.test`]) {
      const res = await anon.req('GET', path);
      expect([path, res.status]).toEqual([path, 200]);
      const text = textOf(res);
      expect([path, personal.filter((p) => text.includes(p))]).toEqual([path, []]);
    }
    for (const path of ['/health', '/health/ready']) {
      const res = await t.http.get(path);
      expect(res.status).toBe(200);
      expect(textOf(res)).not.toMatch(/postgres(ql)?:\/\/|redis:\/\/|password|secret/i);
    }
    // A valid session does not turn a public route into a window on the centre: same answer with and without it.
    const asStaff = await api(t, receptionist).req('GET', `/public/services?slug=${centre.slug}`);
    expect(asStaff.body).toEqual((await anon.req('GET', `/public/services?slug=${centre.slug}`)).body);
  });

  it('refresh-token reuse revokes the session family', async () => {
    // Another device of the same person: an independent session that must survive what follows.
    const tablet = await mobileSignIn(customerEmail, 'Tablet');
    const phone = await mobileSignIn(customerEmail, 'Phone');
    expect(phone.refresh).toBeTruthy();
    expect((await me(phone.access)).status).toBe(200);

    // --- normal use: every refresh gives a new pair and retires the old one
    const second = await refreshWith(phone.refresh);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).toBeTruthy();
    expect(second.body.refreshToken).not.toBe(phone.refresh);
    expect((await me(second.body.accessToken)).status).toBe(200);
    expect((await me(phone.access)).status).toBe(401); // the access token of the retired session is dead as well
    const third = await refreshWith(second.body.refreshToken);
    expect(third.status).toBe(200);
    expect((await me(third.body.accessToken)).status).toBe(200);

    // --- a thief replays a refresh token that was already used
    const replay = await refreshWith(phone.refresh);
    expect(replay.status).toBe(401);
    expect(replay.body.accessToken).toBeUndefined();
    expect(replay.body.refreshToken).toBeUndefined();
    // The whole family is closed: the newest access token, the newest refresh token, and every older one.
    expect((await me(third.body.accessToken)).status).toBe(401);
    expect((await refreshWith(third.body.refreshToken)).status).toBe(401);
    expect((await refreshWith(second.body.refreshToken)).status).toBe(401);
    expect((await me(second.body.accessToken)).status).toBe(401);
    // Asking again and again changes nothing.
    expect((await refreshWith(phone.refresh)).status).toBe(401);

    // --- the person's other device is not affected, and they can sign in again
    expect((await me(tablet.access)).status).toBe(200);
    const live = await t.http.get('/api/v1/auth/sessions?app=mobile').set('Authorization', `Bearer ${tablet.access}`);
    expect(live.body.map((s: any) => s.deviceName)).toEqual(['Tablet']);
    expect(live.headers['x-total-count']).toBe('1');
    const again = await mobileSignIn(customerEmail, 'Phone');
    expect((await me(again.access)).status).toBe(200);

    // --- it is on record as a high-severity security event for this user
    const admin = await t.createPlatformAdmin('SUPER_ADMIN');
    // (the thief is not signed in, so the event has no acting user; whose sessions were closed is in its details)
    const events = await api(t, admin).get(`/platform/security-events?type=REFRESH_TOKEN_REUSE&centreId=${centre.id}&pageSize=100`);
    const about = events.data.filter((e: any) => e.details?.userId === customer.userId);
    expect(about.length).toBeGreaterThanOrEqual(1);
    expect(about[0]).toMatchObject({ type: 'REFRESH_TOKEN_REUSE', severity: 'HIGH', centre: { id: centre.id } });
    expect(JSON.stringify(about)).not.toContain(phone.refresh);

    // --- the same in a browser: the refresh token is an HttpOnly cookie and needs the anti-CSRF header
    const login = await t.http.post('/api/v1/auth/login').send({ email: receptionist.email, password: PASSWORD, app: 'centre' });
    expect(login.body.refreshToken).toBeUndefined(); // never in the body for a browser app
    const setCookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('te_rt_centre='))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/);
    const cookie = setCookie.split(';')[0];
    const browserRefresh = (c: string, csrf = true) => {
      let r = t.http.post('/api/v1/auth/refresh').set('Cookie', c).set('X-Client-App', 'centre');
      if (csrf) r = r.set('X-Requested-With', 'typease');
      return r.send({});
    };
    const crossSite = await browserRefresh(cookie, false);
    expect([crossSite.status, crossSite.body.code]).toEqual([403, 'CSRF_CHECK_FAILED']);
    const rotated = await browserRefresh(cookie);
    expect(rotated.status).toBe(200);
    const newCookie = ([] as string[]).concat(rotated.headers['set-cookie'] ?? []).find((c) => c.startsWith('te_rt_centre='))!.split(';')[0];
    expect(newCookie).not.toBe(cookie);
    expect((await browserRefresh(cookie)).status).toBe(401); // the old cookie again: reuse
    expect((await browserRefresh(newCookie)).status).toBe(401); // ... which killed the new one too
    expect((await me(rotated.body.accessToken)).status).toBe(401);
    // The receptionist's other session (the one this file uses) is another family and lives on.
    expect((await me(receptionist.token)).status).toBe(200);
  });

  it('signing out ends the session; "everywhere else" ends the others; nobody ends somebody else\'s', async () => {
    const one = await mobileSignIn(customerEmail, 'One');
    const two = await mobileSignIn(customerEmail, 'Two');
    const three = await mobileSignIn(customerEmail, 'Three');
    const list = (token: string, query = '') => t.http.get(`/api/v1/auth/sessions${query}`).set('Authorization', `Bearer ${token}`);

    const mine = await list(one.access, '?app=mobile&limit=100');
    expect(mine.status).toBe(200);
    expect(mine.body.map((s: any) => s.id)).toEqual(expect.arrayContaining([one.sessionId, two.sessionId, three.sessionId]));
    expect(mine.body.find((s: any) => s.current).id).toBe(one.sessionId);
    expect(Number(mine.headers['x-total-count'])).toBe(mine.body.length);
    // No token, hash or secret is in the list.
    expect(JSON.stringify(mine.body)).not.toMatch(/refresh|hash|token/i);
    // A limit is honoured, the total still says how many there are, and the current session is always in the answer.
    const short = await list(one.access, '?app=mobile&limit=1');
    expect(short.body).toHaveLength(1);
    expect(short.body[0]).toMatchObject({ id: one.sessionId, current: true });
    expect(Number(short.headers['x-total-count'])).toBe(mine.body.length);
    expect((await list(one.access, '?limit=0')).status).toBe(400);
    expect((await list(one.access, '?limit=101')).status).toBe(400);

    // Somebody else's session is not there and cannot be ended: the receptionist tries with the customer's session id.
    const theirs = await list(receptionist.token, '?limit=100');
    expect(theirs.body.map((s: any) => s.id)).not.toContain(two.sessionId);
    expect((await t.http.delete(`/api/v1/auth/sessions/${two.sessionId}`).set('Authorization', `Bearer ${receptionist.token}`)).status).toBe(404);
    expect((await me(two.access)).status).toBe(200);

    // Ending one of my own sessions by id.
    expect((await t.http.delete(`/api/v1/auth/sessions/${two.sessionId}`).set('Authorization', `Bearer ${one.access}`)).status).toBe(200);
    expect((await me(two.access)).status).toBe(401);
    expect((await refreshWith(two.refresh)).status).toBe(401);
    // Signing out: the session and its refresh token are dead, the others are not.
    expect((await t.http.post('/api/v1/auth/logout').set('Authorization', `Bearer ${three.access}`).send({ refreshToken: three.refresh, app: 'mobile' })).status).toBe(200);
    expect((await me(three.access)).status).toBe(401);
    expect((await refreshWith(three.refresh)).status).toBe(401);
    expect((await me(one.access)).status).toBe(200);
    // "Sign out everywhere else": every other session of the person, in every app; the one that asked stays.
    const portal = await t.login(customerEmail, PASSWORD, 'customer', centre.slug);
    const four = await mobileSignIn(customerEmail, 'Four');
    const swept = await t.http.post('/api/v1/auth/sessions/revoke-others').set('Authorization', `Bearer ${one.access}`).send({});
    expect(swept.status).toBe(200);
    expect(swept.body.revoked).toBeGreaterThanOrEqual(2);
    expect((await me(portal.token)).status).toBe(401);
    expect((await me(four.access)).status).toBe(401);
    expect((await me(customer.token)).status).toBe(401); // the session the file started with, too
    expect((await me(one.access)).status).toBe(200);
    expect((await t.http.post('/api/v1/auth/sessions/revoke-others').set('Authorization', `Bearer ${one.access}`).send({})).body.revoked).toBe(0);
    expect((await list(one.access, '?limit=100')).body.map((s: any) => s.id)).toEqual([one.sessionId]);
    // Other people were not signed out by it.
    expect((await me(receptionist.token)).status).toBe(200);
  });

  it('at most twenty live sessions per user and app: the oldest are ended, the newest always works', async () => {
    const person = await registerPortalCustomer(t, centre, { fullName: 'Many Devices', email: `many-${id}@example.test` });
    const sessions: Array<Awaited<ReturnType<typeof mobileSignIn>>> = [];
    for (let i = 1; i <= 23; i++) sessions.push(await mobileSignIn(person.email, `Device ${i}`));

    const newest = sessions.at(-1)!;
    const listed = await t.http.get('/api/v1/auth/sessions?app=mobile&limit=100').set('Authorization', `Bearer ${newest.access}`);
    expect(listed.headers['x-total-count']).toBe('20');
    expect(listed.body).toHaveLength(20);
    expect(listed.body[0]).toMatchObject({ id: newest.sessionId, current: true, deviceName: 'Device 23' });
    // The three oldest are over - access token and refresh token - with a reason the app can show.
    for (const old of sessions.slice(0, 3)) {
      const res = await me(old.access);
      expect([res.status, res.body.code]).toEqual([401, 'SESSION_EXPIRED']);
      expect((await refreshWith(old.refresh)).status).toBe(401);
    }
    // The twenty newest all work.
    for (const s of sessions.slice(3)) expect((await me(s.access)).status).toBe(200);
    // The cap is per app: the same person's web session (signed in before all of this) was not counted or ended.
    expect((await me(person.token)).status).toBe(200);
    expect((await t.http.get('/api/v1/auth/sessions?app=customer').set('Authorization', `Bearer ${person.token}`)).headers['x-total-count']).toBe('1');
    // A refresh replaces a session, it does not add one.
    const refreshed = await refreshWith(newest.refresh);
    expect(refreshed.status).toBe(200);
    expect((await t.http.get('/api/v1/auth/sessions?app=mobile&limit=100').set('Authorization', `Bearer ${refreshed.body.accessToken}`)).headers['x-total-count']).toBe('20');
    expect((await me(sessions[3].access)).status).toBe(200);
  }, 120_000);

  it('accounts: lock-out after repeated failures, the password policy, and one-time links', async () => {
    const anon = anonymous(t);
    // --- five wrong passwords lock the account; the right password does not get in during the lock
    const victim = await inviteStaff(t, centre, 'operator');
    for (let i = 0; i < 5; i++) {
      const res = await anon.req('POST', '/auth/login', { email: victim.email, password: `Wrong-Password-${i}`, app: 'centre' });
      expect([res.status, res.body.code]).toEqual([401, 'INVALID_CREDENTIALS']);
    }
    const locked = await anon.req('POST', '/auth/login', { email: victim.email, password: PASSWORD, app: 'centre' });
    expect(locked.status).toBe(429);
    expect(locked.body.accessToken).toBeUndefined();
    // A session that existed before the lock is the person's own and keeps working (the lock is on signing in).
    expect((await me(victim.token)).status).toBe(200);

    // --- the password policy applies wherever a password is set; a refused attempt uses nothing up
    const email = `policy-${id}@example.test`;
    const register = (password: string) => anon.req('POST', '/auth/register', { tenantSlug: centre.slug, fullName: 'Policy Person', email, password, acceptTerms: true });
    for (const weak of ['short1A', 'alllowercase123', 'ALLUPPERCASE123', 'NoDigitsAtAll', 'x'.repeat(129) + 'A1']) {
      const res = await register(weak);
      expect([weak.slice(0, 16), res.status, res.body.code]).toEqual([weak.slice(0, 16), 400, 'VALIDATION_FAILED']);
    }
    const ok = await register(PASSWORD);
    expect(ok.status).toBe(201);
    // Not verified yet: no sign-in.
    const early = await anon.req('POST', '/auth/login', { email, password: PASSWORD, app: 'customer', tenantSlug: centre.slug });
    expect(early.body.accessToken).toBeUndefined();
    expect([401, 403]).toContain(early.status);
    // The verification link works once.
    await anon.post('/auth/verify-email', { token: ok.body.dev.emailVerificationToken }, 200);
    expect((await anon.req('POST', '/auth/verify-email', { token: ok.body.dev.emailVerificationToken })).status).toBeGreaterThanOrEqual(400);
    const signedIn = await t.login(email, PASSWORD, 'customer', centre.slug);

    // --- a reset link: weak password refused (link still valid), then used once; old sessions end, the old password is dead
    const forgot = await anon.post('/auth/password/forgot', { email, app: 'customer', tenantSlug: centre.slug }, 200);
    const resetToken = forgot.dev?.resetToken ?? forgot.dev?.passwordResetToken;
    expect(resetToken).toBeTruthy();
    expect((await anon.req('POST', '/auth/password/reset', { token: resetToken, password: 'weak' })).status).toBe(400);
    await anon.post('/auth/password/reset', { token: resetToken, password: 'Another-Horse-43' }, 200);
    expect((await anon.req('POST', '/auth/password/reset', { token: resetToken, password: 'Third-Horse-4444' })).status).toBeGreaterThanOrEqual(400);
    expect((await me(signedIn.token)).status).toBe(401);
    expect((await anon.req('POST', '/auth/login', { email, password: PASSWORD, app: 'customer', tenantSlug: centre.slug })).status).toBe(401);
    const fresh = await t.login(email, 'Another-Horse-43', 'customer', centre.slug);
    // Changing the password needs the current one, and ends the other sessions.
    const other = await t.login(email, 'Another-Horse-43', 'customer', centre.slug);
    expect((await api(t, fresh).req('POST', '/auth/password/change', { currentPassword: 'not-the-password', newPassword: 'Fourth-Horse-4545' })).status).toBeGreaterThanOrEqual(400);
    expect((await api(t, fresh).req('POST', '/auth/password/change', { currentPassword: 'Another-Horse-43', newPassword: 'weak' })).status).toBe(400);
    await api(t, fresh).post('/auth/password/change', { currentPassword: 'Another-Horse-43', newPassword: 'Fourth-Horse-4545' }, [200, 201]);
    expect((await me(other.token)).status).toBe(401);
    expect((await me(fresh.token)).status).toBe(200);
  }, 120_000);
});
