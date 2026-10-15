import { PLATFORM_ROLES, SUPPORT_GRANTABLE } from '@typease/permissions';
import { Actor, anonymous, api, call, changedTables, downloadDocument, fetchLink, fingerprint, isIdParam, nameParam, NO_SUCH_ID, populate, Route, routeName, routeTable, TestApp, textOf, urlOf, World } from '../support';

/**
 * TypEase staff and the data of a centre (sections 5 and 6 of the specification):
 * "Platform administrators must not automatically receive unrestricted access to
 * customer documents. Provide an explicitly authorised, time-limited support
 * access mechanism with approval, logging and reason capture."
 *
 *   1. Without a grant: a platform account - Super Admin included - reaches no
 *      tenant route at all, and the platform console shows no customer data.
 *   2. A grant needs the centre's approval; asking is not having.
 *   3. With a grant: only what its scopes open, only reading, only this centre,
 *      only until it ends - and every call is on the centre's audit trail.
 *
 * Expiry is the one place where the database is touched (the grant's end time
 * is moved into the past): the shortest grant the API gives is five minutes.
 */
describe('Platform staff and support access', () => {
  let t: TestApp;
  let a: World;
  let b: World;
  let routes: Route[];
  let superAdmin: Actor;
  let agent: Actor;

  const GUARD_REFUSALS = ['SUPPORT_ACCESS_SCOPE', 'SUPPORT_ACCESS_READ_ONLY', 'PLATFORM_ONLY'];
  const personalIn = (res: any, world: World = a) => world.personal.filter((p) => textOf(res).includes(p));
  /** Ask, have the owner approve (optionally less than was asked), enter: an Actor that carries the support session. */
  async function supportSession(staff: Actor, world: World, scopes: string[], approve: Record<string, unknown> = {}, durationMinutes = 30) {
    const grant = await api(t, staff).post(`/platform/tenants/${world.centre.id}/access-grants`, { reason: 'Looking into a ticket about a missing document', scopes, durationMinutes }, 201);
    await api(t, world.centre.owner).post(`/support-access/${grant.id}/approve`, approve, 200);
    const entered = await api(t, staff).post(`/platform/access-grants/${grant.id}/enter`, {}, 200);
    const support: Actor = { ...staff, token: entered.accessToken, membershipId: null, customerId: null, roleKey: null };
    return { grantId: grant.id as string, support, entered };
  }
  const end = (world: World, grantId: string) => api(t, world.centre.owner).post(`/support-access/${grantId}/revoke`, {}, 200);

  beforeAll(async () => {
    t = await TestApp.create();
    superAdmin = await t.createPlatformAdmin('SUPER_ADMIN');
    agent = await t.createPlatformAdmin('SUPPORT_AGENT');
    const other = await t.createPlatformAdmin('SUPPORT_AGENT');
    a = await populate(t, 'Alpha', other);
    b = await populate(t, 'Beta', other);
    routes = routeTable(t);
    await t.settle(10);
  }, 300_000);
  afterAll(() => t.close());

  it('S24 platform: a platform admin cannot read tenant customer documents without an approved support-access grant', async () => {
    const before = await fingerprint(t, a.centre.id);
    // The matrix first: no platform role carries a single tenant permission.
    for (const role of Object.values(PLATFORM_ROLES)) expect(role.permissions.filter((p) => !p.startsWith('platform.'))).toEqual([]);

    for (const [label, staff] of [['Super Admin', superAdmin], ['Support Agent', agent]] as const) {
      // --- the documents, by every door: list, record, link, preview, the request they belong to, the customer
      const x = a.ids;
      for (const [method, path] of [
        ['GET', '/documents'], ['GET', `/documents?customerId=${x.customer}`], ['GET', `/documents/${x.document}`], ['POST', `/documents/${x.document}/download-link`],
        ['POST', `/documents/${x.resultDocument}/preview-link`], ['GET', `/documents/${x.document}/access-logs`], ['GET', `/requests/${x.request}`],
        ['GET', `/customers/${x.walkIn}`], ['GET', `/customers/${x.walkIn}/identity`], ['GET', '/customers'], ['GET', `/invoices/${x.invoice}/pdf`], ['GET', '/audit-logs'],
      ] as const) {
        const res = await api(t, staff).req(method, path, method === 'POST' ? {} : undefined);
        expect([label, `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, res.status, res.body.code]).toEqual([label, `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, 403, 'TENANT_REQUIRED']);
        expect(personalIn(res)).toEqual([]);
      }
      // --- and every other route that belongs to a centre: all of them, without exception
      const wrong: string[] = [];
      const tenantRoutes = routes.filter((r) => r.rule!.type === 'tenant');
      expect(tenantRoutes.length).toBeGreaterThan(440);
      for (const r of tenantRoutes) {
        const res = await call(t, staff, r, urlOf(r, (param, beforeSegment) => (isIdParam(param) ? (a.ids[beforeSegment === 'documents' ? 'document' : beforeSegment === 'customers' ? 'walkIn' : beforeSegment === 'requests' ? 'request' : ''] ?? NO_SUCH_ID) : nameParam(param))), {});
        if (res.status !== 403 || res.body?.code !== 'TENANT_REQUIRED') wrong.push(`${label}: ${routeName(r)} -> ${res.status} ${res.body?.code ?? ''}`);
        if (personalIn(res).length) wrong.push(`${label}: ${routeName(r)} -> the refusal contains customer data`);
      }
      expect(wrong).toEqual([]);
      // A platform account cannot make itself a member of a centre, and cannot be "switched" into one.
      expect((await api(t, staff).get('/auth/memberships')).length ?? 0).toBe(0);
      const switched = await api(t, staff).req('POST', '/auth/switch-tenant', { membershipId: a.centre.owner.membershipId });
      expect([403, 404]).toContain(switched.status);
      expect((await anonymous(t).req('POST', '/auth/login', { email: staff.email, password: 'Correct-Horse-42', app: 'centre' })).status).toBe(403);
      // Spoofed tenant headers do not help a platform account either.
      const spoofed = await api(t, staff).with({ 'x-tenant-id': a.centre.id, 'x-tenant-host': `${a.centre.slug}.typease.test`, 'x-tenant-slug': a.centre.slug }).req('GET', `/documents/${x.document}?tenantId=${a.centre.id}`);
      expect([spoofed.status, spoofed.body.code]).toEqual([403, 'TENANT_REQUIRED']);
    }

    // --- what the platform console does show about the centre: the business, its plan, its usage - no customer data
    const console_ = api(t, superAdmin);
    const seen: string[] = [];
    for (const path of [
      `/platform/tenants/${a.centre.id}`, `/platform/tenants?q=${a.centre.slug}`, '/platform/dashboard', '/platform/audit-logs?pageSize=100', `/platform/security-events?centreId=${a.centre.id}&pageSize=100`,
      `/platform/billing/tenants/${a.centre.id}`, '/platform/billing/subscriptions', '/platform/support/tickets?pageSize=100', `/platform/support/tickets/${a.ids.platformTicket}`, '/platform/access-grants?all=true',
      '/platform/reports/usage', '/platform/reports/tenant-growth', '/platform/domains', '/platform/integrations/authorisations', '/platform/privacy/incidents', `/platform/tenants/${a.centre.id}/feature-flags`,
    ]) {
      const res = await console_.req('GET', path);
      expect([path.replace(/[0-9a-f-]{36}/g, ':id'), res.status]).toEqual([path.replace(/[0-9a-f-]{36}/g, ':id'), 200]);
      seen.push(...personalIn(res).map((p) => `${path.replace(/[0-9a-f-]{36}/g, ':id')} shows "${p}"`));
      // No document, no file name, no storage key, no identity number - and no id of a customer document.
      for (const id of [a.ids.document, a.ids.resultDocument, a.ids.vaultDocument, a.ids.documentVersion]) if (textOf(res).includes(id)) seen.push(`${path} shows a document id`);
    }
    expect(seen).toEqual([]);
    // (the console does know the centre: this is not an empty answer)
    expect((await console_.get(`/platform/tenants/${a.centre.id}`)).slug).toBe(a.centre.slug);

    // --- asking is not having
    const asked = await api(t, agent).post(`/platform/tenants/${a.centre.id}/access-grants`, { reason: 'Customer says a document is missing', scopes: ['document.read', 'customer.read'], durationMinutes: 30 }, 201);
    expect(asked.status).toBe('REQUESTED');
    const early = await api(t, agent).req('POST', `/platform/access-grants/${asked.id}/enter`);
    expect([early.status, early.body.code]).toEqual([409, 'ACCESS_NOT_APPROVED']);
    expect(early.body.accessToken).toBeUndefined();
    expect((await api(t, agent).req('GET', `/documents/${a.ids.document}`)).status).toBe(403);
    // Nobody at TypEase can approve it - not the requester, not a Super Admin: the decision routes belong to the centre.
    for (const staff of [agent, superAdmin]) {
      const res = await api(t, staff).req('POST', `/support-access/${asked.id}/approve`, {});
      expect([res.status, res.body.code]).toEqual([403, 'TENANT_REQUIRED']);
    }
    expect(routes.filter((r) => r.rule!.type === 'platform' && /approve/.test(r.path) && /access/.test(r.path))).toEqual([]);
    // In the centre, the decision is the owner's: not the manager's, and not another centre's owner.
    expect((await api(t, a.manager).req('POST', `/support-access/${asked.id}/approve`, {})).status).toBe(403);
    expect((await api(t, b.centre.owner).req('POST', `/support-access/${asked.id}/approve`, {})).status).toBe(404);
    expect((await api(t, agent).req('POST', `/platform/access-grants/${asked.id}/enter`)).status).toBe(409);
    // A scope that would allow more than looking cannot even be asked for.
    for (const scope of ['customer.sensitive.read', 'document.delete', 'document.verify', 'refund.approve', 'role.manage', 'privacy.manage', 'support_access.decide', 'self.documents']) {
      expect((SUPPORT_GRANTABLE as string[]).includes(scope)).toBe(false);
      const res = await api(t, superAdmin).req('POST', `/platform/tenants/${b.centre.id}/access-grants`, { reason: 'Asking for too much', scopes: ['customer.read', scope], durationMinutes: 30 });
      expect([scope, [400, 422].includes(res.status)]).toEqual([scope, true]);
    }
    // No reason, no request.
    expect((await api(t, superAdmin).req('POST', `/platform/tenants/${b.centre.id}/access-grants`, { scopes: ['customer.read'], durationMinutes: 30 })).status).toBe(400);
    // The owner says no: still nothing, and the answer is final.
    const denied = await api(t, a.centre.owner).post(`/support-access/${asked.id}/deny`, { note: 'Please call us first.' }, 200);
    expect(denied.status).toBe('DENIED');
    const afterDenial = await api(t, agent).req('POST', `/platform/access-grants/${asked.id}/enter`);
    expect([403, 409]).toContain(afterDenial.status);
    expect((await api(t, a.centre.owner).req('POST', `/support-access/${asked.id}/approve`, {})).status).toBe(409);

    // Through all of it the centre's records did not change - apart from the trail of the access request itself.
    await t.settle(10);
    const changed = changedTables(before, await fingerprint(t, a.centre.id)).map((line) => line.split(':')[0]);
    expect(changed.filter((table) => !['access_grants', 'audit_logs', 'security_events', 'outbox_events', 'notifications', 'notification_deliveries', 'usage_records'].includes(table))).toEqual([]);
    // The history of the request is on the centre's audit trail: who asked and why, who refused and why.
    const trail = (await api(t, a.centre.owner).get(`/audit-logs?resourceType=AccessGrant&resourceId=${asked.id}&pageSize=100`)).data as any[];
    expect(trail.map((e) => [e.action, e.actorType, e.actorUserId]).sort()).toEqual([['support_access.denied', 'STAFF', a.centre.owner.userId], ['support_access.requested', 'PLATFORM', agent.userId]]);
    const details = await Promise.all(trail.map((e) => api(t, a.centre.owner).get(`/audit-logs/${e.id}`)));
    expect(JSON.stringify(details)).toContain('Customer says a document is missing');
    expect(JSON.stringify(details)).toContain('Please call us first.');
  }, 300_000);

  it('S24 platform: with a grant, platform staff reach only what its scopes open - reading, in that centre, until it ends', async () => {
    const x = a.ids;
    // --- a grant without the document scope: customers yes (numbers masked), documents no
    const narrow = await supportSession(agent, a, ['customer.read']);
    const n = api(t, narrow.support);
    const customer = await n.get(`/customers/${x.walkIn}`);
    expect(customer.fullName).toContain('Walk-in Customer');
    expect(JSON.stringify(customer)).not.toContain(a.passportNo);
    for (const [method, path] of [['GET', `/customers/${x.walkIn}/identity`], ['GET', '/documents'], ['GET', `/documents/${x.document}`], ['POST', `/documents/${x.document}/download-link`], ['POST', `/documents/${x.document}/preview-link`], ['GET', `/requests/${x.request}`], ['GET', `/invoices/${x.invoice}`]] as const) {
      const res = await n.req(method, path, method === 'POST' ? {} : undefined);
      expect([`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, res.status, res.body.code]).toEqual([`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, 403, 'SUPPORT_ACCESS_SCOPE']);
    }
    await end(a, narrow.grantId);

    // --- the centre may approve less than was asked: asked for documents and customers, got customers only
    const trimmed = await supportSession(agent, a, ['customer.read', 'document.read'], { scopes: ['customer.read'], durationMinutes: 10 });
    expect(trimmed.entered.grant.scopes).toEqual(['customer.read']);
    expect((await api(t, trimmed.support).get('/auth/me')).supportGrant).toMatchObject({ scopes: ['customer.read'], readOnly: true, tenantId: a.centre.id });
    expect((await api(t, trimmed.support).req('POST', `/documents/${x.document}/download-link`, {})).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    // ... but never more: more scopes or more time than requested is refused.
    const modest = await api(t, superAdmin).post(`/platform/tenants/${a.centre.id}/access-grants`, { reason: 'A second pair of eyes on the ticket', scopes: ['branch.read'], durationMinutes: 15 }, 201);
    const more = await api(t, a.centre.owner).req('POST', `/support-access/${modest.id}/approve`, { scopes: ['branch.read', 'document.read'] });
    expect([more.status, more.body.code]).toEqual([422, 'SCOPE_NOT_REQUESTED']);
    const longer = await api(t, a.centre.owner).req('POST', `/support-access/${modest.id}/approve`, { durationMinutes: 600 });
    expect([longer.status, longer.body.code]).toEqual([422, 'DURATION_TOO_LONG']);
    await api(t, superAdmin).post(`/platform/access-grants/${modest.id}/revoke`, {}, [200, 201]);
    await end(a, trimmed.grantId);

    // --- the document scope, approved by the owner: now - and only now - the file can be read
    const docs = await supportSession(agent, a, ['document.read'], {}, 30);
    const d = api(t, docs.support);
    const me = await d.get('/auth/me');
    expect(me).toMatchObject({ membership: null, tenant: { id: a.centre.id }, permissions: ['document.read'] });
    expect(me.supportGrant).toMatchObject({ id: docs.grantId, scopes: ['document.read'], writeScopes: [], readOnly: true, reason: 'Looking into a ticket about a missing document' });
    expect(new Date(me.supportGrant.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 5_000);
    expect((await d.get(`/documents/${x.document}`)).id).toBe(x.document);
    const file = await downloadDocument(t, docs.support, x.document);
    expect(file.bytes.equals(a.case.inputs[0].content)).toBe(true);

    // Every route of the application with this grant: open are the documents' read routes and the five routes that
    // carry no customer data (docs/api/modules/platform.md, "What a support session can reach") - nothing else.
    const open: string[] = [];
    const wrong: string[] = [];
    for (const r of routes) {
      if (r.rule!.type === 'public') continue;
      const res = await call(t, docs.support, r, urlOf(r, (param) => (isIdParam(param) ? NO_SUCH_ID : nameParam(param))), {});
      if (r.rule!.type === 'internal') {
        if (res.status !== 401) wrong.push(`${routeName(r)} -> ${res.status}`);
      } else if (res.status === 403 && GUARD_REFUSALS.includes(res.body?.code)) {
        if (r.rule!.type === 'platform' && res.body.code !== 'PLATFORM_ONLY') wrong.push(`${routeName(r)} -> ${res.body.code}`);
      } else if (res.status === 401 || res.status === 403 || res.status >= 500) wrong.push(`${routeName(r)} -> ${res.status} ${res.body?.code ?? ''}`);
      else open.push(routeName(r));
    }
    expect(wrong).toEqual([]);
    expect(open.sort()).toEqual(
      [
        'GET /api/v1/auth/me',
        'GET /api/v1/branches/directory',
        'GET /api/v1/document-types',
        'GET /api/v1/documents',
        'GET /api/v1/documents/:id',
        'GET /api/v1/documents/checklist-assist',
        'GET /api/v1/feature-flags',
        'GET /api/v1/tenant',
        'POST /api/v1/documents/:id/download-link',
        'POST /api/v1/documents/:id/preview-link',
      ].sort(),
    );

    // Read-only, with real records: nothing about the document can be changed, verified, shared or deleted.
    const before = await fingerprint(t, a.centre.id, ['audit_logs', 'security_events', 'document_access_logs', 'sessions']);
    for (const [method, path, body] of [
      ['PATCH', `/documents/${x.document}`, { title: 'Retitled by support' }],
      ['POST', `/documents/${x.vaultDocument}/verify`, { decision: 'REJECTED', reason: 'Rejected by support' }],
      ['DELETE', `/documents/${x.vaultDocument}`, undefined],
      ['POST', `/documents/${x.document}/shares`, {}],
      ['PUT', `/documents/${x.document}/legal-hold`, { legalHold: true, reason: 'Held by support' }],
      ['POST', '/documents/upload-intents', { customerId: x.walkIn, documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 300 }],
      ['POST', `/documents/${x.document}/extract`, {}],
      ['GET', `/documents/${x.document}/access-logs`, undefined],
      ['GET', `/documents/${x.document}/shares`, undefined],
      ['POST', `/requests/${x.request}/comments`, { body: 'A note from support' }],
    ] as const) {
      const res = await d.req(method, path, body);
      expect([`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, res.status, GUARD_REFUSALS.includes(res.body.code)]).toEqual([`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, 403, true]);
    }
    expect(changedTables(before, await fingerprint(t, a.centre.id, ['audit_logs', 'security_events', 'document_access_logs', 'sessions']))).toEqual([]);

    // Only this centre: a document of another centre does not exist for the session; the platform console is closed to it.
    expect((await d.req('GET', `/documents/${b.ids.document}`)).status).toBe(404);
    expect((await d.req('POST', `/documents/${b.ids.document}/download-link`, {})).status).toBe(404);
    expect((await d.get('/documents?pageSize=100')).data.every((row: any) => !Object.values(b.ids).includes(row.id))).toBe(true);
    const platform = await d.req('GET', `/platform/tenants/${a.centre.id}`);
    expect([platform.status, platform.body.code]).toEqual([403, 'PLATFORM_ONLY']);
    // Only this person: a colleague - a Super Admin even - cannot enter somebody else's grant.
    expect((await api(t, superAdmin).req('POST', `/platform/access-grants/${docs.grantId}/enter`)).status).toBe(404);
    // One grant per person and centre at a time.
    const second = await api(t, agent).req('POST', `/platform/tenants/${a.centre.id}/access-grants`, { reason: 'Asking again while one is running', scopes: ['customer.read'], durationMinutes: 30 });
    expect([second.status, second.body.code]).toEqual([409, 'ACCESS_ALREADY_OPEN']);

    // --- logging: the centre sees who looked at what, under which grant, and why
    const owner = api(t, a.centre.owner);
    const history = (await owner.get(`/audit-logs?resourceType=AccessGrant&resourceId=${docs.grantId}&action=support_access.&pageSize=100&sort=createdAt:asc`)).data as any[];
    expect([...new Set(history.filter((e) => e.action !== 'support_access.api_call').map((e) => e.action))].sort()).toEqual(['support_access.approved', 'support_access.entered', 'support_access.requested']);
    expect(history.find((e) => e.action === 'support_access.approved')).toMatchObject({ actorType: 'STAFF', actorUserId: a.centre.owner.userId });
    // What support did under the grant: one entry per call - the allowed ones and every refused one of the walk above.
    const underGrant = await owner.get(`/audit-logs?supportGrantId=${docs.grantId}&action=support_access.api_call&pageSize=100`);
    expect(underGrant.meta.total).toBeGreaterThan(500);
    expect(underGrant.data.every((e: any) => e.supportGrantId === docs.grantId && e.actorType === 'PLATFORM' && e.actorUserId === agent.userId)).toBe(true);
    const everything = await owner.get(`/audit-logs?supportGrantId=${docs.grantId}&pageSize=1`);
    expect(everything.meta.total).toBeGreaterThan(underGrant.meta.total);
    const allowed = await owner.get(`/audit-logs?supportGrantId=${docs.grantId}&q=${encodeURIComponent('called POST /api/v1/documents/:id/download-link')}&pageSize=10`);
    expect(allowed.meta.total).toBeGreaterThanOrEqual(1);
    expect((await owner.get(`/audit-logs/${allowed.data[0].id}`)).after).toMatchObject({ outcome: 'ALLOWED', method: 'POST', route: '/api/v1/documents/:id/download-link' });
    const log = await api(t, a.centre.owner).get(`/documents/${x.document}/access-logs?pageSize=100`);
    const bySupport = log.data.filter((e: any) => (e.userId ?? e.actorId ?? e.actorUserId) === agent.userId);
    expect(bySupport.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(bySupport)).toMatch(/DOWNLOAD/);
    expect((await api(t, b.centre.owner).get(`/audit-logs?supportGrantId=${docs.grantId}`)).meta.total).toBe(0);

    // --- the end: revoked by the centre, the very next call is refused - with the token that worked a moment ago
    await end(a, docs.grantId);
    for (const [method, path] of [['GET', `/documents/${x.document}`], ['POST', `/documents/${x.document}/download-link`], ['GET', '/auth/me'], ['GET', '/tenant']] as const) {
      expect([path.replace(/[0-9a-f-]{36}/g, ':id'), (await d.req(method, path, method === 'POST' ? {} : undefined)).status]).toEqual([path.replace(/[0-9a-f-]{36}/g, ':id'), 401]);
    }
    expect((await t.http.post('/api/v1/auth/refresh').send({ refreshToken: docs.entered.refreshToken })).status).toBe(401);
    expect((await api(t, agent).req('POST', `/platform/access-grants/${docs.grantId}/enter`)).status).toBeGreaterThanOrEqual(403);

    // --- time-limited: a grant whose time is over ends by itself (time travel in the database: see the file comment)
    const short = await supportSession(agent, a, ['document.read'], {}, 5);
    const link = await api(t, short.support).post(`/documents/${x.document}/download-link`, {});
    expect((await api(t, a.centre.owner).get(`/support-access/${short.grantId}`)).active).toBe(true);
    await t.sys.accessGrant.update({ where: { id: short.grantId }, data: { startsAt: new Date(Date.now() - 6 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    const expired = await api(t, short.support).req('GET', `/documents/${x.document}`);
    expect([expired.status, expired.body.code]).toEqual([401, 'SUPPORT_ACCESS_ENDED']);
    expect((await api(t, short.support).req('POST', `/documents/${x.document}/download-link`, {})).status).toBe(401);
    expect((await api(t, agent).req('POST', `/platform/access-grants/${short.grantId}/enter`)).status).toBe(403);
    expect((await api(t, a.centre.owner).get(`/support-access/${short.grantId}`)).active).toBe(false);
    // (a link handed out while the grant was valid is an ordinary short-lived link: minutes, not the grant's lifetime)
    expect(new Date(link.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect((await fetchLink(t, link.url)).status).toBe(200);
  }, 300_000);

  it('a suspended centre is closed to its staff and customers on the next request, keeps its data, and reopens', async () => {
    const x = b.ids;
    const before = await fingerprint(t, b.centre.id, ['audit_logs', 'security_events', 'sessions', 'login_activity']);
    // Suspending is a platform decision with a reason: not for a support agent, not for a centre, not without a reason.
    expect((await api(t, agent).req('POST', `/platform/tenants/${b.centre.id}/suspend`, { reason: 'Not allowed to do this' })).status).toBe(403);
    expect((await api(t, a.centre.owner).req('POST', `/platform/tenants/${b.centre.id}/suspend`, { reason: 'A competitor' })).body.code).toBe('PLATFORM_ONLY');
    expect((await api(t, superAdmin).req('POST', `/platform/tenants/${b.centre.id}/suspend`, {})).status).toBe(400);
    const suspended = await api(t, superAdmin).post(`/platform/tenants/${b.centre.id}/suspend`, { reason: 'Reported misuse, under review (test)' }, [200, 201]);
    expect(suspended.status).toBe('SUSPENDED');

    // With the tokens they already hold: nothing of the centre's work is reachable any more.
    const closed: Array<[string, Actor, 'GET' | 'POST', string, unknown?]> = [
      ['owner', b.centre.owner, 'GET', '/customers'],
      ['owner', b.centre.owner, 'GET', `/documents/${x.document}`],
      ['owner', b.centre.owner, 'POST', `/documents/${x.document}/download-link`, {}],
      ['owner', b.centre.owner, 'POST', '/customers', { type: 'INDIVIDUAL', fullName: 'Registered While Suspended' }],
      ['owner', b.centre.owner, 'GET', '/reports/daily-sales?range=today'],
      ['manager', b.manager, 'GET', '/requests'],
      ['receptionist', b.crew.receptionist, 'GET', `/requests/${x.request}`],
      ['accountant', b.accountant, 'GET', `/invoices/${x.invoice}`],
      ['customer', b.customer, 'GET', '/requests'],
      ['customer', b.customer, 'POST', `/documents/${x.resultDocument}/download-link`, {}],
      ['customer', b.customer, 'POST', `/invoices/${x.openInvoice}/pay`, {}],
      ['company administrator', b.company.admin, 'GET', '/corporate/account'],
    ];
    for (const [who, actor, method, path, body] of closed) {
      const res = await api(t, actor).req(method, path, body);
      expect([who, `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, res.status, res.body.code]).toEqual([who, `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, 403, 'TENANT_UNAVAILABLE']);
      expect(personalIn(res, b)).toEqual([]);
    }
    // Nobody new comes in: no registration on the portal.
    const register = await anonymous(t).req('POST', '/auth/register', { tenantSlug: b.centre.slug, fullName: 'New While Suspended', email: `late-${Date.now().toString(36)}@example.test`, password: 'Correct-Horse-42', acceptTerms: true });
    expect([register.status, register.body.code]).toEqual([403, 'TENANT_UNAVAILABLE']);
    // The owner can still see why, and reach the subscription to resolve a billing matter.
    expect(await api(t, b.centre.owner).get('/tenant')).toMatchObject({ id: b.centre.id, status: 'SUSPENDED', suspensionReason: 'PLATFORM: Reported misuse, under review (test)' });
    expect((await api(t, b.centre.owner).get('/subscription')).tenantStatus).toBe('SUSPENDED');
    // The other centre is not affected.
    expect((await api(t, a.centre.owner).req('GET', '/customers')).status).toBe(200);

    // Reactivated: everybody is back, with the same tokens, and not a row of the centre's data changed in between.
    const back = await api(t, superAdmin).post(`/platform/tenants/${b.centre.id}/reactivate`, { reason: 'Review finished (test)' }, [200, 201]);
    expect(back.status).toBe('TRIAL');
    await t.settle(10);
    const changed = changedTables(before, await fingerprint(t, b.centre.id, ['audit_logs', 'security_events', 'sessions', 'login_activity'])).map((line) => line.split(':')[0]);
    // (the centre's own row carries the suspension dates; everything the centre owns is as it was)
    expect(changed.filter((table) => !['tenants (own row)', 'outbox_events', 'notifications', 'notification_deliveries', 'usage_records'].includes(table))).toEqual([]);
    for (const [who, actor, method, path] of closed.filter(([, , m]) => m === 'GET')) {
      expect([who, path.replace(/[0-9a-f-]{36}/g, ':id'), (await api(t, actor).req(method, path)).status]).toEqual([who, path.replace(/[0-9a-f-]{36}/g, ':id'), 200]);
    }
    // Both steps are on the platform's audit trail with their reasons.
    const trail = await api(t, superAdmin).get(`/platform/audit-logs?resourceId=${b.centre.id}&pageSize=100`);
    expect(trail.data.map((e: any) => e.action)).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']));
  });

  it('S24 platform: the hand-off code that opens a support session in the staff app works once, for a minute, with the anti-CSRF header', async () => {
    const grant = await api(t, agent).post(`/platform/tenants/${b.centre.id}/access-grants`, { reason: 'Checking a customer record for a ticket', scopes: ['customer.read'], durationMinutes: 30 }, 201);
    await api(t, b.centre.owner).post(`/support-access/${grant.id}/approve`, {}, 200);
    const entered = await api(t, agent).post(`/platform/access-grants/${grant.id}/enter`, {}, 200);
    const code = entered.handoff.code as string;
    expect(code.length).toBeGreaterThanOrEqual(43);
    // The link carries the code in the fragment (never sent to a server), and no token.
    expect(entered.handoff.url).toContain(`#code=${code}`);
    expect(entered.handoff.url).not.toContain(entered.accessToken);
    expect(new Date(entered.handoff.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
    const exchange = (c: string, csrf = true) => {
      let r = t.http.post('/api/v1/auth/support-session/exchange');
      if (csrf) r = r.set('X-Requested-With', 'typease');
      return r.send({ code: c });
    };

    // Without the header: refused, and the code is NOT used up.
    const crossSite = await exchange(code, false);
    expect([crossSite.status, crossSite.body.code]).toEqual([403, 'CSRF_CHECK_FAILED']);
    // A guessed code.
    const guessed = await exchange('A'.repeat(43));
    expect([guessed.status, guessed.body.code]).toEqual([400, 'HANDOFF_INVALID']);

    const first = await exchange(code);
    expect(first.status).toBe(200);
    expect(first.body.session.supportGrant).toMatchObject({ id: grant.id, scopes: ['customer.read'], readOnly: true, tenantId: b.centre.id });
    expect(first.body.refreshToken).toBeUndefined();
    const cookie = ([] as string[]).concat(first.headers['set-cookie'] ?? []).find((c) => c.startsWith('te_rt_centre='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    const support: Actor = { ...agent, token: first.body.accessToken };
    expect((await api(t, support).get(`/customers/${b.ids.walkIn}`)).id).toBe(b.ids.walkIn);
    expect((await api(t, support).req('GET', `/documents/${b.ids.document}`)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    expect((await api(t, support).req('GET', `/customers/${a.ids.walkIn}`)).status).toBe(404); // the other centre

    // The code again: refused - and so is a code that a newer "enter" replaced.
    const again = await exchange(code);
    expect([again.status, again.body.code]).toEqual([400, 'HANDOFF_INVALID']);
    const older = (await api(t, agent).post(`/platform/access-grants/${grant.id}/enter`, {}, 200)).handoff.code;
    const newer = (await api(t, agent).post(`/platform/access-grants/${grant.id}/enter`, {}, 200)).handoff.code;
    expect((await exchange(older)).body.code).toBe('HANDOFF_INVALID');
    // A code is worthless once the centre has withdrawn the access.
    await end(b, grant.id);
    const late = await exchange(newer);
    expect([late.status, late.body.code]).toEqual([403, 'SUPPORT_ACCESS_ENDED']);
    expect(late.body.accessToken).toBeUndefined();
    expect((await api(t, support).req('GET', `/customers/${b.ids.walkIn}`)).status).toBe(401);
    // The refused attempts are security events.
    const events = await api(t, superAdmin).get('/platform/security-events?type=SUPPORT_HANDOFF_REJECTED&pageSize=100');
    expect(events.data.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events.data)).not.toContain(code);
  });
});
