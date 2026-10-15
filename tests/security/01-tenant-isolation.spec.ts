import { SYSTEM_ROLES } from '@typease/permissions';
import { signAccessToken } from '../../services/api/src/common/auth/tokens';
import {
  anonymous,
  api,
  call,
  changedTables,
  crossTenantReferences,
  EMPTY_SUBLIST_ROUTES,
  fingerprint,
  FOREIGN_FILTERS,
  isIdParam,
  mayPass,
  nameParam,
  NO_SUCH_ID,
  paramsOf,
  PASSWORD,
  populate,
  bodyForRoute,
  RECORD_ATTACKS,
  recordIdFor,
  REFERENCE_ATTACKS,
  Route,
  routeName,
  routeTable,
  TestApp,
  textOf,
  urlOf,
  World,
} from '../support';

/**
 * Scenario 24: tenant A cannot access tenant B data.
 *
 * Two centres are populated through the public API with at least one record of
 * every main resource type (tests/support/world.ts). The owner of centre A -
 * the most powerful account a centre has - then goes after centre B with the
 * ids harvested there:
 *
 *   1. read / update / delete / download, record by record, with requests that
 *      are valid in every other respect (tests/support/attacks.ts);
 *   2. the same over EVERY route of the application that names a record by id
 *      (the route table is read from the running application);
 *   3. lists, searches, filters, reports and exports;
 *   4. ids of B inside create / update bodies of A (foreign keys);
 *   5. tenant ids, slugs and hosts supplied by the client.
 *
 * "Nothing changed" is proven on the database: a hash over every row centre B
 * owns, taken before and after (tests/support/isolation.ts). That and the
 * "no row points across centres" query are the only direct database reads.
 */
describe('Tenant isolation (scenario 24)', () => {
  let t: TestApp;
  let a: World;
  let b: World;
  let routes: Route[];
  /** Every id of centre B and every string that only exists in centre B. */
  let foreign: string[];
  /** A's own figures before centre B existed. */
  let reportsBefore: Record<string, unknown>;

  const A = () => api(t, a.centre.owner, 'owner of centre A');
  const leaked = (res: { status: number; body: any; text?: string }, sent = '') => foreign.find((s) => !sent.includes(s) && textOf(res as any).includes(s));
  /** Number of rows in a list answer, whatever its shape. */
  const rowsIn = (body: any): number => (Array.isArray(body) ? body.length : Array.isArray(body?.data) ? body.data.length : Array.isArray(body?.rows) ? body.rows.length : -1);
  const placeholders = new Proxy({}, { get: (_, k) => `:${String(k)}` }) as Record<string, string>;
  const settledPrint = async (tenantId: string) => {
    await t.settle(10);
    return fingerprint(t, tenantId);
  };
  /** Every figure of A's reports and dashboard for today (what would move if rows of another centre were counted). */
  async function figuresOfA(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const list = await A().get('/reports');
    for (const r of list.reports as any[]) {
      const res = await A().req('GET', `/reports/${r.key}?range=today`);
      out[r.key] = res.status === 200 ? { rows: res.body.rows, totals: res.body.totals } : res.status;
    }
    const dashboard = await A().get('/dashboard');
    out.dashboard = { finance: dashboard.finance, requests: dashboard.requests };
    out.liabilities = (await A().get('/finance/liabilities')).totalOutstanding;
    return out;
  }

  beforeAll(async () => {
    t = await TestApp.create();
    const support = await t.createPlatformAdmin('SUPPORT_AGENT');
    a = await populate(t, 'Alpha', support);
    await t.settle(10);
    reportsBefore = await figuresOfA();
    b = await populate(t, 'Beta', support);
    await t.settle(10);
    routes = routeTable(t);
    foreign = [...new Set([...Object.values(b.ids), ...b.secrets, b.centre.slug])];
    // The two centres share nothing: an id of one is never an id of the other.
    expect(Object.values(a.ids).filter((id) => Object.values(b.ids).includes(id))).toEqual([]);
  }, 300_000);
  afterAll(() => t.close());

  it('S24 tenant A cannot read, update, delete or download a record of tenant B (every main resource type)', async () => {
    const before = await settledPrint(b.centre.id);
    const wrong: string[] = [];
    for (const attack of RECORD_ATTACKS) {
      const body = attack.method === 'GET' || attack.method === 'DELETE' ? undefined : (attack.body?.(a) ?? {});
      const res = await A().req(attack.method, attack.path(b.ids), body);
      const name = `${attack.method} ${attack.path(placeholders)}`;
      // A record of another centre does not exist for the caller: 404, never "forbidden", never a validation hint.
      if (attack.emptyList) {
        // (a list of sub-records answers like for a record that does not exist at all: an empty page)
        const unknown = await A().req(attack.method, attack.path(new Proxy({}, { get: () => NO_SUCH_ID }) as any));
        if (res.status !== 200 || rowsIn(res.body) !== 0 || JSON.stringify(res.body) !== JSON.stringify(unknown.body)) wrong.push(`${name} -> ${res.status} with ${rowsIn(res.body)} row(s)`);
      } else if (res.status !== 404) wrong.push(`${name} -> ${res.status} ${res.body?.code ?? ''}`);
      const leak = leaked(res);
      if (leak) wrong.push(`${name} -> the answer contains "${leak}" of centre B`);
    }
    expect(wrong).toEqual([]);
    expect(changedTables(before, await settledPrint(b.centre.id))).toEqual([]);

    // The resource types the specification names are all in the table above.
    const covered = new Set(RECORD_ATTACKS.map((x) => x.resource));
    for (const type of ['customer', 'request', 'document', 'document link', 'quotation', 'invoice', 'payment', 'refund', 'appointment', 'task', 'ticket', 'staff', 'role', 'branch', 'service', 'workflow', 'scheduled report', 'audit log', 'notification', 'automation', 'corporate account', 'corporate employee']) {
      expect([type, covered.has(type)]).toEqual([type, true]);
    }
    expect(RECORD_ATTACKS.length).toBeGreaterThan(200);
  }, 300_000);

  it('S24 every route of the application that names a record by id refuses the ids of tenant B', async () => {
    const before = await settledPrint(b.centre.id);
    const byId = routes.filter((r) => r.rule?.type === 'tenant' && paramsOf(r).some(isIdParam));
    expect(byId.length).toBeGreaterThan(250);
    const wrong: string[] = [];
    const noRecord = new Set<string>();
    const statuses: Record<number, number> = {};
    let calls = 0;

    /** A valid body for the route, so that the refusal is about the record and not about the body. */
    const bodyFor = (r: Route) => bodyForRoute(r, a, b.ids);
    const attempt = async (r: Route, variant: string, pick: (index: number) => World) => {
      const url = urlOf(r, (param, beforeSegment, index) => {
        if (!isIdParam(param)) return nameParam(param);
        const id = recordIdFor(pick(index).ids, r.path, param, beforeSegment);
        if (!id) noRecord.add(`${routeName(r)} (${param})`);
        return id ?? NO_SUCH_ID;
      });
      const res = await call(t, a.centre.owner, r, url, bodyFor(r));
      calls += 1;
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      const name = `${routeName(r)} [${variant}]`;
      const leak = leaked(res);
      if (leak) wrong.push(`${name} -> the answer contains "${leak}" of centre B`);
      // Routes of the customer and corporate portals are closed to staff altogether (403 before any lookup);
      // tests/security/02 attacks those as a customer and as a company administrator.
      if (!mayPass(r.rule!, { kind: 'STAFF', permissions: SYSTEM_ROLES.owner.permissions })) {
        if (res.status !== 403) wrong.push(`${name} -> ${res.status} ${res.body?.code ?? ''} (a portal route answered a staff member)`);
        return;
      }
      // A list of sub-records answers a foreign parent with an empty page (see EMPTY_SUBLIST_ROUTES).
      if (EMPTY_SUBLIST_ROUTES.includes(routeName(r)) && res.status === 200 && rowsIn(res.body) === 0) return;
      // OCR is switched off in this environment: the extraction route says so before it looks at any document.
      if (routeName(r) === 'POST /api/v1/documents/:id/extract' && res.status === 503 && res.body?.code === 'INTEGRATION_NOT_CONFIGURED') return;
      // Everything else: the record does not exist for the caller. Not "forbidden" (that would confirm it exists),
      // not a validation error (add a valid body to tests/support/attacks.ts for a new route), never 2xx or 5xx.
      if (res.status !== 404) wrong.push(`${name} -> ${res.status} ${res.body?.code ?? ''}`);
    };

    for (const r of byId) {
      await attempt(r, 'all ids of B', () => b);
      if (paramsOf(r).filter(isIdParam).length > 1) {
        // A parent of A with a child of B, and a parent of B with a child of A: neither combination may resolve.
        await attempt(r, 'own parent, child of B', (index) => (index === 0 ? a : b));
        await attempt(r, 'parent of B, own child', (index) => (index === 0 ? b : a));
      }
    }
    expect(wrong).toEqual([]);
    expect(calls).toBeGreaterThan(byId.length);
    expect(statuses[404]).toBeGreaterThan(calls * 0.9);
    // Nothing of centre B changed, and nothing of B was needed that the populated centre does not have - except these.
    expect(changedTables(before, await settledPrint(b.centre.id))).toEqual([]);
    expect([...noRecord].sort()).toEqual([
      'GET /api/v1/automations/executions/:id (id)',
      'GET /api/v1/ocr/results/:id (id)',
      'GET /api/v1/subscription/invoices/:id (id)',
      'GET /api/v1/subscription/invoices/:id/pdf (id)',
      'PATCH /api/v1/requests/:id/external-references/:refId (refId)',
      'POST /api/v1/automations/executions/:id/retry (id)',
      'POST /api/v1/ocr/results/:id/apply (id)',
      'POST /api/v1/ocr/results/:id/review (id)',
      'POST /api/v1/requests/:id/approvals/:approvalId/decide (approvalId)',
      'POST /api/v1/subscription/invoices/:id/pay (id)',
    ]);
  }, 600_000);

  it('S24 lists, searches, filters, reports and exports of tenant A never contain a row of tenant B', async () => {
    const wrong: string[] = [];
    /** `sent`: what the request itself contained (some answers repeat the filter they were given). */
    const check = (name: string, res: any, opts: { mustBeEmpty?: boolean; sent?: string } = {}) => {
      if (res.status >= 500) wrong.push(`${name} -> ${res.status}`);
      const leak = leaked(res, opts.sent);
      if (leak) wrong.push(`${name} -> the answer contains "${leak}" of centre B`);
      if (opts.mustBeEmpty && res.status === 200 && rowsIn(res.body) > 0) wrong.push(`${name} -> ${rowsIn(res.body)} row(s)`);
      if (opts.mustBeEmpty && ![200, 400, 403, 404, 422].includes(res.status)) wrong.push(`${name} -> ${res.status}`);
    };

    // 1. Every list route (GET without a path parameter) as the owner of A, with a large page.
    const lists = routes.filter((r) => r.method === 'GET' && r.rule?.type !== 'public' && r.rule?.type !== 'internal' && paramsOf(r).length === 0);
    expect(lists.length).toBeGreaterThan(100);
    let answered = 0;
    for (const r of lists) {
      for (const query of ['', '?pageSize=100']) {
        const res = await call(t, a.centre.owner, r, r.path + query);
        if (res.status === 200) answered += 1;
        check(routeName(r) + query, res);
      }
    }
    expect(answered).toBeGreaterThan(80);

    // 2. Searching for what only centre B knows: its names, numbers and email addresses.
    const needles = [...b.secrets, b.customer.email, b.company.companyName, b.company.adminEmail, b.centre.slug];
    for (const path of ['/customers', '/requests', '/quotations', '/invoices', '/payments', '/refunds', '/documents', '/corporate-accounts', '/tasks', '/support/tickets', '/audit-logs', '/notifications', '/services', '/automations', '/appointments', '/reminders', '/staff', '/expenses']) {
      for (const q of needles) check(`GET ${path}?q=<of B>`, await A().req('GET', `${path}?q=${encodeURIComponent(q)}&pageSize=100`), { mustBeEmpty: true });
    }
    for (const [path, value] of [['/customers?status=ALL&email=', b.customer.email], ['/customers?status=ALL&passportNo=', b.passportNo], ['/customers?status=ALL&phone=', b.phone]] as const) {
      check(`GET ${path}<of B>`, await A().req('GET', `${path}${encodeURIComponent(value)}`), { mustBeEmpty: true });
    }
    // (the control: centre B finds its own customer by the same passport number)
    expect((await api(t, b.centre.owner).get(`/customers?status=ALL&passportNo=${b.passportNo}`)).data.map((c: any) => c.id)).toEqual([b.ids.walkIn]);

    // 3. Filtering by an id of centre B: empty or refused, never rows of B.
    for (const filter of FOREIGN_FILTERS) {
      const name = `GET ${filter(new Proxy({}, { get: (_, k) => `<${String(k)} of B>` }) as any)}`;
      // Services offered "in all branches" match any branch id: rows of A itself are a correct answer there.
      const ownRowsAreFine = name.startsWith('GET /services?branchId=') || name.includes('/reports/') || name.includes('/dashboard') || name.includes('/queue/') || name.includes('/staff/workload') || name.includes('/requests/counts') || name.includes('/finance/liabilities') || name.includes('/appointments/availability');
      const res = await A().req('GET', filter(b.ids));
      if (process.env.DEBUG_SWEEP) process.stderr.write(`FILTER ${res.status} ${res.body?.code ?? ''} rows=${rowsIn(res.body)} ${name}\n`);
      check(name, res, { mustBeEmpty: !ownRowsAreFine, sent: filter(b.ids) });
    }

    // 4. Every report, its drill-down and its export.
    const reports = (await A().get('/reports')).reports as any[];
    expect(reports.length).toBeGreaterThanOrEqual(15);
    for (const r of reports) {
      for (const suffix of ['?range=month_to_date', '/drilldown?range=month_to_date&pageSize=200', '/export?format=csv&range=month_to_date', `?range=month_to_date&branchId=${a.ids.branch}`]) {
        check(`GET /reports/${r.key}${suffix}`, await A().req('GET', `/reports/${r.key}${suffix}`));
      }
    }
    check('GET /audit-logs/export', await A().req('GET', '/audit-logs/export'));
    expect(wrong).toEqual([]);

    // 5. Centre B did a full day of business after this snapshot was taken: not one figure of A moved.
    expect(await figuresOfA()).toEqual(reportsBefore);
    // ... and A's own lists hold exactly A's rows (the same number B sees of its own).
    for (const path of ['/customers?status=ALL', '/requests', '/invoices', '/payments', '/documents', '/corporate-accounts', '/tasks']) {
      const mine = await A().get(`${path}${path.includes('?') ? '&' : '?'}pageSize=100`);
      const theirs = await api(t, b.centre.owner).get(`${path}${path.includes('?') ? '&' : '?'}pageSize=100`);
      expect([path, mine.meta.total]).toEqual([path, theirs.meta.total]);
      expect(mine.data.filter((row: any) => row.tenantId && row.tenantId !== a.centre.id)).toEqual([]);
    }
  }, 300_000);

  it('S24 a record of tenant B cannot be referenced from tenant A (ids of B in create and update bodies)', async () => {
    const before = await settledPrint(b.centre.id);
    const wrong: string[] = [];
    const send = (attack: (typeof REFERENCE_ATTACKS)[number], referenced: World) => api(t, a.centre.owner).with(attack.headers?.() ?? {}).req(attack.method, attack.path(a.ids), attack.body(a, referenced.ids));

    for (const attack of REFERENCE_ATTACKS) {
      const res = await send(attack, b);
      if (process.env.DEBUG_SWEEP) process.stderr.write(`REF ${res.status} ${res.body?.code} ${attack.what}\n`);
      // The referenced record does not exist for the caller: 404 from the application itself (the database guard
      // behind it, 403 TENANT_FORBIDDEN, is never needed). One request names its refusal differently.
      const [status, code] = attack.refusedWith ?? [404, 'NOT_FOUND'];
      if (res.status !== status || res.body?.code !== code) wrong.push(`${attack.what} -> ${res.status} ${res.body?.code ?? ''} ${JSON.stringify(res.body?.details ?? '')}`);
      const leak = leaked(res);
      if (leak) wrong.push(`${attack.what} -> the answer contains "${leak}" of centre B`);
    }
    expect(wrong).toEqual([]);
    await t.settle();
    // In the whole database no row points at a row of another centre, and nothing of centre B changed.
    expect(await crossTenantReferences(t)).toEqual([]);
    expect(changedTables(before, await settledPrint(b.centre.id))).toEqual([]);

    // Control: the very same requests with ids of A in the same places are accepted - the foreign id was the only fault.
    const controlFailures: string[] = [];
    for (const attack of REFERENCE_ATTACKS.filter((x) => x.control !== false)) {
      const res = await send(attack, a);
      if (res.status < 200 || res.status > 299) controlFailures.push(`${attack.what} (control) -> ${res.status} ${res.body?.code ?? ''} ${res.body?.message ?? ''} ${JSON.stringify(res.body?.details ?? '')}`);
    }
    expect(controlFailures).toEqual([]);
    expect(await crossTenantReferences(t)).toEqual([]);
  }, 300_000);

  it('S24 a tenant id, slug or host supplied by the client never switches the tenant', async () => {
    const before = await settledPrint(b.centre.id);
    const bHost = `${b.centre.slug}.typease.test`;
    const spoof = {
      'x-tenant-id': b.centre.id,
      'x-tenant': b.centre.id,
      'x-tenant-slug': b.centre.slug,
      'x-tenant-host': bHost,
      'x-forwarded-host': bHost,
      origin: `https://${bHost}`,
      referer: `https://${bHost}/customers`,
    };
    const query = `tenantId=${b.centre.id}&tenant=${b.centre.slug}&tenantSlug=${b.centre.slug}&slug=${b.centre.slug}`;
    const spoofed = api(t, a.centre.owner).with(spoof);

    // Who am I, and whose customers do I see? Still centre A, with every spoofed header and query parameter at once.
    const me = await spoofed.get(`/auth/me?${query}`);
    expect(me.tenant).toMatchObject({ id: a.centre.id, slug: a.centre.slug });
    expect((await spoofed.get(`/tenant?${query}`)).id).toBe(a.centre.id);
    const customers = await spoofed.get(`/customers?${query}&status=ALL&pageSize=100`);
    const own = await A().get('/customers?status=ALL&pageSize=100');
    expect(customers.data.length).toBeGreaterThan(0);
    expect(customers.data.map((c: any) => c.id)).toEqual(own.data.map((c: any) => c.id));
    expect(customers.data.map((c: any) => c.id)).toEqual(expect.arrayContaining([a.ids.walkIn, a.ids.customer]));
    expect(customers.data.map((c: any) => c.id)).not.toContain(b.ids.walkIn);
    const direct = await spoofed.req('GET', `/customers/${b.ids.walkIn}?${query}`);
    expect(direct.status).toBe(404);
    // The spoofed host is a real host of centre B (the public configuration proves it) - and still changes nothing above.
    expect((await anonymous(t).with({ 'x-tenant-host': bHost }).get('/public/tenant-config')).tenantId).toBe(b.centre.id);

    // A tenant id in a body is not a way in either: the record is created in the caller's centre.
    const planted = await spoofed.post(`/customers?${query}`, { type: 'INDIVIDUAL', fullName: 'Planted Across Centres', tenantId: b.centre.id, tenant: { id: b.centre.id }, tenantSlug: b.centre.slug }, 201);
    expect(planted.tenantId).toBe(a.centre.id);
    expect((await api(t, b.centre.owner).get('/customers?q=Planted%20Across')).data).toEqual([]);
    const branch = await spoofed.req('PATCH', `/branches/${a.ids.branch2}`, { name: 'Still a branch of A', tenantId: b.centre.id });
    expect(branch.status).toBe(200);
    expect(branch.body.tenantId).toBe(a.centre.id);
    expect((await spoofed.req('PATCH', '/tenant', { name: a.centre.name, id: b.centre.id, tenantId: b.centre.id, slug: b.centre.slug })).body.id).toBe(a.centre.id);
    expect((await api(t, b.centre.owner).get('/tenant')).name).toBe(b.centre.name);

    // Switching centre needs a membership there: the owner of A has none in B, and a membership id of B is not one of theirs.
    for (const membershipId of [b.centre.owner.membershipId!, b.ids.staff]) {
      const res = await api(t, a.centre.owner).req('POST', '/auth/switch-tenant', { membershipId });
      expect([403, 404]).toContain(res.status);
      expect(res.body.accessToken).toBeUndefined();
    }
    expect((await A().get('/auth/me')).tenant.id).toBe(a.centre.id);
    // Signing in "to" centre B with credentials of centre A: staff and customer.
    const staffLogin = await anonymous(t).with({ 'x-tenant-host': bHost }).req('POST', '/auth/login', { email: a.centre.owner.email, password: PASSWORD, app: 'centre', tenantSlug: b.centre.slug });
    if (staffLogin.status === 200) expect(staffLogin.body.session.tenant.id).toBe(a.centre.id); // the slug is ignored for staff: they land in their own centre
    else expect([401, 403]).toContain(staffLogin.status);
    const customerLogin = await anonymous(t).req('POST', '/auth/login', { email: a.customer.email, password: PASSWORD, app: 'customer', tenantSlug: b.centre.slug });
    expect(customerLogin.status).toBe(403);
    expect(customerLogin.body.accessToken).toBeUndefined();

    // A token is bound to the session's membership in the database. Even a correctly signed token that claims
    // another centre (same user, same session, tenant and membership of B) is refused.
    const claims = JSON.parse(Buffer.from(a.centre.owner.token.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.tid).toBe(a.centre.id);
    const relabelled = signAccessToken({ sub: claims.sub, sid: claims.sid, app: claims.app, tid: b.centre.id, mid: b.centre.owner.membershipId! }).token;
    const asRelabelled = await t.http.get('/api/v1/customers').set('Authorization', `Bearer ${relabelled}`);
    expect(asRelabelled.status).toBe(401);
    const halfRelabelled = signAccessToken({ sub: claims.sub, sid: claims.sid, app: claims.app, tid: b.centre.id, mid: claims.mid }).token;
    expect((await t.http.get('/api/v1/customers').set('Authorization', `Bearer ${halfRelabelled}`)).status).toBe(401);
    // Editing the payload without the signing key is refused before anything is looked up.
    const [h, , s] = a.centre.owner.token.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, tid: b.centre.id, mid: b.centre.owner.membershipId })).toString('base64url')}.${s}`;
    const asTampered = await t.http.get('/api/v1/customers').set('Authorization', `Bearer ${tampered}`);
    expect([asTampered.status, asTampered.body.code]).toEqual([401, 'TOKEN_INVALID']);

    // Public lookups are per centre: a tracking code of B is worthless on A's portal, and the other way round.
    const trackB = { requestNo: b.neighbourCase.requestNo, trackingCode: b.neighbourCase.trackingCode! };
    expect((await anonymous(t).req('POST', '/public/track', { tenantSlug: a.centre.slug, ...trackB })).status).toBe(404);
    expect((await anonymous(t).with({ 'x-tenant-host': `${a.centre.slug}.typease.test` }).req('POST', '/public/track', trackB)).status).toBe(404);
    expect((await anonymous(t).req('POST', '/public/track', { tenantSlug: b.centre.slug, ...trackB })).status).toBe(200);

    expect(changedTables(before, await settledPrint(b.centre.id))).toEqual([]);
  });

  it('S24 control: the instruments of this file detect a leak and a change when there is one', async () => {
    // The leak detector: centre B's own customer list is full of what must never reach centre A.
    const own = await api(t, b.centre.owner).req('GET', '/customers?status=ALL&pageSize=100');
    expect(leaked(own)).toBeTruthy();
    expect(leaked(await A().req('GET', '/customers?status=ALL&pageSize=100'))).toBeUndefined();
    // The fingerprint: one renamed tag in centre B changes exactly one table, and not the other centre.
    const [beforeA, beforeB] = [await settledPrint(a.centre.id), await settledPrint(b.centre.id)];
    await api(t, b.centre.owner).patch(`/customer-tags/${b.ids.customerTag}`, { name: 'Renamed by its own centre' });
    const changed = changedTables(beforeB, await settledPrint(b.centre.id)).map((line) => line.split(':')[0]);
    expect(changed).toEqual(expect.arrayContaining(['customer_tags']));
    expect(changed.filter((table) => !['customer_tags', 'audit_logs', 'outbox_events'].includes(table))).toEqual([]);
    expect(changedTables(beforeA, await settledPrint(a.centre.id))).toEqual([]);
  });

  it('S24 control: the same requests against tenant A\'s own records are carried out', async () => {
    // Proof that the table of record attacks consists of real requests: aimed at the caller's own records they are
    // answered, so the 404s above were about whose record it was - not about a wrong path or an invalid body.
    const failures: string[] = [];
    const answers: Record<string, number> = {};
    for (const attack of RECORD_ATTACKS.filter((x) => x.control !== false)) {
      const body = attack.method === 'GET' || attack.method === 'DELETE' ? undefined : (attack.body?.(a) ?? {});
      const res = await A().req(attack.method, attack.path(a.ids), body);
      const bucket = res.status < 300 ? 'carried out' : `${res.status}`;
      answers[bucket] = (answers[bucket] ?? 0) + 1;
      // 409 / 422 = found, but its state forbids the change (a completed request cannot be cancelled ...): also "found".
      if (![200, 201, 204, 409, 422].includes(res.status)) failures.push(`${attack.method} ${attack.path(placeholders)} (own record) -> ${res.status} ${res.body?.code ?? ''} ${res.body?.message ?? ''} ${JSON.stringify(res.body?.details ?? '')}`);
    }
    expect(failures).toEqual([]);
    // Most of them succeed outright.
    expect(answers['carried out']).toBeGreaterThan(RECORD_ATTACKS.length * 0.75);
  }, 300_000);
});
