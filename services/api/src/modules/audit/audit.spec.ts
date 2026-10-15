import { randomUUID } from 'node:crypto';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { addCorporateUser, createCorporateAccount } from '../catalogue/fixtures';
import { AuditViewerService } from './audit.service';

/** Minimal RFC 4180 reader for the assertions below (quoted cells, doubled quotes, CRLF records). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  return rows;
}

describe('Audit viewer', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let branchId: string;
  const grantId = randomUUID();

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    // Real, audited actions through the API.
    branchId = (await t.as(alpha.owner).post('/branches', { code: 'DXB2', name: 'Deira Branch' }).expect(201)).body.id;
    await t.as(alpha.owner).patch(`/branches/${branchId}`, { name: 'Deira Branch (new)' }).expect(200);
    await t.as(beta.owner).post('/branches', { code: 'B2', name: 'Beta Second' }).expect(201);
    // Entries written by other actors, as other modules would write them.
    await t.sys.auditLog.createMany({
      data: [
        { tenantId: alpha.id, actorType: 'SYSTEM', actorLabel: 'job:reminders.scan', action: 'reminder.dispatched', resourceType: 'ReminderSchedule', resourceId: randomUUID(), summary: 'Passport expiry reminder sent', createdAt: new Date('2026-03-10T08:00:00Z') },
        { tenantId: alpha.id, actorType: 'PLATFORM', actorLabel: 'Sara (TypEase support)', actorUserId: randomUUID(), action: 'customer.viewed', resourceType: 'Customer', resourceId: randomUUID(), summary: '=HYPERLINK("http://evil.example","click")', supportGrantId: grantId, before: { fullName: 'Old Name' }, after: { fullName: 'New, "quoted" Name' }, createdAt: new Date('2026-03-11T09:30:00Z') },
        { tenantId: alpha.id, actorType: 'STAFF', actorLabel: 'Accountant', action: 'invoice.voided', resourceType: 'Invoice', resourceId: 'INV-000042', summary: 'Invoice INV-000042 voided', createdAt: new Date('2026-03-12T12:00:00Z') },
        // A platform-level entry (no centre) must never be visible to any centre.
        { tenantId: null, actorType: 'PLATFORM', actorLabel: 'Platform admin', action: 'platform.plan_created', resourceType: 'SubscriptionPlan', summary: 'Plan created' },
      ],
    });
  });
  afterAll(() => t.close());

  it('lists the centre\'s own trail, newest first, without before / after values', async () => {
    const res = await t.as(alpha.owner).get('/audit-logs?pageSize=100').expect(200);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(6);
    const times = res.body.data.map((r: any) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const actions = res.body.data.map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['staff.invited', 'invoice.voided', 'customer.viewed', 'reminder.dispatched']));
    expect(actions).not.toContain('platform.plan_created');
    for (const row of res.body.data) {
      expect(Object.keys(row).sort()).toEqual(['action', 'actorLabel', 'actorType', 'actorUserId', 'createdAt', 'id', 'ip', 'requestId', 'resourceId', 'resourceType', 'summary', 'supportGrantId']);
    }
    // The manager holds audit.read too.
    await t.as(manager).get('/audit-logs').expect(200);
    // Paging.
    const page = await t.as(alpha.owner).get('/audit-logs?pageSize=2&page=2').expect(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta).toMatchObject({ page: 2, pageSize: 2, total: res.body.meta.total });
    expect(page.body.data[0].id).toBe(res.body.data[2].id);
  });

  it('filters by action prefix, resource, actor, date range and support access', async () => {
    const list = async (qs: string) => (await t.as(alpha.owner).get(`/audit-logs?pageSize=100&${qs}`).expect(200)).body.data as any[];
    const branchRows = await list(`resourceType=Branch&resourceId=${branchId}`);
    expect(branchRows.length).toBeGreaterThanOrEqual(2);
    expect(branchRows.every((r) => r.resourceType === 'Branch' && r.resourceId === branchId && r.actorUserId === alpha.owner.userId)).toBe(true);
    expect((await list('action=invoice.')).map((r) => r.action)).toEqual(['invoice.voided']);
    expect((await list('action=invoice.voided')).length).toBe(1);
    expect(await list('action=voided')).toEqual([]);
    expect((await list(`actorUserId=${alpha.owner.userId}`)).every((r) => r.actorUserId === alpha.owner.userId)).toBe(true);
    expect((await list('actorType=SYSTEM')).map((r) => r.action)).toContain('reminder.dispatched');
    // A date means the whole day (UTC); timestamps are exact.
    expect((await list('from=2026-03-11&to=2026-03-11')).map((r) => r.action)).toEqual(['customer.viewed']);
    expect((await list('from=2026-03-10&to=2026-03-12')).map((r) => r.action)).toEqual(['invoice.voided', 'customer.viewed', 'reminder.dispatched']);
    expect((await list(`from=${encodeURIComponent('2026-03-11T09:30:00.001Z')}&to=2026-03-12`)).map((r) => r.action)).toEqual(['invoice.voided']);
    // Everything TypEase support did under an access grant.
    const support = await list('supportAccess=true');
    expect(support).toHaveLength(1);
    expect(support[0]).toMatchObject({ action: 'customer.viewed', supportGrantId: grantId, actorType: 'PLATFORM', actorLabel: 'Sara (TypEase support)' });
    expect((await list(`supportGrantId=${grantId}`)).map((r) => r.id)).toEqual([support[0].id]);
    expect((await list('supportAccess=false')).some((r) => r.supportGrantId !== null)).toBe(false);
    expect((await list('q=passport')).map((r) => r.action)).toEqual(['reminder.dispatched']);
    await t.as(alpha.owner).get('/audit-logs?actorUserId=not-a-uuid').expect(400);
    await t.as(alpha.owner).get('/audit-logs?action=' + encodeURIComponent("x' OR 1=1")).expect(400);
  });

  it('shows one entry with its before and after values', async () => {
    const [row] = (await t.as(alpha.owner).get('/audit-logs?action=customer.viewed').expect(200)).body.data;
    const detail = await t.as(alpha.owner).get(`/audit-logs/${row.id}`).expect(200);
    expect(detail.body).toMatchObject({ id: row.id, action: 'customer.viewed', before: { fullName: 'Old Name' }, after: { fullName: 'New, "quoted" Name' }, supportGrantId: grantId });
    expect(detail.body).not.toHaveProperty('tenantId');
    await t.as(alpha.owner).get('/audit-logs/not-a-uuid').expect(400);
    await t.as(alpha.owner).get(`/audit-logs/${randomUUID()}`).expect(404);
  });

  it('never shows another centre\'s entries or platform-level entries', async () => {
    const mine = (await t.as(alpha.owner).get('/audit-logs?pageSize=100').expect(200)).body.data;
    const theirs = (await t.as(beta.owner).get('/audit-logs?pageSize=100').expect(200)).body.data;
    expect(theirs.length).toBeGreaterThan(0);
    const mineIds = new Set(mine.map((r: any) => r.id));
    expect(theirs.some((r: any) => mineIds.has(r.id))).toBe(false);
    const alphaRows = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id }, select: { id: true } });
    expect(mine.map((r: any) => r.id).sort()).toEqual(alphaRows.map((r) => r.id).sort());
    // By id: another centre's entry is indistinguishable from one that does not exist.
    await t.as(beta.owner).get(`/audit-logs/${mine[0].id}`).expect(404);
    const platformRow = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: null, action: 'platform.plan_created' } });
    await t.as(alpha.owner).get(`/audit-logs/${platformRow.id}`).expect(404);
    // A filter cannot reach across either.
    expect((await t.as(beta.owner).get(`/audit-logs?resourceId=${branchId}`).expect(200)).body.meta.total).toBe(0);
    expect((await t.as(beta.owner).get(`/audit-logs?supportGrantId=${grantId}`).expect(200)).body.meta.total).toBe(0);
    const csv = await t.as(beta.owner).get('/audit-logs/export').expect(200);
    expect(csv.text).not.toContain('INV-000042');
    expect(csv.text).not.toContain(branchId);
    // Row-level security holds for an unfiltered query on the tenant connection.
    const visible = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.auditLog.findMany()));
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.tenantId === beta.id)).toBe(true);
  });

  it('is closed to staff without audit.read, customers, corporate users and platform staff', async () => {
    const customer = await t.addCustomer(alpha);
    const company = await createCorporateAccount(t, alpha);
    const corporate = await addCorporateUser(t, alpha, company.id);
    const platform = await t.createPlatformAdmin();
    const anyId = (await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id } })).id;
    for (const actor of [receptionist, customer, corporate, platform]) {
      await t.as(actor).get('/audit-logs').expect(403);
      await t.as(actor).get(`/audit-logs/${anyId}`).expect(403);
      await t.as(actor).get('/audit-logs/export').expect(403);
    }
    await t.as(null).get('/audit-logs').expect(401);
    await t.as(null).get('/audit-logs/export').expect(401);
  });

  it('exports the filtered trail as CSV, safely, and records the export', async () => {
    const res = await t.as(manager).get('/audit-logs/export?from=2026-03-10&to=2026-03-12').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-trail-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['x-export-rows']).toBe('3');
    expect(res.headers['x-export-truncated']).toBe('false');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(['createdAt', 'action', 'resourceType', 'resourceId', 'summary', 'actorType', 'actorLabel', 'actorUserId', 'supportGrantId', 'ip', 'requestId', 'id']);
    expect(rows.slice(1).map((r) => r[1])).toEqual(['invoice.voided', 'customer.viewed', 'reminder.dispatched']);
    // A summary that a spreadsheet would execute as a formula is neutralised.
    const dangerous = rows.find((r) => r[1] === 'customer.viewed')!;
    expect(dangerous[4]).toBe('\'=HYPERLINK("http://evil.example","click")');
    expect(dangerous[8]).toBe(grantId);
    // before / after values are not part of the export.
    expect(res.text).not.toContain('Old Name');

    const entry = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'audit.exported' }, orderBy: { createdAt: 'desc' } });
    expect(entry).toMatchObject({ actorUserId: manager.userId, actorType: 'STAFF', resourceType: 'AuditLog' });
    expect(entry.after).toMatchObject({ rows: 3, truncated: false, filters: { from: '2026-03-10', to: '2026-03-12' } });
  });

  it('caps the export and says so', async () => {
    const viewer = t.get(AuditViewerService);
    const before = viewer.exportLimit;
    viewer.exportLimit = 4;
    try {
      const all = (await t.as(alpha.owner).get('/audit-logs?pageSize=100').expect(200)).body.data;
      expect(all.length).toBeGreaterThan(4);
      const res = await t.as(alpha.owner).get('/audit-logs/export').expect(200);
      expect(res.headers['x-export-rows']).toBe('4');
      expect(res.headers['x-export-truncated']).toBe('true');
      const rows = parseCsv(res.text);
      // The newest four, in the same order as the list.
      expect(rows.slice(1).map((r) => r[11])).toEqual(all.slice(0, 4).map((r: any) => r.id));
      const entry = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'audit.exported' }, orderBy: { createdAt: 'desc' } });
      expect(entry.after).toMatchObject({ rows: 4, truncated: true });
      expect(entry.summary).toMatch(/limited to the newest 4/);
    } finally {
      viewer.exportLimit = before;
    }
  });

  it('offers no way to change or delete an entry, and the database refuses it too', async () => {
    const row = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'invoice.voided' } });
    for (const call of [t.as(alpha.owner).patch(`/audit-logs/${row.id}`, { summary: 'edited' }), t.as(alpha.owner).delete(`/audit-logs/${row.id}`), t.as(alpha.owner).post('/audit-logs', { action: 'fake.entry' })]) {
      expect((await call).status).toBe(404);
    }
    await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.auditLog.update({ where: { id: row.id }, data: { summary: 'edited' } })))).rejects.toThrow();
    await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.auditLog.delete({ where: { id: row.id } })))).rejects.toThrow();
    await expect(t.sys.auditLog.update({ where: { id: row.id }, data: { summary: 'edited' } })).rejects.toThrow(/append-only/);
    expect((await t.sys.auditLog.findUniqueOrThrow({ where: { id: row.id } })).summary).toBe('Invoice INV-000042 voided');
  });
});
