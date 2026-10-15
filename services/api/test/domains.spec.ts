import { BrandingService, DOMAIN_CLAIM_EXPIRY_DAYS, DOMAIN_CLAIM_RELEASE_HOURS, DOMAIN_CLEANUP_JOB } from '../src/modules/tenancy/branding.service';
import { TenantResolver } from '../src/modules/tenancy/tenant-resolver.service';
import { Actor, TenantFixture, TestApp, uniq } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('Custom domains: unverified claims, platform release and plan suspension', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let starter: TenantFixture;
  let admin: Actor;
  let agent: Actor;
  const fresh = () => `portal-${uniq()}.example.ae`;
  const claim = async (tenant: TenantFixture, domain: string) => (await t.as(tenant.owner).post('/domains', { domain }).expect(201)).body as { id: string; status: string; dns: { txt: { name: string; value: string } } };
  const age = (id: string, ms: number) => t.sys.tenantDomain.update({ where: { id }, data: { createdAt: new Date(Date.now() - ms) } });
  const verify = async (tenant: TenantFixture, domain: string) => {
    const added = await claim(tenant, domain);
    t.dns.records.set(added.dns.txt.name, [added.dns.txt.value]);
    expect((await t.as(tenant.owner).post(`/domains/${added.id}/verify`).expect(200)).body).toMatchObject({ verified: true, status: 'VERIFIED' });
    return added.id;
  };
  const resolves = async (domain: string) => {
    const [config, tls] = await Promise.all([t.http.get(`/api/v1/public/tenant-config?host=${domain}`), t.http.get(`/api/v1/internal/tls/ask?domain=${domain}`)]);
    expect([config.status, tls.status]).toEqual(config.status === 200 ? [200, 200] : [404, 404]);
    return config.status === 200 ? (config.body.tenantId as string) : null;
  };
  const setPlan = async (tenant: TenantFixture, key: string) => {
    const plan = await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key } });
    await t.sys.subscription.update({ where: { tenantId: tenant.id }, data: { planId: plan.id } });
  };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    starter = await t.createTenant({ plan: 'starter' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    await t.settle();
  });
  afterAll(() => t.close());

  describe('an unverified claim does not block another centre for ever', () => {
    it('blocks for 72 hours, then the next centre that claims the domain gets it', async () => {
      const domain = fresh();
      const first = await claim(alpha, domain);
      expect(first).toMatchObject({ status: 'PENDING', routed: false });
      const body = (await t.as(alpha.owner).get('/domains').expect(200)).body.domains.find((d: any) => d.id === first.id);
      expect(new Date(body.claim.releasableAt).getTime() - new Date(body.createdAt).getTime()).toBe(DOMAIN_CLAIM_RELEASE_HOURS * HOUR);
      expect(new Date(body.claim.expiresAt).getTime() - new Date(body.createdAt).getTime()).toBe(DOMAIN_CLAIM_EXPIRY_DAYS * DAY);

      // Fresh claim: nobody else can have it, and the answer does not say who holds it.
      const refused = await t.as(beta.owner).post('/domains', { domain }).expect(409);
      expect(refused.body.code).toBe('DOMAIN_IN_USE');
      expect(JSON.stringify(refused.body)).not.toMatch(/Alpha|alpha/);
      expect((await t.as(alpha.owner).post('/domains', { domain }).expect(409)).body.code).toBe('DOMAIN_ALREADY_ADDED');
      await age(first.id, 71 * HOUR);
      await t.as(beta.owner).post('/domains', { domain }).expect(409);

      // A centre whose plan has no custom domains cannot take anything over - and the claim is not released for it.
      await age(first.id, 73 * HOUR);
      expect((await t.as(starter.owner).post('/domains', { domain }).expect(402)).body.code).toBe('PLAN_LIMIT_REACHED');
      expect(await t.sys.tenantDomain.count({ where: { id: first.id } })).toBe(1);

      // Older than 72 hours and still unverified: released when somebody else claims the domain.
      const second = await t.as(beta.owner).post('/domains', { domain }).expect(201);
      expect(second.body).toMatchObject({ status: 'PENDING', tenantId: beta.id, domain });
      expect(second.body.id).not.toBe(first.id);
      expect(second.body.dns.txt.value).not.toBe(first.dns.txt.value);
      expect(await t.sys.tenantDomain.findMany({ where: { domain } })).toHaveLength(1);
      // Alpha no longer has it, and its old DNS token proves nothing for the new claim.
      expect((await t.as(alpha.owner).get('/domains').expect(200)).body.domains.map((d: any) => d.domain)).not.toContain(domain);
      await t.as(alpha.owner).post(`/domains/${first.id}/verify`).expect(404);
      t.dns.records.set(first.dns.txt.name, [first.dns.txt.value]);
      expect((await t.as(beta.owner).post(`/domains/${second.body.id}/verify`).expect(200)).body).toMatchObject({ verified: false, status: 'FAILED' });
      expect(await resolves(domain)).toBeNull();

      // Recorded where each centre can see it.
      const released = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'domain.claim_released', resourceId: first.id } });
      expect(released).toMatchObject({ actorType: 'SYSTEM', after: { reason: 'SUPERSEDED' }, before: { domain, status: 'PENDING' } });
      expect(released.summary).not.toMatch(/Beta|beta/);
      expect(await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: beta.id, action: 'domain.added', resourceId: second.body.id } })).toMatchObject({ after: { domain, replacedUnverifiedClaim: true } });

      // A claim whose check failed is unverified too.
      t.dns.records.delete(first.dns.txt.name);
      await age(second.body.id, 80 * HOUR);
      const third = await claim(alpha, domain);
      expect(third.status).toBe('PENDING');
      expect(await t.sys.auditLog.count({ where: { tenantId: beta.id, action: 'domain.claim_released', resourceId: second.body.id } })).toBe(1);
    });

    it('a verified domain stays exclusive however old it is', async () => {
      const domain = fresh();
      const id = await verify(alpha, domain);
      await age(id, 400 * DAY);
      expect((await t.as(beta.owner).post('/domains', { domain }).expect(409)).body.code).toBe('DOMAIN_IN_USE');
      await t.jobs.runScheduled(DOMAIN_CLEANUP_JOB);
      expect(await resolves(domain)).toBe(alpha.id);
      expect((await t.sys.tenantDomain.findUniqueOrThrow({ where: { id } })).status).toBe('VERIFIED');
    });

    it('two centres claiming the same released domain at the same moment: exactly one gets it', async () => {
      const gamma = await t.createTenant();
      for (let round = 0; round < 3; round++) {
        const domain = fresh();
        const stale = await claim(alpha, domain);
        await age(stale.id, 100 * HOUR);
        const results = await Promise.all([t.as(beta.owner).post('/domains', { domain }), t.as(gamma.owner).post('/domains', { domain })]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe('DOMAIN_IN_USE');
        const rows = await t.sys.tenantDomain.findMany({ where: { domain } });
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(results.find((r) => r.status === 201)!.body.tenantId);
        expect(rows[0].tenantId).not.toBe(alpha.id);
      }
    });

    it('the daily clean-up removes unverified claims older than 14 days and tells nobody', async () => {
      expect(t.jobs.schedules().find((s) => s.name === DOMAIN_CLEANUP_JOB)).toMatchObject({ cron: '10 3 * * *' });
      const old = await claim(alpha, fresh());
      const failed = await claim(alpha, fresh());
      await t.as(alpha.owner).post(`/domains/${failed.id}/verify`).expect(200);
      const young = await claim(alpha, fresh());
      const verifiedDomain = fresh();
      const verified = await verify(beta, verifiedDomain);
      await age(old.id, 14 * DAY + HOUR);
      await age(failed.id, 30 * DAY);
      await age(young.id, 13 * DAY);
      await age(verified, 60 * DAY);
      await t.settle();
      const notifications = await t.sys.notification.count();
      const mails = t.messenger.captured.length;

      await t.jobs.runScheduled(DOMAIN_CLEANUP_JOB);
      await t.settle();
      const left = (await t.sys.tenantDomain.findMany({ where: { id: { in: [old.id, failed.id, young.id, verified] } } })).map((d) => d.id).sort();
      expect(left).toEqual([young.id, verified].sort());
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'domain.claim_released', resourceId: { in: [old.id, failed.id] } } });
      expect(audit.map((a) => (a.after as any).reason)).toEqual(['EXPIRED', 'EXPIRED']);
      expect(await t.sys.notification.count()).toBe(notifications);
      expect(t.messenger.captured.length).toBe(mails);
      // Running it again changes nothing.
      expect(await t.get(BrandingService).cleanUpDomainClaims()).toEqual({ removed: 0 });
      expect(await resolves(verifiedDomain)).toBe(beta.id);
    });
  });

  describe('platform staff can release any claim', () => {
    it('needs the tenant-management permission and a reason; audited on both trails', async () => {
      const domain = fresh();
      const id = await verify(alpha, domain);
      expect(await resolves(domain)).toBe(alpha.id);

      // Finding it.
      const found = await t.as(agent).get(`/platform/domains?q=${domain.slice(0, 20)}`).expect(200);
      expect(found.body.data).toHaveLength(1);
      expect(found.body.data[0]).toMatchObject({ id, domain, status: 'VERIFIED', routed: true, centre: { id: alpha.id, slug: alpha.slug, name: 'Alpha Typing', planKey: 'enterprise' } });
      expect(JSON.stringify(found.body)).not.toContain('verificationToken');
      expect((await t.as(agent).get(`/platform/domains?centreId=${beta.id}&status=PENDING`).expect(200)).body.data.every((d: any) => d.centre.id === beta.id && d.status === 'PENDING')).toBe(true);

      // Who may not.
      await t.http.delete(`/api/v1/platform/domains/${id}`).send({ reason: 'Ownership dispute' }).expect(401);
      for (const actor of [alpha.owner, beta.owner, agent]) expect((await t.as(actor).delete(`/platform/domains/${id}`).send({ reason: 'Ownership dispute' })).status).toBe(403);
      await t.as(alpha.owner).get('/platform/domains').expect(403);
      await t.as(admin).delete(`/platform/domains/${id}`).send({}).expect(400);
      await t.as(admin).delete(`/platform/domains/${id}`).send({ reason: 'no' }).expect(400);
      expect(await resolves(domain)).toBe(alpha.id);

      const released = await t.as(admin).delete(`/platform/domains/${id}`).send({ reason: 'Ownership dispute: the registrant asked us to release it (ticket 4711)' }).expect(200);
      expect(released.body).toEqual({ id, domain, status: 'RELEASED' });
      expect(await t.sys.tenantDomain.count({ where: { id } })).toBe(0);
      // Takes effect at once: no routing, no certificate.
      expect(await resolves(domain)).toBeNull();
      await t.as(admin).delete(`/platform/domains/${id}`).send({ reason: 'Ownership dispute again' }).expect(404);

      const entries = await t.sys.auditLog.findMany({ where: { action: 'domain.released_by_platform', resourceId: id } });
      expect(entries.map((e) => e.tenantId).sort()).toEqual([alpha.id, null].sort());
      for (const e of entries) expect(e).toMatchObject({ actorUserId: admin.userId, actorType: 'PLATFORM', before: { domain, status: 'VERIFIED' }, after: { reason: 'Ownership dispute: the registrant asked us to release it (ticket 4711)' } });
      expect((await t.as(alpha.owner).get('/audit-logs?action=domain.released_by_platform').expect(200)).body.data.map((r: any) => r.resourceId)).toContain(id);

      // The domain is free for whoever proves ownership next; an unverified claim can be released the same way.
      const next = await claim(beta, domain);
      await t.as(admin).delete(`/platform/domains/${next.id}`).send({ reason: 'Claimed by mistake, asked by the centre' }).expect(200);
      expect(await t.sys.tenantDomain.count({ where: { domain } })).toBe(0);
    });
  });

  describe('a verified domain follows the plan', () => {
    it('stops resolving when the plan no longer includes custom domains and resumes when it does again', async () => {
      const tenant = await t.createTenant({ name: 'Plan Follower' });
      const domain = fresh();
      const id = await verify(tenant, domain);
      const resolver = t.get(TenantResolver);
      expect(await resolves(domain)).toBe(tenant.id);
      expect(await resolver.portalLink(tenant.id, '/requests')).toBe(`https://${domain}/requests`);
      expect(await resolver.isAllowedOrigin(`https://${domain}`)).toBe(true);

      // Downgrade. Answers are cached for 30 seconds; after that the domain is gone without anybody doing anything.
      await setPlan(tenant, 'starter');
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now');
      try {
        clock.mockReturnValue(now + 29_000);
        expect(await resolver.fromHost(domain)).toBe(tenant.id);
        clock.mockReturnValue(now + 31_000);
        expect(await resolver.fromHost(domain)).toBeNull();
      } finally {
        clock.mockRestore();
      }
      resolver.invalidate();
      expect(await resolves(domain)).toBeNull();
      expect(await resolver.isAllowedOrigin(`https://${domain}`)).toBe(false);
      // Links sent to customers do not point at a domain that does not answer.
      expect(await resolver.portalLink(tenant.id, '/requests')).toMatch(new RegExp(`/requests\\?tenant=${tenant.slug}$`));
      // The centre's own address keeps working.
      expect(await resolves(`${tenant.slug}.typease.test`)).toBe(tenant.id);

      // The settings screen says why, and the row is kept as it was.
      const list = await t.as(tenant.owner).get('/domains').expect(200);
      expect(list.body.customDomainsIncluded).toBe(false);
      expect(list.body.domains.find((d: any) => d.id === id)).toMatchObject({ domain, status: 'SUSPENDED_BY_PLAN', routed: false, isPrimary: true, dns: null, claim: null });
      expect(list.body.domains.find((d: any) => d.id === id).verifiedAt).toBeTruthy();
      expect((await t.sys.tenantDomain.findUniqueOrThrow({ where: { id } })).status).toBe('VERIFIED');
      expect((await t.as(agent).get(`/platform/domains?q=${domain}`).expect(200)).body.data[0]).toMatchObject({ status: 'SUSPENDED_BY_PLAN', routed: false, centre: { planKey: 'starter' } });
      // Checking the DNS again does not switch it back on, and no new domain can be added on this plan.
      expect((await t.as(tenant.owner).post(`/domains/${id}/verify`).expect(200)).body).toMatchObject({ verified: true, status: 'SUSPENDED_BY_PLAN', routed: false, message: expect.stringMatching(/when your plan includes custom domains/) });
      await t.as(tenant.owner).post('/domains', { domain: fresh() }).expect(402);
      expect(await resolves(domain)).toBeNull();
      // Suspended is not released: the domain still belongs to this centre.
      expect((await t.as(beta.owner).post('/domains', { domain }).expect(409)).body.code).toBe('DOMAIN_IN_USE');
      await t.jobs.runScheduled(DOMAIN_CLEANUP_JOB);
      expect(await t.sys.tenantDomain.count({ where: { id } })).toBe(1);

      // Upgrade again: it resolves again, nothing to verify again.
      await setPlan(tenant, 'enterprise');
      resolver.invalidate();
      expect(await resolves(domain)).toBe(tenant.id);
      expect((await t.as(tenant.owner).get('/domains').expect(200)).body.domains.find((d: any) => d.id === id)).toMatchObject({ status: 'VERIFIED', routed: true });
      expect(await resolver.portalLink(tenant.id, '/requests')).toBe(`https://${domain}/requests`);

      // No subscription at all counts as "not included".
      await t.sys.subscription.delete({ where: { tenantId: tenant.id } });
      resolver.invalidate();
      expect(await resolves(domain)).toBeNull();
    });
  });
});
