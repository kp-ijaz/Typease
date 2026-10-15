import type { AppKey } from '@typease/types';
import { ApiError, errorFromResponse, networkError } from './errors';
import { filenameFromContentDisposition, type DownloadedFile } from './download';
import { buildQuery } from './query';

type Lazy<T> = T | (() => T);
const read = <T>(v: Lazy<T> | undefined): T | undefined => (typeof v === 'function' ? (v as () => T)() : v);

export interface ApiClientOptions {
  /** API origin, e.g. "http://localhost:4000" (the "/api/v1" prefix is added), or "" for a same-origin proxy. */
  baseUrl: string;
  /** Which application is calling: decides the refresh cookie and the kind of session. */
  app: AppKey;
  /** The in-memory access token, or nothing when signed out. */
  getAccessToken?: () => string | null | undefined;
  /**
   * Called when an authenticated request answers 401. Resolve with a fresh
   * access token to have the request repeated once, or with null to give up.
   */
  onUnauthorized?: (error: ApiError) => Promise<string | null>;
  /** The portal host for white-label resolution. Defaults to the browser's host. */
  tenantHost?: Lazy<string | null | undefined>;
  /** Language for server-side messages ("en" | "ar"). */
  locale?: Lazy<string | null | undefined>;
  /** Defaults to "include": the HttpOnly refresh cookie only travels with credentials. */
  credentials?: RequestCredentials;
  /** Override for tests or server-side use. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30 s; 0 disables). */
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Query parameters: page query and filters. Empty values are dropped. */
  query?: object | null;
  /** JSON body (objects), or FormData / Blob sent as they are. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key`. Required by the API for payments and refunds. */
  idempotencyKey?: string;
  /** false = never send the access token and never try to refresh (public endpoints). */
  auth?: boolean;
  timeoutMs?: number;
}

export interface UploadOptions extends Omit<RequestOptions, 'body'> {
  /** Called with 0..1 while the body is being sent (browser only). */
  onProgress?: (fraction: number) => void;
}

export interface ApiClient {
  readonly app: AppKey;
  readonly baseUrl: string;
  /** Absolute URL of an API path including the query string. */
  url(path: string, query?: object | null): string;
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /** Like `request`, for the few endpoints that also answer in headers (`X-Total-Count`). */
  requestWithHeaders<T>(method: string, path: string, options?: RequestOptions): Promise<{ data: T; headers: Headers; status: number }>;
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
  /** multipart/form-data POST with upload progress. */
  upload<T>(path: string, form: FormData, options?: UploadOptions): Promise<T>;
  /** Authenticated binary download (PDFs, exports): the blob plus the file name the API suggests. */
  download(path: string, options?: RequestOptions & { method?: string; fallbackFilename?: string }): Promise<DownloadedFile>;
  /** Headers every call carries (also used by the raw upload helper). */
  baseHeaders(options?: { auth?: boolean }): Record<string, string>;
}

const API_PREFIX = '/api/v1';
/** 403 codes that mean "this session no longer exists", not "this action is not allowed". */
const SESSION_OVER_CODES = new Set(['SUPPORT_ACCESS_ENDED']);

export function normaliseBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  return trimmed.endsWith(API_PREFIX) ? trimmed : `${trimmed}${API_PREFIX}`;
}

const isBodyInit = (body: unknown): body is BodyInit =>
  (typeof FormData !== 'undefined' && body instanceof FormData) ||
  (typeof Blob !== 'undefined' && body instanceof Blob) ||
  (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) ||
  (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams);

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = normaliseBaseUrl(options.baseUrl);
  const doFetch: typeof fetch = (...args) => (options.fetch ?? globalThis.fetch)(...args);
  const credentials = options.credentials ?? 'include';

  const url = (path: string, query?: object | null) => `${base}${path.startsWith('/') ? path : `/${path}`}${buildQuery(query)}`;

  const baseHeaders = ({ auth = true }: { auth?: boolean } = {}): Record<string, string> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Client-App': options.app,
      // A custom header makes every call a non-simple CORS request: a foreign site can not send it.
      'X-Requested-With': 'typease',
    };
    const host = read(options.tenantHost) ?? (typeof window !== 'undefined' ? window.location.host : undefined);
    if (host) headers['X-Tenant-Host'] = host;
    const locale = read(options.locale);
    if (locale) headers['Accept-Language'] = locale;
    if (auth) {
      const token = options.getAccessToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  };

  async function send(method: string, path: string, opts: RequestOptions, tokenOverride?: string): Promise<Response> {
    const auth = opts.auth !== false;
    const headers = { ...baseHeaders({ auth }), ...(opts.headers ?? {}) };
    if (tokenOverride && auth) headers.Authorization = `Bearer ${tokenOverride}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    let body: BodyInit | undefined;
    if (opts.body !== undefined && opts.body !== null) {
      if (isBodyInit(opts.body)) body = opts.body;
      else {
        body = JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
      }
    }
    const timeoutMs = opts.timeoutMs ?? options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), timeoutMs) : null;
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await doFetch(url(path, opts.query), { method, headers, body, credentials, signal: controller.signal });
    } catch (e) {
      if (timedOut) throw new ApiError({ status: 0, code: 'TIMEOUT', message: 'The server took too long to answer. Please try again.', cause: e });
      throw networkError(e);
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Sends the request; on 401 asks for a new token once and repeats it. Returns the successful response. */
  async function exchange(method: string, path: string, opts: RequestOptions): Promise<Response> {
    let res = await send(method, path, opts);
    const signedIn = opts.auth !== false && !!options.onUnauthorized && !!options.getAccessToken?.();
    if (res.status === 401 && signedIn) {
      const error = await errorFromResponse(res);
      const fresh = await options.onUnauthorized!(error);
      if (!fresh) throw error;
      res = await send(method, path, opts, fresh);
    }
    if (!res.ok) {
      const error = await errorFromResponse(res);
      // A support session whose grant ran out or was revoked may be refused with 403 instead of 401:
      // it is over all the same, and the session has to know.
      if (signedIn && error.status === 403 && SESSION_OVER_CODES.has(error.code)) await options.onUnauthorized!(error);
      throw error;
    }
    return res;
  }

  async function parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new ApiError({ status: res.status, code: 'INVALID_RESPONSE', message: 'The server sent an answer that could not be read.', cause: e });
    }
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return parse<T>(await exchange(method, path, opts));
  }

  async function requestWithHeaders<T>(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: T; headers: Headers; status: number }> {
    const res = await exchange(method, path, opts);
    return { data: await parse<T>(res), headers: res.headers, status: res.status };
  }

  function uploadWithXhr(path: string, form: FormData, opts: UploadOptions, tokenOverride?: string): Promise<{ status: number; text: string; requestId?: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url(path, opts.query));
      xhr.withCredentials = credentials === 'include';
      const headers = { ...baseHeaders({ auth: opts.auth !== false }), ...(opts.headers ?? {}) };
      if (tokenOverride) headers.Authorization = `Bearer ${tokenOverride}`;
      if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.min(1, e.loaded / e.total));
      };
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, requestId: xhr.getResponseHeader('x-request-id') ?? undefined });
      xhr.onerror = () => reject(networkError(new Error('upload failed')));
      xhr.onabort = () => reject(networkError(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      if (opts.signal) {
        if (opts.signal.aborted) return xhr.abort();
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  }

  async function upload<T>(path: string, form: FormData, opts: UploadOptions = {}): Promise<T> {
    // fetch has no upload progress; without XMLHttpRequest (tests, server) fall back to it.
    if (typeof XMLHttpRequest === 'undefined') return request<T>('POST', path, { ...opts, body: form, timeoutMs: opts.timeoutMs ?? 0 });
    const toError = (r: { status: number; text: string; requestId?: string }) =>
      errorFromResponse(new Response(r.text || null, { status: r.status, headers: r.requestId ? { 'x-request-id': r.requestId } : {} }));
    let r = await uploadWithXhr(path, form, opts);
    if (r.status === 401 && opts.auth !== false && options.onUnauthorized && options.getAccessToken?.()) {
      const error = await toError(r);
      const fresh = await options.onUnauthorized(error);
      if (!fresh) throw error;
      r = await uploadWithXhr(path, form, opts, fresh);
    }
    if (r.status < 200 || r.status >= 300) throw await toError(r);
    opts.onProgress?.(1);
    return (r.text ? JSON.parse(r.text) : undefined) as T;
  }

  async function download(path: string, opts: RequestOptions & { method?: string; fallbackFilename?: string } = {}): Promise<DownloadedFile> {
    const res = await exchange(opts.method ?? 'GET', path, { ...opts, headers: { Accept: '*/*', ...(opts.headers ?? {}) } });
    const blob = await res.blob();
    return {
      blob,
      filename: filenameFromContentDisposition(res.headers.get('content-disposition')) ?? opts.fallbackFilename ?? 'download',
      contentType: res.headers.get('content-type') ?? blob.type ?? 'application/octet-stream',
    };
  }

  return {
    app: options.app,
    baseUrl: base,
    url,
    request,
    requestWithHeaders,
    get: (path, o) => request('GET', path, o),
    post: (path, body, o) => request('POST', path, { ...o, body }),
    put: (path, body, o) => request('PUT', path, { ...o, body }),
    patch: (path, body, o) => request('PATCH', path, { ...o, body }),
    delete: (path, o) => request('DELETE', path, o),
    upload,
    download,
    baseHeaders,
  };
}
