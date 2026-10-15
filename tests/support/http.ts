import type { Response } from 'supertest';
import { Actor, TestApp } from '../../services/api/test/helpers';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Headers = Record<string, string>;

const BASE = '/api/v1';

/** One line that says what was asked and what the API answered, in the API's own words. */
export function describeResponse(method: string, path: string, who: string, res: Response): string {
  const body: any = res.body ?? {};
  const details = body.details ? ` details=${JSON.stringify(body.details).slice(0, 800)}` : '';
  const text = body.code || body.message ? `${body.code ?? ''}: ${body.message ?? ''}` : String(res.text ?? '').slice(0, 300);
  return `${method} ${path} as ${who} -> ${res.status} ${text}${details}`;
}

/**
 * The HTTP client of the acceptance suite: every call goes over the wire to the
 * booted application, with the bearer token of the acting user, exactly like the
 * web and mobile apps do.
 *
 *  - `get / post / put / patch / delete` are for steps that must succeed: they
 *    return the JSON body and throw (with the API's own message) on any other
 *    status than the expected one. A scenario therefore stops at the step that
 *    broke, with a readable reason.
 *  - `req` returns the raw response for steps whose refusal is the point.
 */
export class Api {
  constructor(
    private readonly t: TestApp,
    readonly actor: Actor | null,
    private readonly extraHeaders: Headers = {},
    private readonly label: string = actor?.email ?? 'anonymous',
  ) {}

  /** The same client with additional request headers (Idempotency-Key, x-tenant-host, ...). */
  with(headers: Headers): Api {
    return new Api(this.t, this.actor, { ...this.extraHeaders, ...headers }, this.label);
  }

  /** Raw request; nothing is asserted. `path` is relative to /api/v1 unless it starts with "http" or "/api/" or "/health". */
  req(method: Method, path: string, body?: unknown, headers: Headers = {}) {
    const url = path.startsWith('http') ? pathOf(path) : path.startsWith('/api/') || path.startsWith('/health') ? path : BASE + path;
    let r = this.t.http[method.toLowerCase() as 'get'](url);
    if (this.actor) r = r.set('Authorization', `Bearer ${this.actor.token}`);
    for (const [k, v] of Object.entries({ ...this.extraHeaders, ...headers })) r = r.set(k, v);
    if (body !== undefined && method !== 'GET') r = r.send(body as object);
    else if (method === 'POST' || method === 'PUT' || method === 'PATCH') r = r.send({});
    return r;
  }

  /** multipart/form-data upload of one file (logo, simple document upload). Raw response. */
  upload(path: string, field: string, file: { content: Buffer; filename: string; mime: string }, fields: Record<string, string> = {}) {
    let r = this.t.http.post(BASE + path);
    if (this.actor) r = r.set('Authorization', `Bearer ${this.actor.token}`);
    for (const [k, v] of Object.entries(this.extraHeaders)) r = r.set(k, v);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach(field, file.content, { filename: file.filename, contentType: file.mime });
  }

  private async ok(method: Method, path: string, body: unknown, expected: number | number[] | undefined): Promise<any> {
    const res = await this.req(method, path, body);
    const wanted = expected === undefined ? [200, 201] : [expected].flat();
    if (!wanted.includes(res.status)) throw new Error(`${describeResponse(method, path, this.label, res)} (expected ${wanted.join(' or ')})`);
    return res.body;
  }
  get<T = any>(path: string, expected?: number | number[]): Promise<T> {
    return this.ok('GET', path, undefined, expected);
  }
  post<T = any>(path: string, body?: unknown, expected?: number | number[]): Promise<T> {
    return this.ok('POST', path, body, expected);
  }
  put<T = any>(path: string, body?: unknown, expected?: number | number[]): Promise<T> {
    return this.ok('PUT', path, body, expected);
  }
  patch<T = any>(path: string, body?: unknown, expected?: number | number[]): Promise<T> {
    return this.ok('PATCH', path, body, expected);
  }
  delete<T = any>(path: string, expected?: number | number[]): Promise<T> {
    return this.ok('DELETE', path, undefined, expected);
  }

  /** A binary answer (PDF, export file) as a Buffer, with its headers. */
  async download(path: string, expected = 200): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const res = await this.req('GET', path)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    if (res.status !== expected) throw new Error(`GET ${path} as ${this.label} -> ${res.status} (expected ${expected})`);
    return { status: res.status, headers: res.headers as Record<string, string>, body: res.body as Buffer };
  }
}

/** Path + query of an absolute URL the API handed out (signed upload / download links, checkout pages). */
export function pathOf(url: string): string {
  if (url.startsWith('/')) return url;
  const u = new URL(url);
  return u.pathname + u.search;
}

/**
 * Asserts a refusal with a message that names the call. `status` may be a list
 * when two answers are equally correct (e.g. 403 or 404 for a foreign row).
 */
export function expectRefused(res: Response, status: number | number[], code?: string | string[]): void {
  const wanted = [status].flat();
  const where = `${res.request?.method ?? ''} ${res.request?.url ? new URL(res.request.url).pathname.replace(/[A-Za-z0-9_.-]{60,}/g, '<token>') : ''}`;
  if (process.env.DEBUG_REFUSALS) process.stderr.write(`REFUSAL ${where} -> ${res.status} ${res.body?.code ?? ''} (accepted: ${wanted.join('/')}${code ? ` ${[code].flat().join('/')}` : ''})\n`);
  if (!wanted.includes(res.status)) {
    throw new Error(`${where} answered ${res.status} ${JSON.stringify(res.body).slice(0, 400)} - expected a refusal with ${wanted.join(' or ')}`);
  }
  if (code && ![code].flat().includes(res.body?.code)) {
    throw new Error(`${where} answered ${res.status} with code ${res.body?.code} - expected ${[code].flat().join(' or ')}`);
  }
}
