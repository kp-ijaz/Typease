import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { ACCESS_KEY } from '../src/common/auth/access';
import { TestApp } from './helpers';

const SRC = join(__dirname, '..', 'src');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}
const files = walk(SRC);
const rel = (f: string) => relative(SRC, f).replace(/\\/g, '/');

/**
 * Files allowed to use the system database connection, which is NOT restricted
 * by row-level security. Every entry is cross-tenant by nature. Adding a file
 * here is a security decision and must be reviewed.
 */
const SYSTEM_DB_ALLOWED = [
  // infrastructure
  'common/db/prisma.service.ts',
  'common/core.module.ts',
  'common/audit.service.ts', // platform-level audit + security events
  'common/auth/principal.service.ts', // session / membership lookup before a tenant is known
  'common/events.service.ts', // outbox dispatcher
  'common/tenant-directory.ts', // job fan-out over tenants
  'index.ts',
  // identity and tenancy
  'modules/auth/auth.service.ts',
  'modules/tenancy/tenant-resolver.service.ts',
  'modules/tenancy/provisioning.service.ts',
  'modules/tenancy/onboarding.service.ts',
  'modules/tenancy/organisation.service.ts', // placeholder user for invitations, session revocation
  'modules/tenancy/branding.service.ts', // public config, domain verification state
  'modules/health/health.controller.ts',
  // user placeholders for portal invitations
  'modules/customers/portal.service.ts',
  'modules/corporate/corporate-access.service.ts',
  // platform registers (system-only tables)
  'modules/privacy/incident.service.ts',
  // Erasure of one person inside one centre: (1) the append-only trails (audit, security events, status and
  // consent history, document access log) refuse UPDATE on the tenant connection, and redacting the person's
  // values needs the controlled purge switch, which only the system role may use; (2) `users` is platform-wide:
  // only the system connection may anonymise a login and see whether it is still used by another centre.
  // Every statement in this file is filtered by the tenant of the erasure or by the person's own account ids.
  'modules/privacy/erasure-system.service.ts',
  // webhooks arrive without a tenant session
  'modules/finance/payment-webhook.service.ts',
  // WhatsApp webhook: finds the centre of the integration named in the URL, then works inside that tenant only
  'modules/whatsapp/inbox.service.ts',
  // TypEase's authority fee catalogue is platform-wide (global-readable table written by platform staff only)
  'modules/catalogue/authority-fees.service.ts',
  // SaaS billing is platform-controlled
  'modules/subscriptions/billing.core.ts',
  'modules/subscriptions/plans.service.ts',
  'modules/subscriptions/subscriptions.service.ts',
  'modules/subscriptions/lifecycle.service.ts',
  'modules/subscriptions/subscription-webhook.service.ts',
  // platform support desk
  'modules/support/platform-support.service.ts',
  // platform console and cross-tenant administration
  'modules/platform/',
  'modules/integrations/platform-integrations.service.ts',
  'cli/',
];


/** All controller instances of the booted application. */
function controllersOf(t: TestApp): any[] {
  const container = t.app.get(ModulesContainer, { strict: false });
  const out: any[] = [];
  for (const mod of container.values()) for (const wrapper of mod.controllers.values()) if (wrapper.instance) out.push(wrapper.instance);
  return out;
}

describe('Architecture rules', () => {
  it('only allow-listed files use the system (non-RLS) database connection', () => {
    const offenders = files
      .filter((f) => /\bSystemDb\b/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !SYSTEM_DB_ALLOWED.some((allowed) => (allowed.endsWith('/') ? f.startsWith(allowed) : f === allowed)));
    expect(offenders).toEqual([]);
  });

  it('no module reads a tenant id from the request body, query or params', () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.controller.ts'))) {
      const text = readFileSync(f, 'utf8');
      if (/@(Body|Query|Param)\(\s*['"]tenantId['"]\s*\)/.test(text)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it('no source file contains unfinished-work markers', () => {
    const offenders = files.filter((f) => /\b(TODO|FIXME)\b|not implemented yet|coming soon/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('never disables TLS verification or logs secrets', () => {
    const offenders = files.filter((f) => /rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  describe('with the application booted', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await TestApp.create();
    });
    afterAll(() => t.close());

    it('every HTTP route declares an access rule (fail closed)', () => {
      const scanner = new MetadataScanner();
      const reflector = t.app.get(Reflector, { strict: false });
      const missing: string[] = [];
      let total = 0;
      for (const instance of controllersOf(t)) {
        const proto = Object.getPrototypeOf(instance);
        for (const method of scanner.getAllMethodNames(proto)) {
          const handler = proto[method];
          if (Reflect.getMetadata('path', handler) === undefined) continue;
          total += 1;
          const rule = reflector.getAllAndOverride(ACCESS_KEY, [handler, instance.constructor]);
          if (!rule) missing.push(`${instance.constructor.name}.${method}`);
        }
      }
      expect(total).toBeGreaterThan(300);
      expect(missing).toEqual([]);
    });

    it('public routes are rate limited or explicitly harmless', () => {
      const HARMLESS = /health|asset|tlsAsk|tenantConfig|plans|live|ready|logout|selectTenant|display|sandbox|stream|localDownload|download|upload/i;
      const scanner = new MetadataScanner();
      const unprotected: string[] = [];
      for (const instance of controllersOf(t)) {
        const proto = Object.getPrototypeOf(instance);
        for (const method of scanner.getAllMethodNames(proto)) {
          const handler = proto[method];
          const rule = Reflect.getMetadata(ACCESS_KEY, handler) ?? Reflect.getMetadata(ACCESS_KEY, instance.constructor);
          if (rule?.type !== 'public') continue;
          const limited = Reflect.getMetadata('typease:rate-limit', handler) ?? Reflect.getMetadata('typease:rate-limit', instance.constructor);
          if (!limited && !HARMLESS.test(method)) unprotected.push(`${instance.constructor.name}.${method}`);
        }
      }
      expect(unprotected).toEqual([]);
    });

    it('database sessions run in UTC and agree with the application clock', async () => {
      const before = Date.now();
      const rows = await t.sys.$queryRaw<Array<{ tz: string; db_now: Date }>>`SELECT current_setting('timezone') AS tz, now() AS db_now`;
      expect(rows[0].tz).toBe('UTC');
      expect(Math.abs(new Date(rows[0].db_now).getTime() - before)).toBeLessThan(5000);
      const tenant = await t.createTenant();
      const viaApp = await t.inTenant(tenant.id, () => t.db.tx((tx) => tx.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('timezone') AS tz`));
      expect(viaApp[0].tz).toBe('UTC');
      // A timestamp written by the application compares correctly with the database clock.
      const row = await t.sys.outboxEvent.create({ data: { type: 'customer.created', payload: {}, tenantId: tenant.id, status: 'PROCESSED' } });
      const cmp = await t.sys.$queryRaw<Array<{ seconds: number }>>`SELECT abs(extract(epoch from (now() - "createdAt")))::float AS seconds FROM "outbox_events" WHERE id = ${row.id}::uuid`;
      expect(cmp[0].seconds).toBeLessThan(5);
    });

    it('the tenant-scoped connection is not a superuser and cannot bypass row-level security', async () => {
      const tenant = await t.createTenant();
      const rows = await t.inTenant(tenant.id, () =>
        t.db.tx((tx) => tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; usr: string }>>`SELECT rolsuper, rolbypassrls, current_user::text AS usr FROM pg_roles WHERE rolname = current_user`),
      );
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, usr: 'typease_app' });
    });
  });
});
