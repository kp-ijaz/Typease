import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@typease/types';
import { createSessionManager } from './session';
import { apiError, channelHub, json, lockManager, mockFetch, type RecordedCall } from './test-helpers';

const session = (name = 'Noor'): SessionInfo => ({
  user: { id: 'u1', email: 'noor@example.ae', phone: null, fullName: name, preferredLanguage: 'en', platformRole: null, mfaEnabled: false, emailVerified: true, phoneVerified: false },
  tenant: { id: 't1', slug: 'alnoor', name: 'Al Noor', status: 'ACTIVE', timezone: 'Asia/Dubai', currency: 'AED' },
  membership: { id: 'm1', kind: 'STAFF', roleKey: 'receptionist', roleName: 'Receptionist', allBranches: true, branchIds: [], customerId: null, corporateAccountId: null },
  permissions: ['customer.read', 'customer.create'],
  supportGrant: null,
  mfaRequiredSetup: false,
});
const ok = (token: string) => json(200, { status: 'OK', accessToken: token, expiresIn: 900, session: session(), landing: '/dashboard' });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the API's rotating refresh token: each call must present the
 * current "cookie generation"; a second call that started with the same
 * generation is a reuse and kills the session, exactly like the real API.
 */
function rotatingServer() {
  let generation = 1;
  let revoked = false;
  let refreshes = 0;
  const handler = async (call: RecordedCall) => {
    if (call.url.endsWith('/auth/refresh')) {
      const presented = generation;
      await tick(15);
      if (revoked || presented !== generation) {
        revoked = true;
        return apiError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
      }
      generation++;
      refreshes++;
      return ok(`access-${generation}`);
    }
    if (call.url.endsWith('/auth/logout')) return json(200, { status: 'SIGNED_OUT' });
    if (call.url.endsWith('/auth/me')) return json(200, session('Noor Al Mansoori'));
    return call.headers.authorization === `Bearer access-${generation}` ? json(200, { ok: true }) : apiError(401, 'TOKEN_INVALID');
  };
  return { handler, stats: () => ({ refreshes, revoked }), expireAccessToken: () => generation };
}

const base = { baseUrl: 'http://api.test', app: 'centre' as const, refreshAheadMs: 0 };

describe('session manager', () => {
  it('signs in silently on load with the refresh cookie and the CSRF header', async () => {
    const m = mockFetch(() => ok('access-1'));
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    expect(s.getState().status).toBe('loading');
    const info = await s.bootstrap();
    expect(info?.user.fullName).toBe('Noor');
    expect(s.getState().status).toBe('authenticated');
    expect(s.getAccessToken()).toBe('access-1');
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].url).toBe('http://api.test/api/v1/auth/refresh');
    expect(m.calls[0].headers).toMatchObject({ 'x-requested-with': 'typease', 'x-client-app': 'centre' });
    expect(m.calls[0].headers.authorization).toBeUndefined();
    expect(m.calls[0].credentials).toBe('include');
    expect(m.calls[0].body).toEqual({ app: 'centre' });
    expect(s.hasPermission('customer.create')).toBe(true);
    expect(s.hasPermission('refund.approve')).toBe(false);
    expect(s.hasAnyPermission(['refund.approve', 'customer.read'])).toBe(true);
    expect(s.hasAnyPermission([])).toBe(true);
  });
  it('is anonymous when there is no cookie', async () => {
    const m = mockFetch(() => apiError(401, 'SESSION_EXPIRED'));
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    expect(await s.bootstrap()).toBeNull();
    expect(s.getState()).toMatchObject({ status: 'anonymous', endedReason: null });
    await s.bootstrap();
    expect(m.calls).toHaveLength(1);
  });
  it('stays usable when the API is unreachable during load', async () => {
    const s = createSessionManager({ ...base, fetch: (() => Promise.reject(new TypeError('offline'))) as typeof fetch, channel: null, locks: null });
    expect(await s.bootstrap()).toBeNull();
    expect(s.getState().status).toBe('anonymous');
  });
  it('shares one refresh between concurrent requests of a tab (single flight)', async () => {
    const server = rotatingServer();
    const m = mockFetch(server.handler);
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    await s.bootstrap();
    // Five callers at once: only one request may reach the API.
    const before = server.stats().refreshes;
    const tokens = await Promise.all([s.refresh(), s.refresh(), s.refresh(), s.refresh(), s.refresh()]);
    expect(new Set(tokens).size).toBe(1);
    expect(server.stats().refreshes).toBe(before + 1);
    expect(server.stats().revoked).toBe(false);
  });
  it('refreshes after a 401 and repeats the request', async () => {
    let current = 'access-1';
    const m = mockFetch((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        current = current === 'access-1' && m.calls.filter((c) => c.url.endsWith('/auth/refresh')).length === 1 ? 'access-1' : 'access-2';
        return ok(current);
      }
      return call.headers.authorization === 'Bearer access-2' ? json(200, { data: [1] }) : apiError(401, 'TOKEN_INVALID');
    });
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    await s.bootstrap();
    expect(s.getAccessToken()).toBe('access-1');
    const [a, b] = await Promise.all([s.client.get('/requests'), s.client.get('/customers')]);
    expect(a).toEqual({ data: [1] });
    expect(b).toEqual({ data: [1] });
    expect(m.calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(2);
    expect(s.getAccessToken()).toBe('access-2');
  });
  it('marks the session as expired when the refresh is refused', async () => {
    let alive = true;
    const m = mockFetch((call) => {
      if (call.url.endsWith('/auth/refresh')) return alive ? ok('access-1') : apiError(401, 'SESSION_EXPIRED');
      return apiError(401, 'TOKEN_INVALID');
    });
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    const seen: string[] = [];
    s.subscribe((st) => seen.push(st.status));
    await s.bootstrap();
    alive = false;
    await expect(s.client.get('/requests')).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    expect(s.getState()).toMatchObject({ status: 'expired', endedReason: 'SESSION_EXPIRED', session: null });
    expect(s.getAccessToken()).toBeNull();
    expect(seen).toEqual(['authenticated', 'expired']);
  });
  it('ends the session without a refresh attempt for non-refreshable 401 codes', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/auth/refresh') ? ok('access-1') : apiError(401, 'MEMBERSHIP_INACTIVE', 'Your access to this centre is no longer active.')));
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    await s.bootstrap();
    await expect(s.client.get('/requests')).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
    expect(s.getState()).toMatchObject({ status: 'expired', endedReason: 'MEMBERSHIP_INACTIVE' });
    expect(m.calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });
  it('keeps the session when a 401 only asks for the second step', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/auth/refresh') ? ok('access-1') : apiError(401, 'MFA_REQUIRED')));
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    await s.bootstrap();
    await expect(s.client.get('/requests')).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect(s.getState().status).toBe('authenticated');
  });
  it('stores a login and signs out', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/auth/logout') ? json(200, { status: 'SIGNED_OUT' }) : apiError(401, 'SESSION_EXPIRED')));
    const s = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    await s.bootstrap();
    s.acceptLogin({ status: 'OK', accessToken: 'fresh', expiresIn: 900, session: session(), landing: '/dashboard' });
    expect(s.getState().status).toBe('authenticated');
    expect(s.getAccessToken()).toBe('fresh');
    await s.signOut();
    // A deliberate sign-out is "anonymous", not "expired": no "your session has ended" message.
    expect(s.getState()).toMatchObject({ status: 'anonymous', endedReason: null });
    const logout = m.calls.find((c) => c.url.endsWith('/auth/logout'))!;
    expect(logout.body).toEqual({ app: 'centre' });
    expect(logout.credentials).toBe('include');
  });
});

describe('two tabs', () => {
  it('never race the rotating refresh token: one refreshes, the other receives the token', async () => {
    const server = rotatingServer();
    const hub = channelHub();
    const locks = lockManager();
    const m = mockFetch(server.handler);
    const a = createSessionManager({ ...base, fetch: m.fetch, channel: hub.create(), locks });
    const b = createSessionManager({ ...base, fetch: m.fetch, channel: hub.create(), locks });
    // Both tabs are opened at the same moment (restored browser session).
    const [sa, sb] = await Promise.all([a.bootstrap(), b.bootstrap()]);
    expect(sa).not.toBeNull();
    expect(sb).not.toBeNull();
    expect(server.stats()).toEqual({ refreshes: 1, revoked: false });
    expect(a.getAccessToken()).toBe(b.getAccessToken());
    // Later both tabs notice the expired access token at once.
    const [ta, tb] = await Promise.all([a.refresh(), b.refresh()]);
    expect(ta).toBe(tb);
    expect(server.stats()).toEqual({ refreshes: 2, revoked: false });
    expect(a.getState().status).toBe('authenticated');
    expect(b.getState().status).toBe('authenticated');
  });
  it('would kill the session without the lock (the scenario the lock exists for)', async () => {
    const server = rotatingServer();
    const m = mockFetch(server.handler);
    const a = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    const b = createSessionManager({ ...base, fetch: m.fetch, channel: null, locks: null });
    await Promise.all([a.bootstrap(), b.bootstrap()]);
    expect(server.stats().revoked).toBe(true);
  });
  it('falls back to the broadcast announcement when Web Locks are missing', async () => {
    const server = rotatingServer();
    const hub = channelHub();
    const m = mockFetch(server.handler);
    const a = createSessionManager({ ...base, fetch: m.fetch, channel: hub.create(), locks: null });
    const b = createSessionManager({ ...base, fetch: m.fetch, channel: hub.create(), locks: null });
    await a.bootstrap();
    // Tab A starts a refresh; tab B needs one a moment later and waits for A's result.
    const pa = a.refresh();
    await tick(1);
    const pb = b.refresh();
    const [ta, tb] = await Promise.all([pa, pb]);
    expect(ta).toBe(tb);
    expect(server.stats()).toEqual({ refreshes: 2, revoked: false });
  });
  it('shares a sign-in and a sign-out with the other tab', async () => {
    const hub = channelHub();
    const m = mockFetch((call) => (call.url.endsWith('/auth/logout') ? json(200, {}) : apiError(401, 'SESSION_EXPIRED')));
    const a = createSessionManager({ ...base, fetch: m.fetch, channel: hub.create(), locks: lockManager() });
    const b = createSessionManager({ ...base, fetch: m.fetch, channel: hub.create(), locks: lockManager() });
    await Promise.all([a.bootstrap(), b.bootstrap()]);
    a.acceptLogin({ status: 'OK', accessToken: 'fresh', expiresIn: 900, session: session(), landing: '/dashboard' });
    expect(b.getState().status).toBe('authenticated');
    expect(b.getAccessToken()).toBe('fresh');
    await a.signOut();
    expect(a.getState().status).toBe('anonymous');
    expect(b.getState()).toMatchObject({ status: 'expired', endedReason: 'SIGNED_OUT_ELSEWHERE' });
    expect(b.getAccessToken()).toBeNull();
  });
});
