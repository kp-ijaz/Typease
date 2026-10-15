import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { fetchBytes, pdfBytes, pngBytes } from '../documents/fixtures';
import { createCustomer, createService, issueInvoice, recordPayment } from '../finance/fixtures';
import { StorageService } from '../storage/storage.service';
import { auditOf, supportSession, tenantRow } from './fixtures';
import { OFFBOARDING_JOB, OffboardingService } from './offboarding.service';

const DAY = 86_400_000;

/** Everything a working centre accumulates, created through the real API wherever that is practical. */
async function populate(t: TestApp, tenant: TenantFixture, marker: string) {
  const customer = await createCustomer(t, tenant, { fullName: `Customer ${marker}` });
  const portalUser = await t.addCustomer(tenant, { fullName: `Portal ${marker}` });
  const staff = await t.addStaff(tenant, 'accountant');
  const content = pdfBytes(marker);
  const upload = await t.as(tenant.owner).upload('/documents/upload', 'file', content, 'passport.pdf', { customerId: customer.id, documentTypeKey: 'passport', title: `Passport ${marker}` });
  if (upload.status !== 201) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(upload.body)}`);
  await t.settle();
  const link = await t.as(tenant.owner).post(`/documents/${upload.body.documentId}/download-link`).expect(200); // also writes a document access log
  const service = await createService(t, tenant);
  const request = await t.sys.serviceRequest.create({ data: { tenantId: tenant.id, branchId: tenant.headOfficeId, requestNo: `TE-${uniq()}`.toUpperCase(), customerId: customer.id, serviceId: service.id, status: 'SUBMITTED' } });
  await t.sys.requestStatusHistory.create({ data: { tenantId: tenant.id, requestId: request.id, fromStatus: 'DRAFT', toStatus: 'SUBMITTED', actorType: 'STAFF' } });
  const invoice = await issueInvoice(t, tenant.owner, customer.id, { requestId: request.id });
  await recordPayment(t, tenant.owner, { method: 'CASH', amount: invoice.total, branchId: tenant.headOfficeId, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] }).expect(201);
  await t.as(tenant.owner).post('/integrations', { category: 'EMAIL', provider: 'smtp', config: { host: `smtp.${marker}.example.ae` }, secrets: { user: 'u', password: `secret-${marker}` } }).expect(201);
  await t.as(tenant.owner).post('/support/platform-tickets', { subject: `Ticket ${marker}`, message: 'Please help us with the export.' }).expect(201);
  const logo = await t.as(tenant.owner).upload('/branding/logo', 'file', pngBytes(), 'logo.png');
  if (logo.status >= 300) throw new Error(`logo upload failed: ${logo.status} ${JSON.stringify(logo.body)}`);
  const domain = await t.sys.tenantDomain.create({ data: { tenantId: tenant.id, domain: `portal-${uniq()}.example.ae`, verificationToken: 'tok', status: 'VERIFIED', isPrimary: true, verifiedAt: new Date() } });
  await t.settle();
  const version = await t.sys.documentVersion.findFirstOrThrow({ where: { tenantId: tenant.id, documentId: upload.body.documentId } });
  const branding = await t.sys.brandingSettings.findFirstOrThrow({ where: { tenantId: tenant.id, branchId: null } });
  return { customer, portalUser, staff, content, documentId: upload.body.documentId as string, downloadUrl: link.body.url as string, storageKey: version.storageKey, invoice, request, domain, logoKey: branding.logoAssetKey! };
}

describe('Platform: controlled offboarding and purge', () => {
  let t: TestApp;
  let admin: Actor;
  let agent: Actor;
  let gamma: TenantFixture;
  let keep: TenantFixture;
  let gammaData: Awaited<ReturnType<typeof populate>>;
  let keepData: Awaited<ReturnType<typeof populate>>;
  let tenantTables: string[];
  /** A person who works at both centres: must survive the purge of one of them. */
  let shared: { email: string; userId: string };

  /** Rows per table for one centre, straight from the database (every table that has a tenantId column). */
  const census = async (tenantId: string): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of tenantTables) {
      const rows = await t.sys.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1::uuid`, tenantId);
      const n = Number(rows[0].n);
      if (n) out[table] = n;
    }
    return out;
  };
  const offboard = (tenant: TenantFixture, body: Record<string, unknown> = {}) => t.as(admin).post(`/platform/tenants/${tenant.id}/offboard`, { confirmSlug: tenant.slug, reason: 'Centre closed and asked for its data to be deleted.', ...body });

  beforeAll(async () => {
    t = await TestApp.create();
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    gamma = await t.createTenant({ name: 'Gamma Typing (to be deleted)' });
    keep = await t.createTenant({ name: 'Keep Typing (must stay)' });
    gammaData = await populate(t, gamma, 'gammadata');
    keepData = await populate(t, keep, 'keepdata');
    tenantTables = (
      await t.sys.$queryRaw<Array<{ name: string }>>`
        SELECT c.relname::text AS name FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'tenantId' AND NOT a.attisdropped ORDER BY 1`
    ).map((r) => r.name);
    // keep's owner is also a manager at gamma.
    const invite = await t.as(gamma.owner).post('/staff/invitations', { email: keep.owner.email, fullName: 'Shared Person', roleKey: 'manager', allBranches: true, branchIds: [] }).expect(201);
    await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.body.dev.invitationToken, app: 'centre' }).expect(200);
    shared = { email: keep.owner.email, userId: keep.owner.userId };
    await t.sys.securityIncident.create({ data: { tenantId: gamma.id, title: 'Misdirected email', description: 'An invoice was emailed to the wrong address.' } });
    await t.sys.featureFlag.create({ data: { key: `purge_test_${uniq()}`, tenantId: gamma.id, enabled: true } });
  }, 120_000);
  afterAll(async () => {
    await t.sys.platformSetting.deleteMany({ where: { key: 'offboarding.policy' } });
    await t.close();
  });

  it('only a Super Admin can offboard, and only with the typed confirmation', async () => {
    for (const actor of [agent, gamma.owner, keep.owner]) {
      await t.as(actor).post(`/platform/tenants/${gamma.id}/offboard`, { confirmSlug: gamma.slug, reason: 'I would like to delete this centre' }).expect(403);
      await t.as(actor).post(`/platform/tenants/${gamma.id}/cancel-offboarding`, { reason: 'Nothing to cancel' }).expect(403);
    }
    expect((await offboard(gamma, { confirmSlug: keep.slug }).expect(422)).body.code).toBe('CONFIRMATION_MISMATCH');
    expect((await offboard(gamma, { confirmSlug: gamma.name }).expect(422)).body.code).toBe('CONFIRMATION_MISMATCH');
    await offboard(gamma, { reason: 'too short' }).expect(400);
    // At least 30 days, unless explicitly immediate with a second confirmation.
    const tooSoon = await offboard(gamma, { purgeAfterDays: 29 }).expect(400);
    expect(JSON.stringify(tooSoon.body.details)).toMatch(/at least 30 days/);
    await offboard(gamma, { purgeAfterDays: 0 }).expect(400);
    expect((await offboard(gamma, { immediate: true }).expect(422)).body.code).toBe('IMMEDIATE_CONFIRMATION_REQUIRED');
    expect((await offboard(gamma, { immediate: true, confirmImmediate: `PURGE ${keep.slug}` }).expect(422)).body.code).toBe('IMMEDIATE_CONFIRMATION_REQUIRED');
    // The platform can require a longer waiting time, never a shorter one.
    await t.as(admin).put('/platform/settings/offboarding.policy', { value: { minPurgeDelayDays: 60 } }).expect(200);
    expect((await offboard(gamma, { purgeAfterDays: 45 }).expect(422)).body).toMatchObject({ code: 'PURGE_DELAY_TOO_SHORT', details: { minPurgeDelayDays: 60 } });
    await t.as(admin).delete('/platform/settings/offboarding.policy').expect(200);
    await offboard({ ...gamma, id: '6f1c3c9e-2a54-4d0b-9d3e-8b1c5a7f0e11' } as TenantFixture).expect(404);
    expect(await tenantRow(t, gamma.id)).toMatchObject({ status: 'ACTIVE', offboardingAt: null });
    expect((await t.as(admin).post(`/platform/tenants/${gamma.id}/cancel-offboarding`, { reason: 'Nothing is scheduled' }).expect(409)).body.code).toBe('OFFBOARDING_NOT_SCHEDULED');
  });

  it('scheduling archives the centre, signs everybody out and disables its domains; nothing is deleted yet', async () => {
    const support = await supportSession(t, agent, gamma, ['customer.read']);
    const pendingGrant = await t.sys.accessGrant.create({ data: { tenantId: gamma.id, requestedById: admin.userId, reason: 'A second, unanswered request', scopes: ['customer.read'] } });
    const before = await census(gamma.id);
    const started = Date.now();
    const res = await offboard(gamma, { purgeAfterDays: 45 }).expect(200);
    expect(res.body).toMatchObject({ status: 'ARCHIVED', subscription: { status: 'CANCELLED' }, offboarding: { immediate: false, dataExport: 'NOT_AUTOMATIC', reason: 'Centre closed and asked for its data to be deleted.' } });
    const purgeAt = new Date(res.body.offboarding.purgeAt).getTime();
    expect(purgeAt).toBeGreaterThanOrEqual(started + 45 * DAY - 2000);
    expect(purgeAt).toBeLessThanOrEqual(Date.now() + 45 * DAY);
    const row = await tenantRow(t, gamma.id);
    expect(row.offboardingAt!.getTime()).toBe(purgeAt);
    expect(row.archivedAt).toBeTruthy();

    // Every session of the centre is gone: staff, customers and TypEase support.
    await t.as(gamma.owner).get('/tenant').expect(401);
    await t.as(gammaData.portalUser).get('/feature-flags').expect(401);
    await t.as(gammaData.staff).get('/invoices').expect(401);
    await t.as(support.support).get('/customers').expect(401);
    expect(await t.sys.session.count({ where: { tenantId: gamma.id, revokedAt: null } })).toBe(0);
    expect((await t.http.post('/api/v1/auth/login').send({ email: gamma.owner.email, password: PASSWORD, app: 'centre' })).status).toBe(403);
    // Open support access is closed, the domains no longer resolve.
    expect((await t.sys.accessGrant.findMany({ where: { tenantId: gamma.id, id: { in: [support.grantId, pendingGrant.id] } } })).map((g) => g.status)).toEqual(['REVOKED', 'REVOKED']);
    expect(await t.sys.tenantDomain.findUniqueOrThrow({ where: { id: gammaData.domain.id } })).toMatchObject({ status: 'DISABLED', isPrimary: false });
    // The other centre is not signed out.
    await t.as(keep.owner).get('/tenant').expect(200);

    // Recorded on both trails, with the date.
    const audit = await auditOf(t, 'tenant.offboarding_scheduled', gamma.id);
    expect(audit.platform).toHaveLength(1);
    expect(audit.platform[0]).toMatchObject({ actorUserId: admin.userId });
    expect(audit.centre[0].after).toMatchObject({ status: 'ARCHIVED', immediate: false, domainsDisabled: 1, accessGrantsRevoked: 2 });
    expect(await t.sys.securityEvent.count({ where: { tenantId: gamma.id, type: 'TENANT_OFFBOARDING_SCHEDULED', severity: 'HIGH' } })).toBe(1);
    expect((await t.as(admin).get('/platform/tenants?offboarding=true&pageSize=100').expect(200)).body.data.map((r: any) => r.id)).toContain(gamma.id);
    const detail = await t.as(admin).get(`/platform/tenants/${gamma.id}`).expect(200);
    expect(detail.body.offboarding).toMatchObject({ reason: 'Centre closed and asked for its data to be deleted.', scheduledBy: 'Platform SUPER_ADMIN' });
    expect(new Date(detail.body.offboarding.purgeAt).getTime()).toBe(purgeAt);
    expect((await t.as(admin).get(`/platform/tenants/${keep.id}`).expect(200)).body.offboarding).toBeNull();

    // Not a single business row was removed, and the files are still there.
    const after = await census(gamma.id);
    for (const table of ['customers', 'documents', 'document_versions', 'invoices', 'invoice_items', 'payments', 'payment_allocations', 'service_requests', 'tenant_memberships', 'integration_credentials_metadata']) {
      expect([table, after[table]]).toEqual([table, before[table]]);
    }
    expect(await t.get(StorageService).head(gammaData.storageKey)).not.toBeNull();
    // The nightly job leaves it alone until the date.
    await t.jobs.runScheduled(OFFBOARDING_JOB);
    expect((await tenantRow(t, gamma.id)).status).toBe('ARCHIVED');
    expect(await t.sys.customer.count({ where: { tenantId: gamma.id } })).toBe(before.customers);

    expect((await offboard(gamma).expect(409)).body.code).toBe('OFFBOARDING_SCHEDULED');
    expect((await t.as(admin).post(`/platform/tenants/${gamma.id}/reactivate`, {}).expect(409)).body.code).toBe('OFFBOARDING_SCHEDULED');
  });

  it('can be cancelled before the date; the centre stays archived until it is reactivated', async () => {
    await t.as(admin).post(`/platform/tenants/${gamma.id}/cancel-offboarding`, { reason: 'no' }).expect(400);
    const res = await t.as(admin).post(`/platform/tenants/${gamma.id}/cancel-offboarding`, { reason: 'The owner changed their mind before the deadline.' }).expect(200);
    expect(res.body).toMatchObject({ status: 'ARCHIVED', offboardingAt: null });
    // Domains have to prove ownership again.
    expect(await t.sys.tenantDomain.findUniqueOrThrow({ where: { id: gammaData.domain.id } })).toMatchObject({ status: 'PENDING', verifiedAt: null });
    expect((await auditOf(t, 'tenant.offboarding_cancelled', gamma.id)).centre[0].after).toMatchObject({ purgeAt: null, domainsToVerifyAgain: 1 });
    await t.jobs.runScheduled(OFFBOARDING_JOB);
    expect((await tenantRow(t, gamma.id)).status).toBe('ARCHIVED');
    const back = await t.as(admin).post(`/platform/tenants/${gamma.id}/reactivate`, {}).expect(200);
    expect(back.body.status).toBe('CANCELLED'); // its subscription was ended; the owner has to subscribe again
    await t.login(gamma.owner.email);
  });

  it('after the date the job deletes the centre completely and leaves every other centre untouched', async () => {
    await offboard(gamma).expect(200);
    const gammaBefore = await census(gamma.id);
    const keepBefore = await census(keep.id);
    // Append-only and immutable records exist for this centre: they are exactly what the purge has to get past.
    for (const table of ['audit_logs', 'consent_records', 'document_access_logs', 'request_status_history', 'payment_allocations', 'liability_entries', 'invoices', 'payments', 'security_events', 'outbox_events', 'sessions', 'auth_tokens', 'login_activity', 'subscription_events', 'security_incidents', 'feature_flags']) {
      expect([table, (gammaBefore[table] ?? 0) > 0]).toEqual([table, true]);
    }
    const gammaOnlyUsers = [gamma.owner.userId, gammaData.portalUser.userId, gammaData.staff.userId];
    expect(await t.sys.user.count({ where: { id: { in: gammaOnlyUsers } } })).toBe(3);
    expect((await t.http.get(`/api/v1/public/assets/${gammaData.logoKey}`)).status).toBe(200);
    const usersBefore = await t.sys.user.count();
    const tenantsBefore = await t.sys.tenant.count();

    // The date passes.
    await t.sys.tenant.update({ where: { id: gamma.id }, data: { offboardingAt: new Date(Date.now() - 60_000) } });
    expect((await t.as(admin).post(`/platform/tenants/${gamma.id}/cancel-offboarding`, { reason: 'Too late to change our mind' }).expect(409)).body.code).toBe('OFFBOARDING_DUE');
    await t.jobs.runScheduled(OFFBOARDING_JOB);

    // --- gone
    expect(await t.sys.tenant.findUnique({ where: { id: gamma.id } })).toBeNull();
    expect(await t.sys.tenant.count()).toBe(tenantsBefore - 1);
    // The only rows that still mention the centre are the platform's own incident register.
    expect(await census(gamma.id)).toEqual({ security_incidents: 1 });
    expect(await t.sys.user.count({ where: { id: { in: gammaOnlyUsers } } })).toBe(0);
    expect(await t.sys.user.count()).toBe(usersBefore - 3);
    expect(await t.sys.session.count({ where: { userId: { in: gammaOnlyUsers } } })).toBe(0);
    expect(await t.sys.loginActivity.count({ where: { userId: { in: gammaOnlyUsers } } })).toBe(0);
    // Files: the stored document and the logo.
    const storage = t.get(StorageService);
    expect(await storage.head(gammaData.storageKey)).toBeNull();
    expect((await fetchBytes(t, gammaData.downloadUrl)).status).not.toBe(200);
    expect((await t.http.get(`/api/v1/public/assets/${gammaData.logoKey}`)).status).toBe(404);
    // Nobody can sign in, the slug no longer resolves, the admin API answers "not found".
    expect((await t.http.post('/api/v1/auth/login').send({ email: gamma.owner.email, password: PASSWORD, app: 'centre' })).status).toBe(401);
    await t.as(admin).get(`/platform/tenants/${gamma.id}`).expect(404);
    await t.http.post('/api/v1/auth/register').send({ tenantSlug: gamma.slug, fullName: 'Late Customer', email: `late-${uniq()}@example.test`, password: PASSWORD, acceptTerms: true }).expect(404);

    // --- the other centre: every table has exactly the rows it had, and everything still works
    const keepAfter = await census(keep.id);
    // The shared person lost one membership at gamma, never anything at "keep"; the sign-in below adds activity rows.
    expect(keepAfter).toEqual(keepBefore);
    expect(await t.sys.user.findUnique({ where: { id: shared.userId } })).not.toBeNull();
    const sharedNow = await t.login(shared.email);
    expect((await t.as(sharedNow).get('/tenant').expect(200)).body.id).toBe(keep.id);
    expect((await t.as(sharedNow).get(`/customers/${keepData.customer.id}`).expect(200)).body.fullName).toBe('Customer keepdata');
    expect((await t.as(sharedNow).get(`/invoices/${keepData.invoice.id}`).expect(200)).body).toMatchObject({ status: 'PAID' });
    const link = await t.as(sharedNow).post(`/documents/${keepData.documentId}/download-link`).expect(200);
    expect((await fetchBytes(t, link.body.url)).body.equals(keepData.content)).toBe(true);
    expect((await t.http.get(`/api/v1/public/assets/${keepData.logoKey}`)).status).toBe(200);
    // Platform staff and platform data are untouched.
    await t.as(admin).get('/platform/tenants').expect(200);
    expect(await t.sys.subscriptionPlan.count()).toBeGreaterThanOrEqual(4);

    // --- the permission to delete protected rows did not outlive the purge transaction
    const keepAudit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: keep.id } });
    await expect(t.sys.auditLog.delete({ where: { id: keepAudit.id } })).rejects.toThrow(/append-only/);
    await expect(t.sys.payment.deleteMany({ where: { tenantId: keep.id } })).rejects.toThrow(/never deleted/);
    await expect(t.sys.invoice.delete({ where: { id: keepData.invoice.id } })).rejects.toThrow(/issued and cannot be deleted/);

    // --- what remains: one platform audit entry describing what was deleted
    const purged = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: null, action: 'tenant.purged', resourceId: gamma.id } });
    expect(purged.summary).toContain(gamma.slug);
    const after = purged.after as any;
    expect(after).toMatchObject({ slug: gamma.slug, name: 'Gamma Typing (to be deleted)', usersDeleted: 3, kept: ['security_incidents'], publicAssets: 1 });
    expect(after.storageObjects).toBeGreaterThanOrEqual(1);
    expect(after.rows.customers).toBe(gammaBefore.customers);
    expect(after.rows.audit_logs).toBe(gammaBefore.audit_logs);
    expect(after.rows.payments).toBe(1);
    expect(after.rows.invoices).toBe(1);
    expect(after.rows).not.toHaveProperty('security_incidents');
    // Earlier platform entries about the centre (scheduling, cancelling) are kept as well.
    expect(await t.sys.auditLog.count({ where: { tenantId: null, resourceId: gamma.id, action: { startsWith: 'tenant.offboarding_' } } })).toBe(3);

    // Running the job again finds nothing to do.
    await t.jobs.runScheduled(OFFBOARDING_JOB);
    expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'tenant.purged', resourceId: gamma.id } })).toBe(1);
    expect(await t.sys.customer.count({ where: { tenantId: keep.id } })).toBe(keepBefore.customers);
  });

  it('immediate offboarding needs the second confirmation and is carried out by the queue straight away', async () => {
    const doomed = await t.createTenant({ name: 'Immediate Typing' });
    await createCustomer(t, doomed, { fullName: 'Short Lived' });
    const res = await offboard(doomed, { immediate: true, confirmImmediate: `PURGE ${doomed.slug}`, purgeAfterDays: 0 }).expect(200);
    expect(res.body.offboarding).toMatchObject({ immediate: true });
    // Still there until the queued job has run ...
    expect(await t.sys.tenant.findUnique({ where: { id: doomed.id } })).not.toBeNull();
    await t.settle();
    // ... then gone.
    expect(await t.sys.tenant.findUnique({ where: { id: doomed.id } })).toBeNull();
    expect(await t.sys.customer.count({ where: { tenantId: doomed.id } })).toBe(0);
    expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'tenant.purged', resourceId: doomed.id } })).toBe(1);
  });

  it('a failed purge leaves the centre intact for the next run and does not stop the others', async () => {
    const first = await t.createTenant({ name: 'Purge Fails Once' });
    const second = await t.createTenant({ name: 'Purge Works' });
    await createCustomer(t, first);
    for (const tenant of [first, second]) {
      await offboard(tenant).expect(200);
      await t.sys.tenant.update({ where: { id: tenant.id }, data: { offboardingAt: new Date(Date.now() - 1000) } });
    }
    const storage = t.get(StorageService);
    const real = storage.deleteTenantObjects.bind(storage);
    const spy = jest.spyOn(storage, 'deleteTenantObjects').mockImplementation(async (tenantId: string) => {
      if (tenantId === first.id) throw new Error('object store unavailable');
      return real(tenantId);
    });
    try {
      const result = await t.get(OffboardingService).runDue();
      expect(result.failed).toEqual([{ tenantId: first.id, error: 'object store unavailable' }]);
      expect(result.purged.map((p) => p.tenantId)).toEqual([second.id]);
    } finally {
      spy.mockRestore();
    }
    // Nothing of the failed centre was deleted (files first, rows only afterwards).
    expect(await t.sys.tenant.findUnique({ where: { id: first.id } })).not.toBeNull();
    expect(await t.sys.customer.count({ where: { tenantId: first.id } })).toBe(1);
    expect(await t.sys.securityEvent.count({ where: { tenantId: first.id, type: 'TENANT_PURGE_FAILED', severity: 'HIGH' } })).toBe(1);
    expect(await t.sys.tenant.findUnique({ where: { id: second.id } })).toBeNull();
    // The next run completes it.
    const retry = await t.get(OffboardingService).runDue();
    expect(retry.purged.map((p) => p.tenantId)).toEqual([first.id]);
    expect(await t.sys.tenant.findUnique({ where: { id: first.id } })).toBeNull();
  });
});
