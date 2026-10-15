import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import type { DomainEventType } from '@typease/types';
import type { PrismaClient } from '@typease/database';
import { encryptJson } from '../../common/crypto';
import type { TenantDb } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';

/**
 * Test fixtures shared by the notification, reminder, appointment, task and
 * support specs. Only used by tests; deliberately free of imports from /test so
 * the production build (rootDir = src) is not affected.
 */
export interface TestApp {
  sys: PrismaClient;
  db: TenantDb;
  inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  get<T>(type: new (...args: any[]) => T): T;
}
export interface TenantFixture {
  id: string;
  headOfficeId: string;
}
let counter = 0;
export const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export async function makeCustomer(
  t: TestApp,
  tenant: TenantFixture,
  opts: { fullName?: string; fullNameAr?: string; email?: string | null; phone?: string | null; language?: string; communicationPrefs?: Record<string, boolean>; consents?: string[]; corporateAccountId?: string } = {},
) {
  const id = uniq();
  const customer = await t.sys.customer.create({
    data: {
      tenantId: tenant.id,
      customerNo: `CUS-T${id}`,
      fullName: opts.fullName ?? `Customer ${id}`,
      fullNameAr: opts.fullNameAr ?? null,
      email: opts.email === undefined ? `cust-${id}@example.test` : opts.email,
      phone: opts.phone === undefined ? `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` : opts.phone,
      preferredLanguage: opts.language ?? 'en',
      corporateAccountId: opts.corporateAccountId ?? null,
      ...(opts.communicationPrefs ? { communicationPrefs: opts.communicationPrefs } : {}),
    },
  });
  for (const purpose of opts.consents ?? []) await setConsent(t, tenant.id, customer.id, purpose, 'GRANTED');
  return customer;
}

export async function setConsent(t: TestApp, tenantId: string, customerId: string, purpose: string, status: 'GRANTED' | 'WITHDRAWN') {
  const now = new Date();
  await t.sys.customerConsent.upsert({
    where: { customerId_purpose: { customerId, purpose } },
    create: { tenantId, customerId, purpose, status, grantedAt: status === 'GRANTED' ? now : null, withdrawnAt: status === 'GRANTED' ? null : now },
    update: { status, grantedAt: status === 'GRANTED' ? now : null, withdrawnAt: status === 'GRANTED' ? null : now },
  });
}

export async function makeService(t: TestApp, tenant: TenantFixture, opts: { name?: string; nameAr?: string; categoryKey?: string } = {}) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id, ...(opts.categoryKey ? { key: opts.categoryKey } : {}) }, orderBy: { sortOrder: 'asc' } });
  return t.sys.service.create({ data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`.toUpperCase(), name: opts.name ?? 'Residence visa renewal', nameAr: opts.nameAr ?? 'تجديد تأشيرة الإقامة' } });
}

export async function makeRequest(t: TestApp, tenant: TenantFixture, customerId: string, opts: { serviceId?: string; status?: string; branchId?: string } = {}) {
  const serviceId = opts.serviceId ?? (await makeService(t, tenant)).id;
  return t.sys.serviceRequest.create({
    data: { tenantId: tenant.id, branchId: opts.branchId ?? tenant.headOfficeId, requestNo: `TE-${uniq()}`.toUpperCase(), customerId, serviceId, status: (opts.status as any) ?? 'SUBMITTED' },
  });
}

/** Emit a domain event the way a business module would: inside a tenant transaction. Returns the event id. */
export async function emit(t: TestApp, tenantId: string, type: DomainEventType, payload: Record<string, any>): Promise<string> {
  const event = await t.inTenant(tenantId, () => t.db.tx((tx) => t.get(DomainEvents).emit(tx, type, payload)));
  return event.id;
}

/** Tenant-owned provider credentials, as the integrations module stores them. */
export async function makeIntegration(t: TestApp, tenantId: string, category: string, provider: string, config: Record<string, any>, secrets: Record<string, any>, status = 'ACTIVE') {
  const existing = await t.sys.integration.findFirst({ where: { tenantId, category, provider } });
  const data = { name: `${provider} (${category})`, status: status as any, mode: 'LIVE', config, secretsEnc: encryptJson(secrets), secretKeys: Object.keys(secrets), secretsUpdatedAt: new Date() };
  return existing ? t.sys.integration.update({ where: { id: existing.id }, data }) : t.sys.integration.create({ data: { ...data, tenantId, category, provider } });
}

const decodeQp = (text: string) => text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));

export interface ReceivedMail {
  from: string;
  to: string[];
  raw: string;
  /** Raw message with quoted-printable soft breaks removed, for substring assertions. */
  text: string;
  header(name: string): string | undefined;
}

/** A real SMTP server on a random local port. `behaviour` decides what happens to the next messages. */
export class TestSmtp {
  readonly messages: ReceivedMail[] = [];
  readonly logins: Array<{ username?: string; password?: string }> = [];
  /** Responses for upcoming messages: 'ok' accepts, a number rejects with that SMTP code. Empty = accept. */
  behaviour: Array<'ok' | number> = [];
  attempts = 0;
  port = 0;
  private server!: SMTPServer;

  async start(): Promise<this> {
    this.server = new SMTPServer({
      authOptional: true,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onAuth: (auth, _session, callback) => {
        this.logins.push({ username: auth.username, password: auth.password });
        callback(null, { user: auth.username });
      },
      onData: (stream, session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          this.attempts += 1;
          const next = this.behaviour.shift() ?? 'ok';
          if (next !== 'ok') {
            const err: any = new Error(next >= 500 ? 'Mailbox unavailable' : 'Try again later');
            err.responseCode = next;
            return callback(err);
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          const text = decodeQp(raw);
          this.messages.push({
            from: (session.envelope.mailFrom as any)?.address ?? '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
            text,
            header: (name: string) => raw.match(new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'im'))?.[1]?.replace(/\r?\n[ \t]+/g, ' '),
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.server.address() as AddressInfo).port;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
/** A local HTTP server that records every request and answers with the queued responses. */
export class FakeHttp {
  readonly requests: CapturedRequest[] = [];
  responses: Array<{ status: number; body: unknown }> = [];
  defaultResponse: { status: number; body: unknown } = { status: 200, body: {} };
  /** Per-path responses (prefix match), checked before the queue. */
  routes: Array<{ path: string; status: number; body: unknown }> = [];
  url = '';
  private server!: Server;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const route = this.routes.find((r) => (req.url ?? '').startsWith(r.path));
        const response = route ?? this.responses.shift() ?? this.defaultResponse;
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.body));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
