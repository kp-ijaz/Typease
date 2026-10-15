import { SUPPORT_GRANTABLE } from '@typease/permissions';
import type { AccessRule } from '../src/common/auth/access';
import { DiscoveredRoute, discoverRoutes } from '../src/common/auth/routes';
import { decideSupportAccess, SUPPORT_WRITE_SCOPES } from '../src/common/auth/support-session';
import { RedisService } from '../src/common/redis';
import { pdfBytes } from '../src/modules/documents/fixtures';
import { supportSession } from '../src/modules/platform/fixtures';
import { createCustomer, createService, submittedRequest } from '../src/modules/requests/fixtures';
import { Actor, TenantFixture, TestApp } from './helpers';

/**
 * A support session (platform staff inside a centre under an approved access
 * grant) is confined to the scopes the centre approved. The heart of this file
 * walks EVERY registered route - the same discovery the API reference uses -
 * and checks the guard's answer for each one.
 */

/** Routes a support session may call without any scope. A change here is a security decision: review it. */
const SAFE_ROUTES = [
  'GET /api/v1/auth/me',
  'GET /api/v1/branches/directory',
  'GET /api/v1/document-types',
  'GET /api/v1/feature-flags',
  'GET /api/v1/tenant',
];
/** Routes that are not a GET but count as a read (they return a short-lived link). They still need their scope. */
const READ_ROUTES = [
  'POST /api/v1/documents/:id/download-link',
  'POST /api/v1/documents/:id/preview-link',
  'POST /api/v1/reminders/:id/renewal-link',
  'POST /api/v1/reports/scheduled/:id/runs/:documentId/download-link',
];
/** The only change a support session can ever make, and only with the write scope the centre approved. */
const WRITE_ROUTES = ['POST /api/v1/requests/:id/comments'];
const GUARD_REFUSALS = ['SUPPORT_ACCESS_SCOPE', 'SUPPORT_ACCESS_READ_ONLY', 'PLATFORM_ONLY'];

const name = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const ID = '5b1d7c2e-1111-4222-8333-444455556666';
const urlOf = (r: DiscoveredRoute) => r.path.replace(/:[A-Za-z]+/g, ID);

describe('support-session rules (pure)', () => {
  const tenant = (over: Partial<Extract<AccessRule, { type: 'tenant' }>> = {}): AccessRule => ({ type: 'tenant', ...over });
  const scopes = (...s: string[]) => new Set(s);

  it('opens a route only through a granted scope, a read marker or an explicit safe marker', () => {
    const cases: Array<[string, AccessRule, 'SAFE' | 'READ' | undefined, string, string[], boolean | string]> = [
      ['read in scope', tenant({ any: ['customer.read'] }), undefined, 'GET', ['customer.read'], true],
      ['read out of scope', tenant({ any: ['customer.read'] }), undefined, 'GET', ['branch.read'], 'SUPPORT_ACCESS_SCOPE'],
      ['any: one of several is enough', tenant({ any: ['staff.read', 'role.manage'] }), undefined, 'GET', ['staff.read'], true],
      ['all: every one is needed', tenant({ all: ['customer.read', 'invoice.read'] }), undefined, 'GET', ['customer.read'], 'SUPPORT_ACCESS_SCOPE'],
      ['all: every one granted', tenant({ all: ['customer.read', 'invoice.read'] }), undefined, 'GET', ['customer.read', 'invoice.read'], true],
      ['no permission declared', tenant(), undefined, 'GET', [...SUPPORT_GRANTABLE], 'SUPPORT_ACCESS_SCOPE'],
      ['staff-only route without a permission', tenant({ kinds: ['STAFF'] }), undefined, 'GET', [...SUPPORT_GRANTABLE], 'SUPPORT_ACCESS_SCOPE'],
      ['route for customers, even with a matching scope', tenant({ kinds: ['CUSTOMER', 'CORPORATE'], any: ['document.read'] }), undefined, 'GET', ['document.read'], 'SUPPORT_ACCESS_SCOPE'],
      ['safe marker', tenant(), 'SAFE', 'GET', [], true],
      ['safe marker on a route for customers', tenant({ kinds: ['CUSTOMER'] }), 'SAFE', 'GET', [], true],
      ['safe marker never opens a change', tenant(), 'SAFE', 'POST', [], 'SUPPORT_ACCESS_READ_ONLY'],
      ['signed-in route', { type: 'authenticated' }, undefined, 'GET', [...SUPPORT_GRANTABLE], 'SUPPORT_ACCESS_SCOPE'],
      ['signed-in route with the safe marker', { type: 'authenticated' }, 'SAFE', 'GET', [], true],
      ['change with a read scope', tenant({ any: ['customer.read', 'customer.update'] }), undefined, 'PATCH', ['customer.read'], 'SUPPORT_ACCESS_READ_ONLY'],
      ['delete with a read scope', tenant({ any: ['document.read'] }), undefined, 'DELETE', ['document.read'], 'SUPPORT_ACCESS_READ_ONLY'],
      ['POST that only reads, scope granted', tenant({ any: ['document.read'] }), 'READ', 'POST', ['document.read'], true],
      ['POST that only reads, scope missing', tenant({ any: ['document.read'] }), 'READ', 'POST', ['customer.read'], 'SUPPORT_ACCESS_SCOPE'],
      ['change with the granted write scope', tenant({ any: ['request.comment.internal', 'request.update'] }), undefined, 'POST', ['request.comment.internal'], true],
      ['change without the write scope', tenant({ any: ['request.comment.internal', 'request.update'] }), undefined, 'POST', ['request.read.all'], 'SUPPORT_ACCESS_SCOPE'],
      ['platform route', { type: 'platform', any: ['platform.tenants.read'] }, undefined, 'GET', [...SUPPORT_GRANTABLE], 'PLATFORM_ONLY'],
      ['public route', { type: 'public' }, undefined, 'POST', [], true],
    ];
    for (const [label, rule, mode, method, granted, expected] of cases) {
      const decision = decideSupportAccess(rule, mode ? { mode, reason: 'test' } : undefined, method, scopes(...granted));
      expect([label, decision.allowed ? true : decision.code]).toEqual([label, expected]);
    }
  });

  it('defines exactly one write scope, and it is one a grant can carry', () => {
    expect([...SUPPORT_WRITE_SCOPES]).toEqual(['request.comment.internal']);
    for (const scope of SUPPORT_WRITE_SCOPES) expect(SUPPORT_GRANTABLE).toContain(scope);
    // Nothing a grant can carry manages staff, roles, billing, privacy requests or reveals identity numbers.
    for (const scope of SUPPORT_GRANTABLE) expect(scope).not.toMatch(/manage|sensitive|subscription|privacy|role\.|delete|approve|refund|decide|export/);
  });
});

describe('support sessions against every route of the application', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let routes: DiscoveredRoute[];
  let customerId: string;
  let requestId: string;
  let documentId: string;
  const agents: Actor[] = [];
  const agent = async () => {
    const a = await t.createPlatformAdmin('SUPPORT_AGENT');
    agents.push(a);
    return a;
  };
  const call = (actor: Actor, r: DiscoveredRoute) => (t.as(actor) as any)[r.method.toLowerCase()](urlOf(r).replace(/^\/api\/v1/, '')) as Promise<{ status: number; body: any }>;
  const viaHttp = (actor: Actor, r: DiscoveredRoute) => (t.http as any)[r.method.toLowerCase()](urlOf(r)).set('Authorization', `Bearer ${actor.token}`) as Promise<{ status: number; body: any }>;
  const send = (actor: Actor, r: DiscoveredRoute) => (r.path.startsWith('/api/v1') ? call(actor, r) : viaHttp(actor, r));

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    routes = discoverRoutes(t.app);
    const customer = await createCustomer(t, alpha, { fullName: 'Mariam Al Hashimi' });
    customerId = customer.id;
    const service = await createService(t, alpha);
    requestId = (await submittedRequest(t, alpha, alpha.owner, service.id, customerId)).id;
    const upload = await t.as(alpha.owner).upload('/documents/upload', 'file', pdfBytes('support-walk'), 'passport.pdf', { customerId, documentTypeKey: 'passport', title: 'Passport copy' });
    if (upload.status !== 201) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(upload.body)}`);
    documentId = upload.body.documentId;
    await t.settle();
  });
  afterAll(() => t.close());

  it('the route list is the complete one and the markers are exactly the reviewed ones', () => {
    expect(routes.length).toBeGreaterThan(500);
    expect(routes.filter((r) => !r.rule)).toEqual([]);
    expect(routes.filter((r) => r.support?.mode === 'SAFE').map(name).sort()).toEqual(SAFE_ROUTES);
    expect(routes.filter((r) => r.support?.mode === 'READ').map(name).sort()).toEqual(READ_ROUTES);
    // A safe route never needs a permission and is never a change; a "read" route always needs a grantable scope.
    for (const r of routes.filter((x) => x.support?.mode === 'SAFE')) {
      expect([name(r), r.method, r.rule?.type === 'tenant' ? [...(r.rule.any ?? []), ...(r.rule.all ?? [])] : []]).toEqual([name(r), 'GET', []]);
      expect(r.support!.reason.length).toBeGreaterThan(20);
    }
    for (const r of routes.filter((x) => x.support?.mode === 'READ')) {
      const any = r.rule?.type === 'tenant' ? (r.rule.any ?? []) : [];
      expect([name(r), any.some((p) => (SUPPORT_GRANTABLE as string[]).includes(p))]).toEqual([name(r), true]);
    }
  });

  it('with a minimal scope (branch.read) everything else answers 403 - all routes, one by one', async () => {
    const staff = await agent();
    const session = await supportSession(t, staff, alpha, ['branch.read']);
    const expectedOpen = [...SAFE_ROUTES, 'GET /api/v1/branches'].sort();
    const open: string[] = [];
    const wrong: Array<[string, number, string | undefined]> = [];
    let refused = 0;
    for (const r of routes) {
      if (r.rule!.type === 'public') continue; // no session needed at all; nothing to confine
      const res = await send(session.support, r);
      if (r.rule!.type === 'internal') {
        // Infrastructure calls need the internal token; a bearer token of any kind is not one.
        if (res.status !== 401) wrong.push([name(r), res.status, res.body?.code]);
        continue;
      }
      const guardRefused = res.status === 403 && GUARD_REFUSALS.includes(res.body?.code);
      if (guardRefused) refused += 1;
      else if (res.status === 401 || res.status === 403 || res.status >= 500) wrong.push([name(r), res.status, res.body?.code]);
      else open.push(name(r));
    }
    expect(wrong).toEqual([]);
    expect(open.sort()).toEqual(expectedOpen);
    expect(refused).toBeGreaterThan(450);

    // Every refusal is on the centre's audit trail with the grant id; the safe routes are not (they carry no centre data).
    const trail = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, supportGrantId: session.grantId, action: 'support_access.api_call' } });
    const outcomes = trail.map((row) => (row.after as any).outcome);
    expect(outcomes.filter((o) => o === 'REFUSED')).toHaveLength(refused);
    expect(trail.filter((row) => (row.after as any).outcome === 'ALLOWED').map((row) => `${(row.after as any).method} ${(row.after as any).route}`)).toEqual(['GET /api/v1/branches']);
    expect(trail.every((row) => row.actorType === 'PLATFORM' && row.actorUserId === staff.userId && row.resourceId === session.grantId)).toBe(true);
    expect(await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'PERMISSION_DENIED', userId: staff.userId } })).toBe(refused);
    // Nothing was changed anywhere by all of this.
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, supportGrantId: session.grantId, action: { notIn: ['support_access.api_call', 'support_access.requested', 'support_access.entered'] } } })).toBe(0);
    await t.as(alpha.owner).post(`/support-access/${session.grantId}/revoke`, {}).expect(200);
  }, 300_000);

  it('with EVERY grantable scope the session is still read-only, apart from internal notes; nothing unscoped opens', async () => {
    const staff = await agent();
    const session = await supportSession(t, staff, alpha, [...SUPPORT_GRANTABLE]);
    const granted = new Set<string>(SUPPORT_GRANTABLE);
    const wrong: Array<[string, number, string | undefined]> = [];
    const openChanges: string[] = [];
    const openReads: string[] = [];
    for (const r of routes) {
      const rule = r.rule!;
      if (rule.type === 'public' || rule.type === 'internal') continue;
      const res = await send(session.support, r);
      const guardRefused = res.status === 403 && GUARD_REFUSALS.includes(res.body?.code);
      if (res.status === 401 || res.status >= 500) wrong.push([name(r), res.status, res.body?.code]);
      if (guardRefused) continue;
      (r.method === 'GET' ? openReads : openChanges).push(name(r));
    }
    expect(wrong).toEqual([]);
    expect(openChanges.sort()).toEqual([...READ_ROUTES, ...WRITE_ROUTES].sort());
    // Reads: exactly the safe routes plus the staff routes whose declared permission is one of the granted scopes.
    const expectedReads = routes
      .filter((r) => r.method === 'GET' && r.rule!.type === 'tenant')
      .filter((r) => {
        const rule = r.rule as Extract<AccessRule, { type: 'tenant' }>;
        if (rule.kinds && !rule.kinds.includes('STAFF')) return false;
        return (rule.any?.some((p) => granted.has(p)) ?? false) || (!!rule.all?.length && rule.all.every((p) => granted.has(p)));
      })
      .map(name);
    expect(openReads.sort()).toEqual([...new Set([...expectedReads, ...SAFE_ROUTES])].sort());
    // Spot checks of what must never open, whatever was granted.
    for (const closed of ['GET /api/v1/customers/:id/identity', 'GET /api/v1/roles/:id', 'GET /api/v1/subscription', 'GET /api/v1/privacy/requests', 'GET /api/v1/support-access', 'GET /api/v1/integrations', 'GET /api/v1/auth/sessions', 'GET /api/v1/me/notifications', 'GET /api/v1/dashboard', 'GET /api/v1/tenant/usage']) {
      if (routes.some((r) => name(r) === closed)) expect([closed, openReads.includes(closed)]).toEqual([closed, false]);
    }
    for (const r of routes.filter((x) => x.method === 'GET' && /staff\/:id|roles|subscription|billing|privacy|integrations|support-access|sessions|identity|ocr\/results/.test(x.path))) {
      const rule = r.rule!;
      const grantable = rule.type === 'tenant' && (rule.any ?? []).some((p) => granted.has(p));
      if (!grantable) expect([name(r), openReads.includes(name(r))]).toEqual([name(r), false]);
    }
    await t.as(alpha.owner).post(`/support-access/${session.grantId}/revoke`, {}).expect(200);
  }, 300_000);

  it('in-scope reads work, are confined to the centre and are recorded with the grant id', async () => {
    const staff = await agent();
    const session = await supportSession(t, staff, alpha, ['customer.read', 'request.read.all']);
    const me = await t.as(session.support).get('/auth/me').expect(200);
    expect(me.body.supportGrant).toMatchObject({ id: session.grantId, scopes: ['customer.read', 'request.read.all'], writeScopes: [], readOnly: true, tenantId: alpha.id, tenantName: 'Alpha Typing', reason: 'Investigating support ticket about missing invoices' });
    expect(new Date(me.body.supportGrant.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(me.body).toMatchObject({ membership: null, tenant: { id: alpha.id, name: 'Alpha Typing' }, permissions: ['customer.read', 'request.read.all'] });

    const customer = await t.as(session.support).get(`/customers/${customerId}`).expect(200);
    expect(customer.body.fullName).toBe('Mariam Al Hashimi');
    // Identity numbers stay masked and cannot be revealed; documents stay closed without their own scope.
    expect(JSON.stringify(customer.body)).not.toMatch(/784-?\d{4}-?\d{7}-?\d/);
    expect((await t.as(session.support).get(`/customers/${customerId}/identity`).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    expect((await t.as(session.support).get(`/documents/${documentId}`).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    expect((await t.as(session.support).post(`/documents/${documentId}/download-link`).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    await t.as(session.support).get(`/requests/${requestId}`).expect(200);
    // Reading the request is in scope; writing an internal note is not (the write scope was not granted).
    expect((await t.as(session.support).post(`/requests/${requestId}/comments`, { body: 'Looked at this for the ticket.' }).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    expect((await t.as(session.support).patch(`/customers/${customerId}`, { fullName: 'Renamed By Support' }).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    // The own account is managed in the platform console, not from inside a centre.
    for (const [method, path] of [['patch', '/auth/me'], ['post', '/auth/password/change'], ['post', '/auth/mfa/setup'], ['post', '/auth/switch-tenant'], ['get', '/auth/sessions'], ['post', '/auth/sessions/revoke-others'], ['get', '/auth/memberships']] as const) {
      expect([path, (await (t.as(session.support) as any)[method](path)).status]).toEqual([path, 403]);
    }
    // A record of another centre does not exist for the session.
    const other = await createCustomer(t, beta, { fullName: 'Beta Person' });
    await t.as(session.support).get(`/customers/${other.id}`).expect(404);

    const trail = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, supportGrantId: session.grantId, action: 'support_access.api_call' }, orderBy: { createdAt: 'asc' } });
    expect(trail.filter((row) => (row.after as any).outcome === 'ALLOWED').map((row) => `${(row.after as any).method} ${(row.after as any).route}`)).toEqual([
      'GET /api/v1/customers/:id', 'GET /api/v1/requests/:id', 'GET /api/v1/customers/:id',
    ]);
    expect((trail[0].after as any).path).toBe(`/api/v1/customers/${customerId}`);
    expect(trail.every((row) => row.actorLabel === `${'Platform SUPPORT_AGENT'} (TypEase support)` && row.actorType === 'PLATFORM')).toBe(true);
    // The centre's owner can read all of it; another centre sees nothing.
    const seen = await t.as(alpha.owner).get(`/audit-logs?supportGrantId=${session.grantId}&pageSize=100`).expect(200);
    expect(seen.body.data.filter((r: any) => r.action === 'support_access.api_call').length).toBe(trail.length);
    expect((await t.as(beta.owner).get(`/audit-logs?supportGrantId=${session.grantId}`).expect(200)).body.meta.total).toBe(0);
    await t.as(alpha.owner).post(`/support-access/${session.grantId}/revoke`, {}).expect(200);
  });

  it('the write scope allows internal notes and nothing else; the centre sees that it is a write before approving', async () => {
    const staff = await agent();
    const asked = await t.as(staff).post(`/platform/tenants/${alpha.id}/access-grants`, { reason: 'Leaving a note for the operator on the ticket', scopes: ['request.read.all', 'request.comment.internal'], durationMinutes: 30 }).expect(201);
    const shown = await t.as(alpha.owner).get(`/support-access/${asked.body.id}`).expect(200);
    expect(shown.body.scopes.map((s: any) => [s.key, s.write])).toEqual([['request.read.all', false], ['request.comment.internal', true]]);
    await t.as(alpha.owner).post(`/support-access/${asked.body.id}/approve`, {}).expect(200);
    const entered = await t.as(staff).post(`/platform/access-grants/${asked.body.id}/enter`).expect(200);
    const support: Actor = { ...staff, token: entered.body.accessToken };
    expect((await t.as(support).get('/auth/me').expect(200)).body.supportGrant).toMatchObject({ readOnly: false, writeScopes: ['request.comment.internal'] });

    const note = await t.as(support).post(`/requests/${requestId}/comments`, { body: 'Checked the workflow for ticket 4711: step 2 is waiting for the customer.' }).expect(201);
    expect(note.body).toMatchObject({ visibility: 'INTERNAL', authorType: 'PLATFORM', authorName: 'Platform SUPPORT_AGENT (TypEase support)' });
    // A message to the customer is a different permission, which a grant can never carry.
    await t.as(support).post(`/requests/${requestId}/comments`, { body: 'Hello customer', visibility: 'CUSTOMER' }).expect(403);
    // No other change opens with it.
    expect((await t.as(support).patch(`/requests/${requestId}`, { priority: 'URGENT' })).status).toBe(403);
    expect((await t.as(support).post(`/requests/${requestId}/assign`, {})).status).toBe(403);
    // The note is on the trail with the grant id, and the customer never sees it.
    const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'request.comment_added', resourceId: note.body.id } });
    expect(audit).toMatchObject({ supportGrantId: asked.body.id, actorType: 'PLATFORM', actorUserId: staff.userId });
    expect(await t.sys.requestComment.count({ where: { requestId, visibility: 'CUSTOMER', authorType: 'PLATFORM' } })).toBe(0);
    await t.as(alpha.owner).post(`/support-access/${asked.body.id}/revoke`, {}).expect(200);
  });

  it('expiry and revocation take effect on the very next request - also on the routes that need no scope', async () => {
    const staff = await agent();
    const session = await supportSession(t, staff, alpha, ['customer.read'], { durationMinutes: 5 });
    await t.as(session.support).get('/customers').expect(200);
    await t.as(session.support).get('/tenant').expect(200);
    await t.sys.accessGrant.update({ where: { id: session.grantId }, data: { startsAt: new Date(Date.now() - 6 * 60_000), expiresAt: new Date(Date.now() - 1000) } });
    for (const path of ['/customers', '/tenant', '/auth/me', '/feature-flags']) {
      const res = await t.as(session.support).get(path);
      expect([path, res.status, res.body.code]).toEqual([path, 401, 'SUPPORT_ACCESS_ENDED']);
    }
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);

    const second = await agent();
    const live = await supportSession(t, second, alpha, ['customer.read']);
    await t.as(live.support).get('/customers').expect(200);
    await t.as(alpha.owner).post(`/support-access/${live.grantId}/revoke`, {}).expect(200);
    for (const path of ['/customers', '/tenant', '/auth/me']) expect([path, (await t.as(live.support).get(path)).status]).toEqual([path, 401]);
    // A platform account that is switched off loses its sessions inside centres at once as well.
    const third = await agent();
    const doomed = await supportSession(t, third, alpha, ['customer.read']);
    await t.sys.user.update({ where: { id: third.userId }, data: { status: 'DISABLED' } });
    expect((await t.as(doomed.support).get('/customers')).status).toBe(401);
    // A suspended centre is closed to support sessions like to everybody else, except for the frame of the app.
    const fourth = await agent();
    const inSuspended = await supportSession(t, fourth, beta, ['customer.read']);
    await t.sys.tenant.update({ where: { id: beta.id }, data: { status: 'SUSPENDED' } });
    expect((await t.as(inSuspended.support).get('/customers').expect(403)).body.code).toBe('TENANT_UNAVAILABLE');
    await t.as(inSuspended.support).get('/tenant').expect(200);
    await t.sys.tenant.update({ where: { id: beta.id }, data: { status: 'ACTIVE' } });
  });

  it('a refused call that is repeated is recorded once in ten minutes, with the repeats counted; every allowed call is recorded', async () => {
    const redis = t.get(RedisService).client;
    const staff = await agent();
    const session = await supportSession(t, staff, alpha, ['branch.read']);
    const trail = async (outcome: 'ALLOWED' | 'REFUSED', route?: string) =>
      (await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, supportGrantId: session.grantId, action: 'support_access.api_call' }, orderBy: { createdAt: 'asc' } }))
        .filter((row) => (row.after as any).outcome === outcome && (!route || ((row.after as any).route === route && (row.after as any).method === 'GET')));
    const denials = () => t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'PERMISSION_DENIED', userId: staff.userId } });

    // The same forbidden read, five times: five refusals for the caller, one entry for the centre.
    for (let i = 0; i < 5; i++) expect((await t.as(session.support).get(`/customers?page=${i + 1}`).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    let customers = await trail('REFUSED', '/api/v1/customers');
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ actorType: 'PLATFORM', actorUserId: staff.userId, resourceType: 'AccessGrant', resourceId: session.grantId, summary: 'TypEase support was refused GET /api/v1/customers' });
    expect(customers[0].after).toMatchObject({ method: 'GET', route: '/api/v1/customers', outcome: 'REFUSED', reason: 'SUPPORT_ACCESS_SCOPE', collapsed: { windowMinutes: 10, suppressedSincePreviousEntry: 0 } });
    // The security log is not collapsed: every denial is there.
    expect(await denials()).toBe(5);

    // Another route, another method on the same path, another reason: each has its own entry.
    await t.as(session.support).get('/invoices').expect(403);
    await t.as(session.support).get('/invoices').expect(403);
    expect((await t.as(session.support).post('/customers', { fullName: 'Not Allowed' }).expect(403)).body.code).toBe('SUPPORT_ACCESS_SCOPE');
    expect((await t.as(session.support).get('/platform/dashboard').expect(403)).body.code).toBe('PLATFORM_ONLY');
    await t.as(session.support).get('/platform/dashboard').expect(403);
    // One route pattern is one call, whatever the id in it.
    await t.as(session.support).get(`/customers/${customerId}`).expect(403);
    await t.as(session.support).get(`/customers/${ID}`).expect(403);
    const refused = await trail('REFUSED');
    expect(refused.map((row) => `${(row.after as any).method} ${(row.after as any).route} ${(row.after as any).reason}`)).toEqual([
      'GET /api/v1/customers SUPPORT_ACCESS_SCOPE',
      'GET /api/v1/invoices SUPPORT_ACCESS_SCOPE',
      'POST /api/v1/customers SUPPORT_ACCESS_SCOPE',
      'GET /api/v1/platform/dashboard PLATFORM_ONLY',
      'GET /api/v1/customers/:id SUPPORT_ACCESS_SCOPE',
    ]);
    expect(await denials()).toBe(12);

    // Allowed calls are never collapsed.
    for (let i = 0; i < 3; i++) await t.as(session.support).get('/branches').expect(200);
    expect(await trail('ALLOWED', '/api/v1/branches')).toHaveLength(3);

    // Another grant has its own window: its first refusal of the same call is recorded.
    const colleague = await agent();
    const second = await supportSession(t, colleague, alpha, ['branch.read']);
    await t.as(second.support).get('/customers').expect(403);
    await t.as(second.support).get('/customers').expect(403);
    const theirs = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, supportGrantId: second.grantId, action: 'support_access.api_call' } });
    expect(theirs.map((row) => (row.after as any).outcome)).toEqual(['REFUSED']);

    // Ten minutes later (the window keys are gone): the next refusal is written, and says how many were only counted.
    const windows = (await redis.keys('support:refused:*')).filter((k) => !k.endsWith(':n'));
    expect(windows.length).toBeGreaterThanOrEqual(6);
    for (const key of windows) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    }
    await redis.del(...windows);
    await t.as(session.support).get('/customers').expect(403);
    await t.as(session.support).get('/customers').expect(403);
    customers = await trail('REFUSED', '/api/v1/customers');
    expect(customers).toHaveLength(2);
    expect(customers[1].after).toMatchObject({ outcome: 'REFUSED', collapsed: { windowMinutes: 10, suppressedSincePreviousEntry: 4 } });
    expect(customers[1].summary).toBe('TypEase support was refused GET /api/v1/customers (4 more refusals of this call since the previous entry were not recorded one by one)');
    // The count was handed over: the entry after that starts from the one repeat in the new window.
    await redis.del(...(await redis.keys('support:refused:*')).filter((k) => !k.endsWith(':n')));
    await t.as(session.support).get('/customers').expect(403);
    customers = await trail('REFUSED', '/api/v1/customers');
    expect(customers[2].after).toMatchObject({ collapsed: { suppressedSincePreviousEntry: 1 } });
    expect(customers[2].summary).toMatch(/\(1 more refusal of this call since the previous entry was not recorded one by one\)$/);
    await t.as(alpha.owner).post(`/support-access/${session.grantId}/revoke`, {}).expect(200);
    await t.as(alpha.owner).post(`/support-access/${second.grantId}/revoke`, {}).expect(200);
  });

  it('a public route gives a support session nothing an anonymous caller would not get, and signing out ends the session', async () => {
    const staff = await agent();
    const session = await supportSession(t, staff, alpha, ['service.read']);
    const anonymous = await t.http.get(`/api/v1/public/services?slug=${alpha.slug}`);
    const asSupport = await t.http.get(`/api/v1/public/services?slug=${alpha.slug}`).set('Authorization', `Bearer ${session.support.token}`);
    expect(asSupport.status).toBe(anonymous.status);
    expect(asSupport.body).toEqual(anonymous.body);
    // Signing out without the cookie (the token identifies the session) ends it.
    await t.as(session.support).post('/auth/logout', {}).expect(200);
    await t.as(session.support).get('/auth/me').expect(401);
    expect(await t.sys.session.count({ where: { supportGrantId: session.grantId, revokedAt: null } })).toBe(0);
  });
});
