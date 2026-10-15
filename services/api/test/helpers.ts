import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { SystemDb, TenantDb } from '../src/common/db/prisma.service';
import { DomainEvents } from '../src/common/events.service';
import { JobQueue } from '../src/common/jobs/job-queue';
import { Messenger } from '../src/common/messenger';
import { runAsTenant } from '../src/common/context';
import { BrandingService, DnsLookup } from '../src/modules/tenancy/branding.service';
import { ProvisioningService } from '../src/modules/tenancy/provisioning.service';

export const PASSWORD = 'Correct-Horse-42';
let counter = 0;
/** Unique suffix so test files can share one database without colliding. */
export const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export interface Actor {
  token: string;
  userId: string;
  email: string;
  membershipId: string | null;
  customerId: string | null;
  roleKey: string | null;
}
export interface TenantFixture {
  id: string;
  slug: string;
  name: string;
  owner: Actor;
  headOfficeId: string;
}

/** Deterministic DNS for custom-domain tests. */
export class FakeDns extends DnsLookup {
  records = new Map<string, string[]>();
  async resolveTxt(name: string): Promise<string[]> {
    return this.records.get(name) ?? [];
  }
}

/**
 * Boots the real Nest application (all modules, guards, pipes and filters)
 * against the migrated PostgreSQL test database and exposes fixtures that go
 * through the public HTTP API wherever practical.
 */
export class TestApp {
  http!: ReturnType<typeof request>;
  dns = new FakeDns();
  private constructor(public readonly app: NestExpressApplication) {}

  static async create(): Promise<TestApp> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'], rawBody: true });
    configureApp(app);
    const t = new TestApp(app);
    // Listen on an ephemeral port: one real server for the whole file (supertest would otherwise open
    // and close a listener per request, which is flaky under concurrent requests).
    await app.listen(0, '127.0.0.1');
    (app.get(BrandingService) as any).dnsLookup = t.dns;
    t.http = request(app.getHttpServer());
    await app.get(ProvisioningService).bootstrapPlatform();
    app.get(JobQueue).clearInline();
    return t;
  }

  get<T>(type: new (...args: any[]) => T): T {
    return this.app.get(type, { strict: false });
  }
  get sys() {
    return this.get(SystemDb).client;
  }
  get db() {
    return this.get(TenantDb);
  }
  get jobs() {
    return this.get(JobQueue);
  }
  get messenger() {
    return this.get(Messenger);
  }

  /** Deliver outbox events and run queued jobs until the system is idle. */
  async settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      const delivered = await this.get(DomainEvents).dispatch();
      const ran = await this.jobs.drain();
      if (!delivered && !ran) break;
    }
  }

  /** Run code as the system actor inside one tenant (uses the RLS-enforced connection). */
  inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runAsTenant(tenantId, fn);
  }

  as(actor: Actor | null) {
    const set = (r: request.Test) => (actor ? r.set('Authorization', `Bearer ${actor.token}`) : r);
    const base = '/api/v1';
    return {
      get: (path: string) => set(this.http.get(base + path)),
      post: (path: string, body?: object) => set(this.http.post(base + path)).send(body ?? {}),
      put: (path: string, body?: object) => set(this.http.put(base + path)).send(body ?? {}),
      patch: (path: string, body?: object) => set(this.http.patch(base + path)).send(body ?? {}),
      delete: (path: string) => set(this.http.delete(base + path)),
      upload: (path: string, field: string, content: Buffer, filename: string, fields: Record<string, string> = {}) => {
        let r = set(this.http.post(base + path));
        for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
        return r.attach(field, content, filename);
      },
    };
  }

  async login(email: string, password = PASSWORD, app = 'centre', tenantSlug?: string): Promise<Actor> {
    const res = await this.http.post('/api/v1/auth/login').send({ email, password, app, tenantSlug });
    if (res.status !== 200 || res.body.status !== 'OK') throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    const s = res.body.session;
    return {
      token: res.body.accessToken,
      userId: s.user.id,
      email,
      membershipId: s.membership?.id ?? null,
      customerId: s.membership?.customerId ?? null,
      roleKey: s.membership?.roleKey ?? null,
    };
  }

  /**
   * Creates an operational centre through the real sign-up endpoint, verifies the
   * owner's email, and puts it on a plan (default: enterprise, so plan limits do
   * not interfere with unrelated tests).
   */
  async createTenant(opts: { slug?: string; name?: string; plan?: string | null; status?: string } = {}): Promise<TenantFixture> {
    const id = uniq();
    const slug = opts.slug ?? `t-${id}`;
    const email = `owner-${id}@example.test`;
    const signup = await this.http.post('/api/v1/public/signup').send({
      businessName: opts.name ?? `Centre ${id}`,
      slug,
      ownerName: `Owner ${id}`,
      email,
      phone: `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      password: PASSWORD,
      acceptTerms: true,
    });
    if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
    const verify = await this.http.post('/api/v1/auth/verify-email').send({ token: signup.body.dev.emailVerificationToken });
    if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
    const tenantId = signup.body.tenantId;
    const planKey = opts.plan === undefined ? 'enterprise' : opts.plan;
    if (planKey) {
      const plan = await this.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: planKey } });
      await this.sys.subscription.create({
        data: { tenantId, planId: plan.id, status: 'ACTIVE', billingCycle: 'MONTHLY', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) },
      });
    }
    await this.sys.tenant.update({
      where: { id: tenantId },
      data: { status: (opts.status as any) ?? 'ACTIVE', legalName: `${opts.name ?? slug} LLC`, emirate: 'Dubai', onboardingStep: 10 },
    });
    const owner = await this.login(email);
    const branch = await this.sys.branch.findFirstOrThrow({ where: { tenantId, isHeadOffice: true } });
    return { id: tenantId, slug, name: opts.name ?? `Centre ${id}`, owner, headOfficeId: branch.id };
  }

  /** Invite a staff member as the owner and accept the invitation, like a real user would. */
  async addStaff(tenant: TenantFixture, roleKey: string, opts: { branchIds?: string[]; allBranches?: boolean } = {}): Promise<Actor> {
    const email = `${roleKey}-${uniq()}@example.test`;
    const invite = await this.as(tenant.owner).post('/staff/invitations', {
      email,
      fullName: `${roleKey} ${email.slice(0, 12)}`,
      roleKey,
      allBranches: opts.allBranches ?? !opts.branchIds,
      branchIds: opts.branchIds ?? [],
    });
    if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
    const accept = await this.http.post('/api/v1/auth/invitations/accept').send({ token: invite.body.dev.invitationToken, password: PASSWORD, app: 'centre' });
    if (accept.status !== 200 || accept.body.status !== 'OK') throw new Error(`accept failed: ${accept.status} ${JSON.stringify(accept.body)}`);
    return this.login(email);
  }

  /** Customer self-registration on the centre's portal + email verification. */
  async addCustomer(tenant: TenantFixture, opts: { fullName?: string; email?: string } = {}): Promise<Actor> {
    const email = opts.email ?? `customer-${uniq()}@example.test`;
    const reg = await this.http.post('/api/v1/auth/register').send({ tenantSlug: tenant.slug, fullName: opts.fullName ?? 'Test Customer', email, password: PASSWORD, acceptTerms: true });
    if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    const verify = await this.http.post('/api/v1/auth/verify-email').send({ token: reg.body.dev.emailVerificationToken });
    if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
    return this.login(email, PASSWORD, 'customer', tenant.slug);
  }

  async createPlatformAdmin(role: 'SUPER_ADMIN' | 'SUPPORT_AGENT' = 'SUPER_ADMIN'): Promise<Actor> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
    const { hashPassword } = require('../src/modules/auth/auth.service');
    const email = `platform-${uniq()}@typease.test`;
    await this.sys.user.create({ data: { email, fullName: `Platform ${role}`, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date(), platformRole: role } });
    return this.login(email, PASSWORD, 'platform');
  }

  async close() {
    await this.app.close();
  }
}
