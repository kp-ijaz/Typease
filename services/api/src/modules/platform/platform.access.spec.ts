import { createHash } from 'node:crypto';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { fetchBytes, pdfBytes } from '../documents/fixtures';
import { createCustomer } from '../finance/fixtures';
import { ACCESS_EXPIRY_JOB } from './access-grants.service';
import { requestAccess, supportSession } from './fixtures';
import { SUPPORT_ACCESS_POLICY_KEY } from './settings.service';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('Platform: time-limited support access', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let agent: Actor;
  let otherAgent: Actor;
  let customerId: string;
  let documentId: string;
  const content = pdfBytes('support-access-test');

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    admin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    otherAgent = await t.createPlatformAdmin('SUPPORT_AGENT');
    const customer = await createCustomer(t, alpha, { fullName: 'Mariam Al Hashimi' });
    customerId = customer.id;
    const upload = await t.as(alpha.owner).upload('/documents/upload', 'file', content, 'passport.pdf', { customerId, documentTypeKey: 'passport', title: 'Passport copy' });
    if (upload.status !== 201) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(upload.body)}`);
    documentId = upload.body.documentId;
    await t.settle();
  });
  afterAll(() => t.close());

  /** Withdraws whatever the staff member still has open for a centre, so each test starts clean. */
  const closeOpen = async (staff: Actor, tenant: TenantFixture) => {
    const open = await t.sys.accessGrant.findMany({ where: { requestedById: staff.userId, tenantId: tenant.id, status: { in: ['REQUESTED', 'APPROVED'] } } });
    for (const g of open) await t.as(staff).post(`/platform/access-grants/${g.id}/revoke`).expect(200);
  };

  it('without a grant, platform staff - even a Super Admin - cannot reach any tenant route', async () => {
    for (const staff of [admin, agent]) {
      for (const path of ['/customers', `/customers/${customerId}`, '/documents', `/documents/${documentId}`, '/invoices', '/audit-logs', '/branches', '/tenant', '/support-access']) {
        const res = await t.as(staff).get(path);
        expect([path, res.status]).toEqual([path, 403]);
      }
      expect((await t.as(staff).post(`/documents/${documentId}/download-link`)).status).toBe(403);
    }
    expect((await t.as(admin).get('/customers')).body.code).toBe('TENANT_REQUIRED');
  });

  it('only read-level permissions can be requested, with a reason and a bounded duration', async () => {
    const ask = (body: Record<string, unknown>, staff: Actor = agent, tenantId = alpha.id) => t.as(staff).post(`/platform/tenants/${tenantId}/access-grants`, { reason: 'Customer reports a missing invoice PDF', scopes: ['customer.read'], durationMinutes: 30, ...body });
    await ask({ reason: 'too short' }).expect(400);
    await ask({ scopes: [] }).expect(400);
    await ask({ durationMinutes: 4 }).expect(400);
    await ask({ durationMinutes: 1441 }).expect(400);
    for (const scope of ['customer.create', 'customer.update', 'invoice.manage', 'refund.approve', 'role.manage', 'document.delete', 'support_access.decide', 'customer.sensitive.read', 'platform.tenants.manage', 'made.up']) {
      const res = await ask({ scopes: ['customer.read', scope] }).expect(422);
      expect(res.body).toMatchObject({ code: 'SCOPE_NOT_GRANTABLE', details: { invalid: [scope] } });
    }
    expect((await ask({}, agent, '6f1c3c9e-2a54-4d0b-9d3e-8b1c5a7f0e11').expect(404)).body.code).toBe('NOT_FOUND');
    // Only platform staff can ask; a centre cannot grant itself anything this way.
    await ask({}, alpha.owner).expect(403);
    // The platform can lower the maximum duration.
    await t.as(admin).put(`/platform/settings/${SUPPORT_ACCESS_POLICY_KEY}`, { value: { maxDurationMinutes: 20 } }).expect(200);
    expect((await ask({ durationMinutes: 30 }).expect(422)).body).toMatchObject({ code: 'DURATION_TOO_LONG', details: { maxDurationMinutes: 20 } });
    await t.as(admin).delete(`/platform/settings/${SUPPORT_ACCESS_POLICY_KEY}`).expect(200);
    // A ticket link must be a platform ticket of the same centre.
    const betaTicket = await t.as(beta.owner).post('/support/platform-tickets', { subject: 'Invoice PDF is blank', message: 'Since yesterday the invoice PDF shows no lines.' }).expect(201);
    expect((await ask({ ticketId: betaTicket.body.id }).expect(422)).body.code).toBe('TICKET_NOT_FOUND');
    expect(await t.sys.accessGrant.count({ where: { tenantId: alpha.id } })).toBe(0);
  });

  it('a request by itself gives no access: the centre has to approve it', async () => {
    const ticket = await t.as(alpha.owner).post('/support/platform-tickets', { subject: 'Customer list loads slowly', message: 'The customer list takes ten seconds to open.' }).expect(201);
    const grant = await requestAccess(t, agent, alpha, ['customer.read'], { ticketId: ticket.body.id });
    expect(grant).toMatchObject({ status: 'REQUESTED', scopes: ['customer.read'], durationMinutes: 30, ticketId: ticket.body.id, usable: false, startsAt: null, expiresAt: null, centre: { id: alpha.id, slug: alpha.slug } });
    expect(grant.requestedByName).toBe('Platform SUPPORT_AGENT');
    expect((await t.as(agent).post(`/platform/tenants/${alpha.id}/access-grants`, { reason: 'Asking a second time for the same', scopes: ['customer.read'] }).expect(409)).body.code).toBe('ACCESS_ALREADY_OPEN');
    expect((await t.as(agent).post(`/platform/access-grants/${grant.id}/enter`).expect(409)).body.code).toBe('ACCESS_NOT_APPROVED');
    await t.as(agent).get('/customers').expect(403);
    // Recorded on the centre's audit trail and as a security event.
    const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'support_access.requested', resourceId: grant.id } });
    expect(audit).toMatchObject({ actorUserId: agent.userId, actorType: 'PLATFORM', supportGrantId: grant.id });
    expect(await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'SUPPORT_ACCESS_REQUESTED' } })).toBe(1);

    // The centre's side.
    const manager = await t.addStaff(alpha, 'manager');
    const customer = await t.addCustomer(alpha);
    for (const actor of [manager, customer, agent]) {
      await t.as(actor).get('/support-access').expect(403);
      await t.as(actor).post(`/support-access/${grant.id}/approve`, {}).expect(403);
    }
    const list = await t.as(alpha.owner).get('/support-access').expect(200);
    expect(list.body.pending).toBe(1);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: grant.id, status: 'REQUESTED', requestedByName: 'Platform SUPPORT_AGENT', reason: 'Investigating support ticket about missing invoices', durationMinutes: 30, active: false, ticketId: ticket.body.id });
    expect(list.body.data[0].scopes).toEqual([{ key: 'customer.read', description: 'View customers (identity numbers masked)', write: false }]);
    expect((await t.as(alpha.owner).get('/support-access?status=APPROVED').expect(200)).body.data).toEqual([]);

    // Another centre's owner neither sees nor decides it.
    expect((await t.as(beta.owner).get('/support-access').expect(200)).body).toMatchObject({ data: [], pending: 0 });
    await t.as(beta.owner).get(`/support-access/${grant.id}`).expect(404);
    await t.as(beta.owner).post(`/support-access/${grant.id}/approve`, {}).expect(404);
    await t.as(beta.owner).post(`/support-access/${grant.id}/deny`, {}).expect(404);
    await t.as(beta.owner).post(`/support-access/${grant.id}/revoke`, {}).expect(404);
    expect((await t.sys.accessGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe('REQUESTED');
    await t.as(agent).get('/customers').expect(403);

    // Denied: nothing was ever accessible.
    const denied = await t.as(alpha.owner).post(`/support-access/${grant.id}/deny`, { note: 'Please call us first.' }).expect(200);
    expect(denied.body).toMatchObject({ status: 'DENIED', decisionNote: 'Please call us first.', active: false });
    expect((await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, {}).expect(409)).body.code).toBe('ACCESS_ALREADY_DECIDED');
    expect((await t.as(agent).post(`/platform/access-grants/${grant.id}/enter`).expect(403)).body).toMatchObject({ code: 'SUPPORT_ACCESS_ENDED', message: 'The centre denied this request.' });
    expect((await t.as(agent).get(`/platform/access-grants/${grant.id}`).expect(200)).body).toMatchObject({ status: 'DENIED', decisionNote: 'Please call us first.', decidedByName: expect.stringContaining('Owner') });
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'support_access.denied', resourceId: grant.id, actorUserId: alpha.owner.userId } })).toBe(1);
  });

  it('approval starts the clock; the session gets exactly the granted scopes and never a write permission', async () => {
    const grant = await requestAccess(t, agent, alpha, ['customer.read', 'branch.read'], { durationMinutes: 45 });
    const before = Date.now();
    const approved = await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, { note: 'OK until lunch.' }).expect(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', active: true, durationMinutes: 45, decisionNote: 'OK until lunch.', decidedById: alpha.owner.userId });
    const starts = new Date(approved.body.startsAt).getTime();
    expect(starts).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(approved.body.expiresAt).getTime() - starts).toBe(45 * 60_000);
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'support_access.approved', resourceId: grant.id, actorUserId: alpha.owner.userId } })).toBe(1);
    expect(await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'SUPPORT_ACCESS_APPROVED', userId: alpha.owner.userId } })).toBeGreaterThanOrEqual(1);

    // Only the person who asked can enter.
    await t.as(otherAgent).post(`/platform/access-grants/${grant.id}/enter`).expect(404);
    await t.as(admin).post(`/platform/access-grants/${grant.id}/enter`).expect(404);
    await t.as(alpha.owner).post(`/platform/access-grants/${grant.id}/enter`).expect(403);
    const entered = await t.as(agent).post(`/platform/access-grants/${grant.id}/enter`).expect(200);
    expect(entered.body.grant).toMatchObject({ id: grant.id, scopes: ['customer.read', 'branch.read'] });
    const support: Actor = { ...agent, token: entered.body.accessToken };
    const me = await t.as(support).get('/auth/me').expect(200);
    expect(me.body).toMatchObject({ tenant: { id: alpha.id }, membership: null, supportGrant: { id: grant.id, expiresAt: approved.body.expiresAt } });
    expect(me.body.permissions.sort()).toEqual(['branch.read', 'customer.read']);

    // Granted scopes work ...
    const customers = await t.as(support).get('/customers').expect(200);
    expect(customers.body.data.map((c: any) => c.id)).toContain(customerId);
    await t.as(support).get(`/customers/${customerId}`).expect(200);
    await t.as(support).get('/branches').expect(200);
    // ... nothing else does: no documents, no finance, no writes, no administration.
    await t.as(support).get('/documents').expect(403);
    await t.as(support).get(`/documents/${documentId}`).expect(403);
    await t.as(support).post(`/documents/${documentId}/download-link`).expect(403);
    await t.as(support).post(`/documents/${documentId}/preview-link`).expect(403);
    await t.as(support).get('/invoices').expect(403);
    await t.as(support).get('/audit-logs').expect(403);
    await t.as(support).post('/customers', { fullName: 'Created By Support', phone: '+971501112233' }).expect(403);
    await t.as(support).patch(`/customers/${customerId}`, { fullName: 'Renamed By Support' }).expect(403);
    await t.as(support).get(`/customers/${customerId}/identity`).expect(403);
    await t.as(support).post('/branches', { code: 'SUP', name: 'Support Branch' }).expect(403);
    await t.as(support).patch('/tenant', { name: 'Renamed' }).expect(403);
    await t.as(support).get('/integrations').expect(403);
    await t.as(support).get('/roles').expect(403);
    // It cannot approve, extend or see its own access from inside the centre.
    await t.as(support).get('/support-access').expect(403);
    await t.as(support).post(`/support-access/${grant.id}/approve`, {}).expect(403);
    // A support session is bound to that one centre: it is not a platform session ...
    expect((await t.as(support).get('/platform/tenants').expect(403)).body.code).toBe('PLATFORM_ONLY');
    // ... and it sees nothing of another centre.
    const betaCustomer = await createCustomer(t, beta, { fullName: 'Beta Person' });
    await t.as(support).get(`/customers/${betaCustomer.id}`).expect(404);
    expect((await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } })).fullName).toBe('Mariam Al Hashimi');

    // Entering is on the centre's trail with the grant id, and a security event.
    const entry = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'support_access.entered' } });
    expect(entry).toMatchObject({ supportGrantId: grant.id, actorUserId: agent.userId, actorType: 'PLATFORM', resourceId: grant.id });
    expect(await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'SUPPORT_ACCESS_ENTERED', userId: agent.userId } })).toBe(1);
    // The platform side shows it as usable; the owner sees it as active.
    expect((await t.as(agent).get(`/platform/access-grants/${grant.id}`).expect(200)).body).toMatchObject({ status: 'APPROVED', usable: true });
    expect((await t.as(alpha.owner).get(`/support-access/${grant.id}`).expect(200)).body.active).toBe(true);
    expect((await t.as(admin).get(`/platform/tenants/${alpha.id}`).expect(200)).body.support.activeAccessGrants).toBe(1);

    // The centre revokes: the SAME access token stops working on the very next request.
    const revoked = await t.as(alpha.owner).post(`/support-access/${grant.id}/revoke`, { note: 'Done, thank you.' }).expect(200);
    expect(revoked.body).toMatchObject({ status: 'REVOKED', active: false });
    expect(revoked.body.revokedAt).toBeTruthy();
    const after = await t.as(support).get('/customers').expect(401);
    // The revocation also closed the session that was opened under the grant.
    expect(after.body.code).toBe('SESSION_EXPIRED');
    await t.as(support).get('/auth/me').expect(401);
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: entered.body.refreshToken }).expect(401);
    expect((await t.as(agent).post(`/platform/access-grants/${grant.id}/enter`).expect(403)).body.code).toBe('SUPPORT_ACCESS_ENDED');
    expect(await t.sys.session.count({ where: { supportGrantId: grant.id, revokedAt: null } })).toBe(0);
    expect((await t.as(alpha.owner).post(`/support-access/${grant.id}/revoke`, {}).expect(409)).body.code).toBe('ACCESS_ALREADY_DECIDED');
    // The agent's ordinary platform session is unaffected.
    await t.as(agent).get('/platform/tenants').expect(200);
  });

  it('document content needs the explicit document.read scope', async () => {
    await closeOpen(agent, alpha);
    const without = await supportSession(t, agent, alpha, ['customer.read', 'request.read.all', 'audit.read']);
    await t.as(without.support).get(`/documents/${documentId}`).expect(403);
    await t.as(without.support).post(`/documents/${documentId}/download-link`).expect(403);
    await t.as(alpha.owner).post(`/support-access/${without.grantId}/revoke`, {}).expect(200);

    const withDocs = await supportSession(t, agent, alpha, ['customer.read', 'document.read']);
    expect((await t.as(withDocs.support).get(`/documents/${documentId}`).expect(200)).body.id).toBe(documentId);
    const link = await t.as(withDocs.support).post(`/documents/${documentId}/download-link`).expect(200);
    const file = await fetchBytes(t, link.body.url);
    expect(file.status).toBe(200);
    expect(sha(file.body)).toBe(sha(content));
    // Reading is allowed; changing, verifying, sharing or deleting documents is not.
    await t.as(withDocs.support).upload('/documents/upload', 'file', pdfBytes(), 'x.pdf', { customerId, documentTypeKey: 'other' }).expect(403);
    await t.as(withDocs.support).post(`/documents/${documentId}/verify`, { decision: 'VERIFIED' }).expect(403);
    await t.as(withDocs.support).post(`/documents/${documentId}/shares`, {}).expect(403);
    await t.as(withDocs.support).delete(`/documents/${documentId}`).expect(403);
    // The download is in the document's access trail as support access.
    const access = await t.sys.documentAccessLog.findMany({ where: { tenantId: alpha.id, documentId, actorType: 'PLATFORM' } });
    expect(access.length).toBeGreaterThanOrEqual(1);
    await t.as(alpha.owner).post(`/support-access/${withDocs.grantId}/revoke`, {}).expect(200);
  });

  it('actions taken under a grant appear in the centre\'s audit trail with the grant id', async () => {
    await closeOpen(agent, alpha);
    const session = await supportSession(t, agent, alpha, ['audit.read']);
    const exported = await t.as(session.support).get('/audit-logs/export').expect(200);
    expect(exported.text).toContain('support_access.entered');
    const row = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'audit.exported', supportGrantId: session.grantId } });
    expect(row).toMatchObject({ actorType: 'PLATFORM', actorUserId: agent.userId, actorLabel: 'Platform SUPPORT_AGENT (TypEase support)' });
    // The owner can list the whole story of one grant: everything TypEase support did under it - including the call
    // itself (every call under a grant is on the trail, not only the changes) - and the centre's own approval.
    const trail = await t.as(alpha.owner).get(`/audit-logs?supportGrantId=${session.grantId}&pageSize=100`).expect(200);
    expect(trail.body.data.map((r: any) => r.action).sort()).toEqual(['audit.exported', 'support_access.api_call', 'support_access.approved', 'support_access.entered', 'support_access.requested']);
    const bySupport = trail.body.data.filter((r: any) => r.action !== 'support_access.approved');
    expect(bySupport.every((r: any) => r.supportGrantId === session.grantId && r.actorType === 'PLATFORM')).toBe(true);
    // The approval is the centre's own act: made by its staff, about this grant, not "support access".
    expect(trail.body.data.find((r: any) => r.action === 'support_access.approved')).toMatchObject({ actorType: 'STAFF', actorUserId: alpha.owner.userId, supportGrantId: null, resourceType: 'AccessGrant', resourceId: session.grantId });
    const all = await t.as(alpha.owner).get('/audit-logs?supportAccess=true&pageSize=100').expect(200);
    expect(all.body.meta.total).toBeGreaterThanOrEqual(bySupport.length);
    expect(all.body.data.every((r: any) => r.supportGrantId)).toBe(true);
    // A search text narrows the grant's story, it does not widen it.
    const narrowed = await t.as(alpha.owner).get(`/audit-logs?supportGrantId=${session.grantId}&q=support_access.approved&pageSize=100`).expect(200);
    expect(narrowed.body.data.map((r: any) => r.action)).toEqual(['support_access.approved']);
    await t.as(alpha.owner).post(`/support-access/${session.grantId}/revoke`, {}).expect(200);
    const after = await t.as(alpha.owner).get(`/audit-logs?supportGrantId=${session.grantId}&action=support_access.revoked`).expect(200);
    expect(after.body.data).toEqual([expect.objectContaining({ action: 'support_access.revoked', actorUserId: alpha.owner.userId, resourceId: session.grantId })]);
    // Another centre's trail knows nothing about it.
    expect((await t.as(beta.owner).get(`/audit-logs?supportGrantId=${session.grantId}`).expect(200)).body.meta.total).toBe(0);
  });

  it('after the approved time the token stops working at once; the job then marks the grant EXPIRED', async () => {
    await closeOpen(agent, alpha);
    const session = await supportSession(t, agent, alpha, ['customer.read'], { durationMinutes: 5 });
    await t.as(session.support).get('/customers').expect(200);
    // Time passes (the clock is the database row, read on every request).
    await t.sys.accessGrant.update({ where: { id: session.grantId }, data: { startsAt: new Date(Date.now() - 6 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    expect((await t.as(session.support).get('/customers').expect(401)).body.code).toBe('SUPPORT_ACCESS_ENDED');
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);
    expect((await t.as(agent).post(`/platform/access-grants/${session.grantId}/enter`).expect(403)).body.code).toBe('SUPPORT_ACCESS_ENDED');
    expect((await t.as(alpha.owner).get(`/support-access/${session.grantId}`).expect(200)).body).toMatchObject({ status: 'APPROVED', active: false });

    // A request nobody answered for more than 7 days lapses too.
    const stale = await requestAccess(t, otherAgent, alpha, ['customer.read']);
    await t.sys.accessGrant.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    const fresh = await requestAccess(t, otherAgent, beta, ['customer.read']);

    await t.jobs.runScheduled(ACCESS_EXPIRY_JOB);
    await t.jobs.runScheduled(ACCESS_EXPIRY_JOB);
    expect((await t.sys.accessGrant.findUniqueOrThrow({ where: { id: session.grantId } })).status).toBe('EXPIRED');
    expect((await t.sys.accessGrant.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
    expect((await t.sys.accessGrant.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('REQUESTED');
    expect(await t.sys.session.count({ where: { supportGrantId: session.grantId, revokedAt: null } })).toBe(0);
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'support_access.expired', resourceId: { in: [session.grantId, stale.id] } } })).toBe(2);
    expect((await t.as(alpha.owner).post(`/support-access/${stale.id}/approve`, {}).expect(409)).body.code).toBe('ACCESS_ALREADY_DECIDED');
    await t.as(otherAgent).post(`/platform/access-grants/${fresh.id}/revoke`).expect(200);
  });

  it('the centre may approve less than was asked for, never more', async () => {
    await closeOpen(agent, alpha);
    const grant = await requestAccess(t, agent, alpha, ['customer.read', 'invoice.read', 'payment.read'], { durationMinutes: 120 });
    expect((await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, { scopes: ['customer.read', 'document.read'] }).expect(422)).body).toMatchObject({ code: 'SCOPE_NOT_REQUESTED', details: { notRequested: ['document.read'] } });
    expect((await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, { durationMinutes: 180 }).expect(422)).body.code).toBe('DURATION_TOO_LONG');
    const approved = await t.as(alpha.owner).post(`/support-access/${grant.id}/approve`, { scopes: ['invoice.read'], durationMinutes: 15 }).expect(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', durationMinutes: 15 });
    expect(approved.body.scopes.map((s: any) => s.key)).toEqual(['invoice.read']);
    expect(new Date(approved.body.expiresAt).getTime() - new Date(approved.body.startsAt).getTime()).toBe(15 * 60_000);
    const entered = await t.as(agent).post(`/platform/access-grants/${grant.id}/enter`).expect(200);
    const support: Actor = { ...agent, token: entered.body.accessToken };
    await t.as(support).get('/invoices').expect(200);
    await t.as(support).get('/customers').expect(403);
    await t.as(support).get('/payments').expect(403);
  });

  it('platform staff see their own requests; withdrawing ends the access; a Super Admin can end anyone\'s', async () => {
    const mine = await t.as(agent).get('/platform/access-grants?pageSize=100').expect(200);
    expect(mine.body.data.length).toBeGreaterThanOrEqual(5);
    expect(mine.body.data.every((g: any) => g.requestedById === agent.userId)).toBe(true);
    expect((await t.as(agent).get('/platform/access-grants?all=true').expect(403)).body.code).toBe('FORBIDDEN');
    const everything = await t.as(admin).get('/platform/access-grants?all=true&pageSize=100').expect(200);
    expect(new Set(everything.body.data.map((g: any) => g.requestedById)).size).toBeGreaterThanOrEqual(2);
    expect((await t.as(admin).get(`/platform/access-grants?all=true&centreId=${beta.id}&pageSize=100`).expect(200)).body.data.every((g: any) => g.centre.id === beta.id)).toBe(true);
    const active = (await t.as(agent).get('/platform/access-grants?status=APPROVED').expect(200)).body.data;
    expect(active).toHaveLength(1);
    const grantId = active[0].id;
    // Somebody else's request is invisible to an agent; a Super Admin (audit permission) can read it.
    await t.as(otherAgent).get(`/platform/access-grants/${grantId}`).expect(404);
    await t.as(otherAgent).post(`/platform/access-grants/${grantId}/revoke`).expect(404);
    await t.as(admin).get(`/platform/access-grants/${grantId}`).expect(200);

    const entered = await t.as(agent).post(`/platform/access-grants/${grantId}/enter`).expect(200);
    const support: Actor = { ...agent, token: entered.body.accessToken };
    await t.as(support).get('/invoices').expect(200);
    const ended = await t.as(admin).post(`/platform/access-grants/${grantId}/revoke`).expect(200);
    expect(ended.body).toMatchObject({ status: 'REVOKED', usable: false });
    await t.as(support).get('/invoices').expect(401);
    expect((await t.as(agent).post(`/platform/access-grants/${grantId}/revoke`).expect(409)).body.code).toBe('ACCESS_ALREADY_CLOSED');
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'support_access.revoked', resourceId: grantId } })).toBe(1);
    // Nobody at an archived centre could approve: the request is refused up front.
    const gone = await t.createTenant();
    await t.sys.tenant.update({ where: { id: gone.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    expect((await t.as(agent).post(`/platform/tenants/${gone.id}/access-grants`, { reason: 'Asking an archived centre', scopes: ['customer.read'] }).expect(409)).body.code).toBe('TENANT_UNAVAILABLE');
  });
});
