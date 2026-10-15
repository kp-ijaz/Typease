import { describe, expect, it } from 'vitest';
import type { SessionInfo, SupportGrant } from '@typease/types';
import { createApiClient } from './client';
import { createApi } from './endpoints';
import { isApiError } from './errors';
import { createSessionManager } from './session';
import { apiError, json, mockFetch } from './test-helpers';

const grant: SupportGrant = {
  id: 'g1',
  scopes: ['customer.read', 'invoice.read'],
  writeScopes: [],
  readOnly: true,
  startsAt: '2026-10-09T09:00:00.000Z',
  expiresAt: '2026-10-09T09:30:00.000Z',
  tenantId: 't1',
  tenantName: 'Alpha Typing',
  reason: 'Customer reports a missing invoice PDF',
};
const supportSession: SessionInfo = {
  user: { id: 'u9', email: 'sara@typease.example', phone: null, fullName: 'Sara Support', preferredLanguage: 'en', platformRole: 'SUPPORT_AGENT', mfaEnabled: true, emailVerified: true, phoneVerified: false },
  tenant: { id: 't1', slug: 'alpha', name: 'Alpha Typing', status: 'ACTIVE', timezone: 'Asia/Dubai', currency: 'AED' },
  membership: null,
  permissions: ['customer.read', 'invoice.read'],
  supportGrant: grant,
  mfaRequiredSetup: false,
};
const staffSession: SessionInfo = { ...supportSession, user: { ...supportSession.user, platformRole: null }, supportGrant: null };
const login = (session: SessionInfo, token = 'access-1') => ({ status: 'OK' as const, accessToken: token, expiresIn: 900, session, landing: '/' });
const base = { baseUrl: 'http://api.test', app: 'centre' as const, refreshAheadMs: 0, channel: null, locks: null };

describe('support session hand-off', () => {
  it('exchanges the one-time code and installs the session like a sign-in', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/auth/support-session/exchange') ? json(200, login(supportSession)) : json(200, { ok: true })));
    const manager = createSessionManager({ ...base, fetch: m.fetch });
    const api = createApi(manager.client, { session: manager });

    const result = await api.auth.exchangeSupportSession('kq3X-one-time-code-of-43-characters-or-more');

    // the request: public, with the CSRF header, the app and the cookie jar
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ url: 'http://api.test/api/v1/auth/support-session/exchange', method: 'POST', credentials: 'include' });
    expect(m.calls[0].body).toEqual({ code: 'kq3X-one-time-code-of-43-characters-or-more' });
    expect(m.calls[0].headers).toMatchObject({ 'x-requested-with': 'typease', 'x-client-app': 'centre' });
    expect(m.calls[0].headers.authorization).toBeUndefined();

    // the session: exactly what a sign-in leaves behind
    expect(result.session.supportGrant?.id).toBe('g1');
    expect(manager.getState()).toMatchObject({ status: 'authenticated', endedReason: null });
    expect(manager.getState().session?.supportGrant).toEqual(grant);
    expect(manager.getAccessToken()).toBe('access-1');
    expect(manager.hasPermission('invoice.read')).toBe(true);
    expect(manager.hasPermission('invoice.create')).toBe(false);
    // ... and later calls carry the token; no silent refresh is needed any more
    await manager.bootstrap();
    await manager.client.get('/customers');
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].headers.authorization).toBe('Bearer access-1');
  });

  it('leaves the app signed out when the code is refused', async () => {
    const m = mockFetch(() => apiError(400, 'HANDOFF_INVALID', 'This link has already been used or has expired.'));
    const manager = createSessionManager({ ...base, fetch: m.fetch });
    const api = createApi(manager.client, { session: manager });
    const error = await api.auth.exchangeSupportSession('used-or-expired-code-0000000000').catch((e) => e);
    expect(isApiError(error) && error.code).toBe('HANDOFF_INVALID');
    expect(manager.getAccessToken()).toBeNull();
    expect(manager.getState().session).toBeNull();
  });

  it('works on a bare client too: the caller gets the result and installs it', async () => {
    const m = mockFetch(() => json(200, login(supportSession)));
    const api = createApi(createApiClient({ baseUrl: 'http://api.test', app: 'centre', fetch: m.fetch }));
    const result = await api.auth.exchangeSupportSession('kq3X-one-time-code-of-43-characters-or-more');
    expect(result.accessToken).toBe('access-1');
    expect(m.calls[0].headers.authorization).toBeUndefined();
  });

  it.each([
    [401, 'SUPPORT_ACCESS_ENDED'],
    [403, 'SUPPORT_ACCESS_ENDED'],
    [401, 'SESSION_EXPIRED'],
  ])('ends the session on %i %s and remembers that it was a support session', async (status, code) => {
    let over = false;
    const m = mockFetch((call) => {
      if (call.url.endsWith('/auth/support-session/exchange')) return json(200, login(supportSession));
      return over ? apiError(status, code, 'Support access has ended.') : json(200, { ok: true });
    });
    const manager = createSessionManager({ ...base, fetch: m.fetch });
    await manager.exchangeSupportSession('kq3X-one-time-code-of-43-characters-or-more');
    await manager.client.get('/customers');
    over = true;
    const error = await manager.client.get('/customers').catch((e) => e);
    expect(isApiError(error) && error.code).toBe(code);
    // no refresh attempt: these codes mean the session itself is gone
    expect(m.calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(false);
    expect(manager.getState()).toMatchObject({ status: 'expired', session: null, endedReason: code });
    expect(manager.getState().endedSupportGrant).toEqual(grant);
    expect(manager.getAccessToken()).toBeNull();
  });

  it('remembers it after "End session" too, and forgets it at the next sign-in', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/auth/logout') ? json(200, { status: 'SIGNED_OUT' }) : json(200, login(supportSession))));
    const manager = createSessionManager({ ...base, fetch: m.fetch });
    await manager.exchangeSupportSession('kq3X-one-time-code-of-43-characters-or-more');
    await manager.signOut();
    expect(manager.getState()).toMatchObject({ status: 'anonymous', session: null, endedReason: null });
    expect(manager.getState().endedSupportGrant?.tenantName).toBe('Alpha Typing');
    manager.acceptLogin(login(staffSession, 'access-2'));
    expect(manager.getState().endedSupportGrant ?? null).toBeNull();
  });

  it('does not treat an ordinary 403 as the end of anything', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/customers') ? apiError(403, 'SUPPORT_ACCESS_SCOPE', 'This is outside the approved access.') : json(200, login(supportSession))));
    const manager = createSessionManager({ ...base, fetch: m.fetch });
    await manager.exchangeSupportSession('kq3X-one-time-code-of-43-characters-or-more');
    await manager.client.get('/customers').catch(() => undefined);
    expect(manager.getState().status).toBe('authenticated');
    expect(manager.getState().session?.supportGrant?.id).toBe('g1');
  });

  it('an ordinary session that ends leaves no support grant behind', async () => {
    const m = mockFetch((call) => (call.url.endsWith('/customers') ? apiError(401, 'SESSION_EXPIRED') : json(200, login(staffSession))));
    const manager = createSessionManager({ ...base, fetch: m.fetch });
    await manager.bootstrap();
    await manager.client.get('/customers').catch(() => undefined);
    expect(manager.getState()).toMatchObject({ status: 'expired', endedReason: 'SESSION_EXPIRED' });
    expect(manager.getState().endedSupportGrant ?? null).toBeNull();
  });
});

describe('sessions list', () => {
  const row = (id: string, current = false) => ({ id, app: 'centre', tenantId: 't1', deviceName: null, userAgent: 'x', ip: null, createdAt: '2026-10-09T08:00:00.000Z', lastUsedAt: '2026-10-09T09:00:00.000Z', expiresAt: '2026-11-09T09:00:00.000Z', current });

  it('asks for a limited list and reads the total from X-Total-Count', async () => {
    const m = mockFetch(() => json(200, [row('a', true), row('b')], { 'X-Total-Count': '37' }));
    const api = createApi(createApiClient({ baseUrl: 'http://api.test', app: 'centre', fetch: m.fetch, getAccessToken: () => 'tok' }));
    const page = await api.auth.sessionsPage({ limit: 11 });
    expect(m.calls[0].url).toBe('http://api.test/api/v1/auth/sessions?limit=11');
    expect(page.total).toBe(37);
    expect(page.sessions.map((s) => s.id)).toEqual(['a', 'b']);
    // the plain call still returns the array, with or without a limit
    await api.auth.sessions();
    expect(m.calls[1].url).toBe('http://api.test/api/v1/auth/sessions');
    expect(await api.auth.sessions({ limit: 31, app: 'centre' })).toHaveLength(2);
    expect(m.calls[2].url).toBe('http://api.test/api/v1/auth/sessions?app=centre&limit=31'); // query keys are sent in alphabetical order
  });

  it('falls back to the number of rows when the header is missing or unreadable', async () => {
    const without = mockFetch(() => json(200, [row('a', true), row('b'), row('c')]));
    expect((await createApi(createApiClient({ baseUrl: 'http://api.test', app: 'centre', fetch: without.fetch })).auth.sessionsPage()).total).toBe(3);
    const broken = mockFetch(() => json(200, [row('a', true)], { 'X-Total-Count': 'many' }));
    expect((await createApi(createApiClient({ baseUrl: 'http://api.test', app: 'centre', fetch: broken.fetch })).auth.sessionsPage()).total).toBe(1);
  });

  it('requestWithHeaders hands back data, headers and status, and still throws ApiError', async () => {
    const m = mockFetch((_call, index) => (index === 0 ? json(200, { ok: true }, { 'X-Total-Count': '5' }) : apiError(403, 'FORBIDDEN', 'No.')));
    const client = createApiClient({ baseUrl: 'http://api.test', app: 'centre', fetch: m.fetch });
    const answer = await client.requestWithHeaders<{ ok: boolean }>('GET', '/anything');
    expect(answer).toMatchObject({ data: { ok: true }, status: 200 });
    expect(answer.headers.get('x-total-count')).toBe('5');
    const error = await client.requestWithHeaders('GET', '/anything').catch((e) => e);
    expect(isApiError(error) && error.code).toBe('FORBIDDEN');
  });
});
