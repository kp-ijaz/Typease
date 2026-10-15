import { describe, expect, it } from 'vitest';
import { ApiError, errorFromResponse, fieldErrorsOf, isApiError, networkError } from './errors';
import { filenameFromContentDisposition } from './download';
import { newIdempotencyKey } from './idempotency';
import { apiError } from './test-helpers';

describe('errorFromResponse', () => {
  it('maps the API error body', async () => {
    const e = await errorFromResponse(apiError(409, 'POSSIBLE_DUPLICATE', 'A customer with the same phone already exists.', { candidates: [{ id: 1 }] }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe('POSSIBLE_DUPLICATE');
    expect(e.message).toBe('A customer with the same phone already exists.');
    expect(e.details).toEqual({ candidates: [{ id: 1 }] });
    expect(e.requestId).toBe('req-12345678');
    expect(isApiError(e)).toBe(true);
    expect(e.isRetryable).toBe(false);
  });
  it('falls back to a stable code when the body is not the API shape', async () => {
    const html = await errorFromResponse(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'edge-1' } }));
    expect(html.code).toBe('SERVER_ERROR');
    expect(html.requestId).toBe('edge-1');
    expect(html.isRetryable).toBe(true);
    const empty = await errorFromResponse(new Response(null, { status: 403 }));
    expect(empty.code).toBe('FORBIDDEN');
    expect(empty.message).toMatch(/permission/);
    const odd = await errorFromResponse(new Response(JSON.stringify({ error: 'nope' }), { status: 418 }));
    expect(odd.code).toBe('HTTP_ERROR');
  });
  it('describes network failures and aborts', () => {
    const offline = networkError(new TypeError('Failed to fetch'));
    expect(offline.status).toBe(0);
    expect(offline.isNetworkError).toBe(true);
    expect(offline.isRetryable).toBe(true);
    const aborted = networkError(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(aborted.isAborted).toBe(true);
    expect(aborted.isRetryable).toBe(false);
  });
});

describe('fieldErrorsOf', () => {
  it('reads VALIDATION_FAILED details', async () => {
    const e = await errorFromResponse(
      apiError(400, 'VALIDATION_FAILED', 'Please check the highlighted fields.', [
        { path: 'phone', message: 'Use international format, e.g. +971501234567' },
        { path: 'address.city', message: 'Too long' },
        { path: 'phone', message: 'second message for the same field is ignored' },
        { path: '', message: 'Give at least one detail to compare' },
      ]),
    );
    expect(fieldErrorsOf(e)).toEqual({ phone: 'Use international format, e.g. +971501234567', 'address.city': 'Too long', '': 'Give at least one detail to compare' });
  });
  it('reads FORM_INVALID details of dynamic service forms', async () => {
    const e = await errorFromResponse(apiError(422, 'FORM_INVALID', 'Please complete the form.', [{ field: 'purpose', code: 'required', message: 'This field is required' }]));
    expect(fieldErrorsOf(e)).toEqual({ purpose: 'This field is required' });
  });
  it('returns nothing for other errors', async () => {
    expect(fieldErrorsOf(await errorFromResponse(apiError(409, 'SLUG_TAKEN', 'Taken', { limit: 'x' })))).toEqual({});
    expect(fieldErrorsOf(new Error('boom'))).toEqual({});
  });
});

describe('small helpers', () => {
  it('reads file names from Content-Disposition', () => {
    expect(filenameFromContentDisposition('attachment; filename="INV-000045.pdf"')).toBe('INV-000045.pdf');
    expect(filenameFromContentDisposition("attachment; filename=\"x.pdf\"; filename*=UTF-8''%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9.pdf")).toBe('فاتورة.pdf');
    expect(filenameFromContentDisposition('inline; filename=receipt.pdf')).toBe('receipt.pdf');
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"')).toBe('.._.._etc_passwd');
    expect(filenameFromContentDisposition(null)).toBeNull();
  });
  it('creates distinct RFC 4122 v4 idempotency keys', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});
