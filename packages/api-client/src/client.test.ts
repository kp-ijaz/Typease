import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiError } from './errors';
import { uploadDocument } from './documents';
import { createApi } from './endpoints';
import { apiError, json, mockFetch } from './test-helpers';

const base = { baseUrl: 'http://api.test', app: 'centre' as const, tenantHost: 'portal.example.ae', locale: () => 'ar' };

describe('createApiClient', () => {
  it('builds URLs under /api/v1 and sends the standard headers', async () => {
    const m = mockFetch(() => json(200, { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }));
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok-1' });
    await client.get('/requests', { query: { page: 1, status: ['SUBMITTED', 'UNDER_REVIEW'], q: '' } });
    const call = m.calls[0];
    expect(call.url).toBe('http://api.test/api/v1/requests?page=1&status=SUBMITTED%2CUNDER_REVIEW');
    expect(call.method).toBe('GET');
    expect(call.headers).toMatchObject({
      authorization: 'Bearer tok-1',
      'x-client-app': 'centre',
      'x-requested-with': 'typease',
      'x-tenant-host': 'portal.example.ae',
      'accept-language': 'ar',
    });
    expect(call.credentials).toBe('include');
  });
  it('accepts a base URL that already has the prefix, and "" for a same-origin proxy', () => {
    expect(createApiClient({ ...base, baseUrl: 'http://api.test/api/v1/' }).url('/x')).toBe('http://api.test/api/v1/x');
    expect(createApiClient({ ...base, baseUrl: '' }).url('auth/me')).toBe('/api/v1/auth/me');
  });
  it('sends JSON bodies and the idempotency key', async () => {
    const m = mockFetch(() => json(201, { id: 'p1' }));
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok' });
    await client.post('/payments', { amount: '150.00' }, { idempotencyKey: 'key-1' });
    expect(m.calls[0].headers['content-type']).toBe('application/json');
    expect(m.calls[0].headers['idempotency-key']).toBe('key-1');
    expect(m.calls[0].body).toEqual({ amount: '150.00' });
  });
  it('omits the token on public calls', async () => {
    const m = mockFetch(() => json(200, []));
    const api = createApi(createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok' }));
    await api.public.plans();
    expect(m.calls[0].headers.authorization).toBeUndefined();
    expect(m.calls[0].url).toBe('http://api.test/api/v1/public/plans');
  });
  it('fills in the app on login', async () => {
    const m = mockFetch(() => json(200, { status: 'MFA_REQUIRED', challengeToken: 'c'.repeat(12) }));
    const api = createApi(createApiClient({ ...base, app: 'platform', fetch: m.fetch }));
    const r = await api.auth.login({ email: 'a@b.ae', password: 'x' });
    expect(r.status).toBe('MFA_REQUIRED');
    expect(m.calls[0].body).toEqual({ email: 'a@b.ae', password: 'x', app: 'platform' });
  });
  it('returns undefined for 204 and empty bodies', async () => {
    const m = mockFetch((_c, i) => (i === 0 ? new Response(null, { status: 204 }) : new Response('', { status: 200 })));
    const client = createApiClient({ ...base, fetch: m.fetch });
    expect(await client.delete('/x')).toBeUndefined();
    expect(await client.post('/y')).toBeUndefined();
  });
  it('throws ApiError with code, details and request id', async () => {
    const m = mockFetch(() => apiError(402, 'PLAN_LIMIT_REACHED', 'Upgrade to add more branches.', { limit: 'branches' }));
    const client = createApiClient({ ...base, fetch: m.fetch });
    await expect(client.post('/branches', {})).rejects.toMatchObject({ name: 'ApiError', status: 402, code: 'PLAN_LIMIT_REACHED', details: { limit: 'branches' }, requestId: 'req-12345678' });
  });
  it('turns transport failures into NETWORK_ERROR and timeouts into TIMEOUT', async () => {
    const offline = createApiClient({ ...base, fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    await expect(offline.get('/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    const slow = createApiClient({
      ...base,
      timeoutMs: 20,
      fetch: ((_u: unknown, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch,
    });
    await expect(slow.get('/x')).rejects.toMatchObject({ status: 0, code: 'TIMEOUT' });
  });
  it('reports a caller abort as ABORTED', async () => {
    const controller = new AbortController();
    const client = createApiClient({
      ...base,
      fetch: ((_u: unknown, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch,
    });
    const p = client.get('/x', { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('401 -> refresh -> retry once', () => {
  it('repeats the request with the new token', async () => {
    let token = 'old';
    const m = mockFetch((call) => (call.headers.authorization === 'Bearer new' ? json(200, { ok: true }) : apiError(401, 'TOKEN_INVALID')));
    const onUnauthorized = vi.fn(async () => {
      token = 'new';
      return token;
    });
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => token, onUnauthorized });
    await expect(client.post('/customers', { fullName: 'Aisha Khan' })).resolves.toEqual({ ok: true });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].headers.authorization).toBe('Bearer new');
    expect(m.calls[1].body).toEqual({ fullName: 'Aisha Khan' });
  });
  it('gives up with the original error when no new token is available', async () => {
    const m = mockFetch(() => apiError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.'));
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'old', onUnauthorized: async () => null });
    await expect(client.get('/requests')).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    expect(m.calls).toHaveLength(1);
  });
  it('retries only once', async () => {
    const m = mockFetch(() => apiError(401, 'TOKEN_INVALID'));
    const onUnauthorized = vi.fn(async () => 'still-bad');
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'old', onUnauthorized });
    await expect(client.get('/requests')).rejects.toBeInstanceOf(ApiError);
    expect(m.calls).toHaveLength(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it('does not refresh for public calls or when signed out', async () => {
    const m = mockFetch(() => apiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.'));
    const onUnauthorized = vi.fn(async () => 'x');
    const signedIn = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok', onUnauthorized });
    await expect(signedIn.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const signedOut = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => null, onUnauthorized });
    await expect(signedOut.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('files', () => {
  it('downloads a blob with the suggested file name', async () => {
    const m = mockFetch(() => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="INV-000045.pdf"' } }));
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok' });
    const file = await client.download('/invoices/1/pdf');
    expect(file.filename).toBe('INV-000045.pdf');
    expect(file.contentType).toBe('application/pdf');
    expect(await file.blob.text()).toBe('%PDF-1.7');
    expect(m.calls[0].headers.authorization).toBe('Bearer tok');
  });
  it('uploads a document in three steps: intent, PUT to the signed URL, complete', async () => {
    const m = mockFetch((call) => {
      if (call.url.endsWith('/documents/upload-intents'))
        return json(201, { documentId: 'doc-1', versionId: 'ver-1', upload: { url: 'http://files.test/put/abc', method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, expiresAt: 'x' } });
      if (call.url === 'http://files.test/put/abc') return new Response(JSON.stringify({ status: 'UPLOADED' }), { status: 200 });
      return json(200, { documentId: 'doc-1', versionId: 'ver-1', versionNo: 1, status: 'PENDING_SCAN', isCurrentVersion: true, filename: 'Passport.pdf', mime: 'application/pdf', sizeBytes: 8, scanStatus: 'PENDING' });
    });
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok' });
    const progress: number[] = [];
    const file = new File(['%PDF-1.7'], 'Passport.pdf', { type: 'application/pdf' });
    const summary = await uploadDocument(client, { file, customerId: 'cus-1', documentTypeKey: 'passport', onProgress: (f) => progress.push(f) }, { fetch: m.fetch });
    expect(summary.status).toBe('PENDING_SCAN');
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://api.test/api/v1/documents/upload-intents',
      'PUT http://files.test/put/abc',
      'POST http://api.test/api/v1/documents/doc-1/versions/ver-1/complete',
    ]);
    expect(m.calls[0].body).toEqual({ customerId: 'cus-1', documentTypeKey: 'passport', filename: 'Passport.pdf', mime: 'application/pdf', sizeBytes: 8 });
    // The signed URL gets exactly the headers of the intent: no token, no cookies.
    expect(m.calls[1].headers).toEqual({ 'content-type': 'application/pdf' });
    expect(m.calls[1].credentials).toBeUndefined();
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });
  it('stops after a rejected upload and reports the API code', async () => {
    const m = mockFetch((call) =>
      call.url.endsWith('/documents/upload-intents') ? apiError(422, 'FILE_TYPE_NOT_ALLOWED', 'This file type is not accepted.') : json(200, {}),
    );
    const client = createApiClient({ ...base, fetch: m.fetch, getAccessToken: () => 'tok' });
    await expect(uploadDocument(client, { file: new File(['x'], 'a.exe'), documentTypeKey: 'other' }, { fetch: m.fetch })).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    expect(m.calls).toHaveLength(1);
  });
});
