import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../app.module';
import { configureApp } from '../../bootstrap';
import { SystemDb } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { FEATURE_MODULES } from '../../modules';
import { ProvisioningService } from '../../modules/tenancy/provisioning.service';

/** An API error, reported with the words the API itself used. */
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string,
    readonly apiMessage: string,
    readonly details: unknown,
    readonly actor: string,
  ) {
    super(`${method} ${path} as ${actor} -> ${status} ${code}: ${apiMessage}${details ? `\n    details: ${JSON.stringify(details).slice(0, 1200)}` : ''}`);
    this.name = 'ApiError';
  }
}

export type AppKey = 'centre' | 'customer' | 'corporate' | 'platform';

/** A signed-in user of one of the four apps. */
export interface Actor {
  label: string;
  email: string;
  app: AppKey;
  tenantSlug?: string;
  token: string;
  userId: string;
  membershipId: string | null;
  roleKey: string | null;
  customerId: string | null;
  corporateAccountId: string | null;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

/** Minimal HTTP client: JSON in, JSON out, the API's own error message on failure. */
export class Http {
  constructor(
    private readonly rt: SeedRuntime,
    private readonly actor: Actor | null,
  ) {}

  get<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.send('GET', path, undefined, options);
  }
  post<T = any>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.send('POST', path, body ?? {}, options);
  }
  put<T = any>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.send('PUT', path, body ?? {}, options);
  }
  patch<T = any>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.send('PATCH', path, body ?? {}, options);
  }
  delete<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.send('DELETE', path, undefined, options);
  }

  /** multipart/form-data upload of one file (branding logo, simple document upload). */
  async upload<T = any>(path: string, field: string, file: { content: Buffer; filename: string; mime: string }, fields: Record<string, string> = {}): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append(field, new Blob([new Uint8Array(file.content)], { type: file.mime }), file.filename);
    return this.raw('POST', path, form, {});
  }

  /**
   * Calls an endpoint that is expected to refuse, and returns the refusal. Used to
   * demonstrate plan limits and tenant isolation; an unexpected success stops the seed.
   */
  async expectRefusal(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, expected: { status: number; code?: string }): Promise<ApiError> {
    try {
      await this.send(method, path, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), {});
    } catch (e) {
      if (e instanceof ApiError && e.status === expected.status && (!expected.code || e.code === expected.code)) return e;
      throw e;
    }
    throw new Error(`${method} ${path} as ${this.actor?.label ?? 'anonymous'} was expected to be refused with ${expected.status}${expected.code ? ` ${expected.code}` : ''}, but it succeeded.`);
  }

  private send<T>(method: string, path: string, body: unknown, options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const qs = Object.entries(options.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.raw(method, qs ? `${path}?${qs}` : path, payload, headers);
  }

  private async raw<T>(method: string, path: string, body: any, headers: Record<string, string>, retried = false): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.rt.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      body,
      headers: { ...(this.actor ? { authorization: `Bearer ${this.actor.token}` } : {}), ...(this.actor ? { 'x-client-app': this.actor.app } : {}), ...headers },
    });
    this.rt.calls += 1;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (res.ok) return json as T;
    // Access tokens are short-lived: sign in again once and repeat the call.
    if (res.status === 401 && this.actor && !retried && ['TOKEN_INVALID', 'SESSION_EXPIRED'].includes(json?.code)) {
      const fresh = await this.rt.login(this.actor.email, this.actor.app, this.actor.tenantSlug, this.actor.label);
      this.actor.token = fresh.token;
      return this.raw(method, path, body, headers, true);
    }
    const shown = path.startsWith('http') ? new URL(path).pathname.replace(/[A-Za-z0-9_-]{40,}/g, '<token>') : path;
    throw new ApiError(method, shown, res.status, json?.code ?? 'HTTP_ERROR', json?.message ?? String(text).slice(0, 300), json?.details, this.actor?.label ?? 'anonymous');
  }
}

/**
 * The real application, started in this process on an ephemeral port, plus the
 * few things a seed needs besides HTTP: delivering outbox events and running
 * queued / scheduled jobs (the worker's job), and the system database client
 * for the documented exceptions (see docs/DEMO_ENVIRONMENT.md).
 */
export class SeedRuntime {
  calls = 0;
  private constructor(
    readonly app: NestExpressApplication,
    readonly baseUrl: string,
    readonly password: string,
  ) {}

  static async boot(port: number, password: string): Promise<SeedRuntime> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'], rawBody: true });
    configureApp(app);
    await app.listen(port, '127.0.0.1');
    // Reference data (permissions, plans, document types, notification templates); idempotent.
    await app.get(ProvisioningService).bootstrapPlatform();
    return new SeedRuntime(app, `http://127.0.0.1:${port}`, password);
  }

  get<T>(type: new (...args: any[]) => T): T {
    return this.app.get(type, { strict: false });
  }
  /**
   * Is a feature module part of this application (e.g. 'IntegrationsModule')? A deployment can run with a
   * subset of modules (TYPEASE_MODULES); the seed then falls back to the documented direct write.
   */
  hasModule(className: string): boolean {
    return FEATURE_MODULES.some((m) => m?.name === className);
  }
  /** System database client. Use only for the exceptions listed in the demo guide. */
  get sys() {
    return this.get(SystemDb).client;
  }
  get jobs() {
    return this.get(JobQueue);
  }

  anonymous(): Http {
    return new Http(this, null);
  }
  as(actor: Actor): Http {
    return new Http(this, actor);
  }

  async login(email: string, app: AppKey, tenantSlug: string | undefined, label: string): Promise<Actor> {
    const res = await this.anonymous().post('/auth/login', { email, password: this.password, app, ...(tenantSlug && app !== 'centre' && app !== 'platform' ? { tenantSlug } : {}) });
    if (res.status !== 'OK') throw new Error(`Sign-in of ${email} (${app}) did not complete: ${res.status}`);
    return this.actorFrom(res, email, app, tenantSlug, label);
  }
  actorFrom(res: any, email: string, app: AppKey, tenantSlug: string | undefined, label: string): Actor {
    const s = res.session;
    return {
      label,
      email,
      app,
      tenantSlug,
      token: res.accessToken,
      userId: s.user.id,
      membershipId: s.membership?.id ?? null,
      roleKey: s.membership?.roleKey ?? null,
      customerId: s.membership?.customerId ?? null,
      corporateAccountId: s.membership?.corporateAccountId ?? null,
    };
  }

  /** Step 2 of the document upload: the raw bytes go to the one-time signed URL the API issued. */
  async putBytes(url: string, headers: Record<string, string>, content: Buffer): Promise<void> {
    const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(content) });
    this.calls += 1;
    if (!res.ok) {
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      throw new ApiError('PUT', '<signed upload URL>', res.status, json?.code ?? 'HTTP_ERROR', json?.message ?? text.slice(0, 300), json?.details, 'upload');
    }
  }

  /** Deliver outbox events and run queued jobs until the system is idle (what the worker does continuously). */
  async settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      const delivered = await this.get(DomainEvents).dispatch();
      const ran = await this.jobs.drain();
      if (!delivered && !ran) break;
    }
    if (this.jobs.deadLetters.length) {
      const first = this.jobs.deadLetters[0];
      throw new Error(`A background job failed for good: ${first.name} - ${first.error}`);
    }
  }

  /** Run a scheduled job once, like the worker's scheduler would, then settle. */
  async runScheduled(name: string): Promise<void> {
    await this.jobs.runScheduled(name);
    await this.settle();
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}

// ------------------------------------------------------------------ progress output

const started = Date.now();
export const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

export function section(title: string): void {
  console.log(`\n== ${title}`);
}

let afterStep: (() => Promise<void>) | null = null;
/** Registers what runs after every step: delivering events and draining jobs. */
export function onStepDone(fn: () => Promise<void>): void {
  afterStep = fn;
}

/** One named unit of work. A failure is printed with the API's message and stops the seed. */
export async function step<T>(name: string, fn: () => Promise<T>, summary?: (result: T) => string): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    if (afterStep) await afterStep();
    const note = summary ? ` - ${summary(result)}` : '';
    console.log(`   ok  ${name}${note}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return result;
  } catch (e: any) {
    console.error(`\n   FAILED  ${name}`);
    throw new StepError(name, e);
  }
}

export class StepError extends Error {
  constructor(
    readonly stepName: string,
    readonly reason: any,
  ) {
    super(`${stepName}: ${reason?.message ?? reason}`);
    this.name = 'StepError';
  }
}

// ------------------------------------------------------------------ small helpers

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const daysAgo = (days: number, from: Date = new Date()) => new Date(from.getTime() - days * DAY);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const money = (n: number) => n.toFixed(2);
export function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Demo data refers to ${what}, which does not exist.`);
  return value;
}
