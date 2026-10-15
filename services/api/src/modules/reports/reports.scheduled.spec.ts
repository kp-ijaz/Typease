import ExcelJS from 'exceljs';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { LogProvider } from '../notifications/providers/log';
import { addBranch, addStaffWithPermissions, dubaiDay, dubaiDayStart, issueInvoice, line, pay, seedCustomer } from './fixtures';
import { SCHEDULED_JOB, ScheduledReportsService } from './scheduled-reports.service';

const HOUR = 3_600_000;

describe('Scheduled reports', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let starter: TenantFixture;
  let accountant: Actor;
  let reviewer: Actor;
  let managerB2: Actor;
  let b2: string;

  const body = (over: Record<string, unknown> = {}) => ({ reportKey: 'daily-sales', params: { range: 'yesterday' }, format: 'XLSX', frequency: 'DAILY', recipients: [accountant.email], ...over });
  const create = async (over: Record<string, unknown> = {}, actor: Actor = accountant) => {
    const res = await t.as(actor).post('/reports/scheduled', body(over));
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const row = (id: string) => t.sys.scheduledReport.findUniqueOrThrow({ where: { id } });
  const makeDue = (id: string, dueAt: Date) => t.sys.scheduledReport.update({ where: { id }, data: { nextRunAt: dueAt } });
  const runJob = async () => {
    await t.jobs.runScheduled(SCHEDULED_JOB);
    await t.settle();
  };
  const reportDocuments = (tenantId: string) => t.sys.document.findMany({ where: { tenantId, title: { startsWith: 'Scheduled report:' } }, orderBy: { createdAt: 'asc' }, include: { documentVersions: true } });
  /** The schedule that produced a file, from the run log. */
  const scheduleOf = async (documentId: string) => (await t.sys.auditLog.findFirstOrThrow({ where: { action: 'report.scheduled_run', after: { path: ['documentId'], equals: documentId } } })).resourceId!;
  const linkPath = async (documentId: string) => `/reports/scheduled/${await scheduleOf(documentId)}/runs/${documentId}/download-link`;
  const download = async (actor: Actor, documentId: string) => {
    const link = await t.as(actor).post(await linkPath(documentId)).expect(200);
    const url = new URL(link.body.url);
    const res = await t.http.get(url.pathname + url.search).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return { link: link.body, bytes: res.body as Buffer };
  };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Al Noor Typing' });
    beta = await t.createTenant();
    starter = await t.createTenant({ plan: 'starter' });
    accountant = await t.addStaff(alpha, 'accountant');
    reviewer = await t.addStaff(alpha, 'reviewer');
    b2 = (await addBranch(t, alpha)).id;
    managerB2 = await t.addStaff(alpha, 'manager', { branchIds: [b2] });
    // Yesterday's business, so that a "yesterday" report has something in it: service 200.00 + tax 10.00, paid.
    const customer = await seedCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' });
    const invoice = await issueInvoice(t, accountant, { customerId: customer.id, branchId: alpha.headOfficeId, items: [line('SERVICE_FEE', '200.00', { taxRatePercent: 5 })] });
    await pay(t, accountant, { invoiceId: invoice.id, amount: '210.00', branchId: alpha.headOfficeId, customerId: customer.id });
    await t.settle();
  });
  afterAll(() => t.close());

  describe('managing schedules', () => {
    it('needs the plan feature', async () => {
      const res = await t.as(starter.owner).post('/reports/scheduled', { ...body(), recipients: [starter.owner.email] }).expect(402);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'scheduledReports' } });
      expect(await t.sys.scheduledReport.count({ where: { tenantId: starter.id } })).toBe(0);
    });

    it('needs report.export and the permission of the report', async () => {
      await t.as(reviewer).post('/reports/scheduled', body()).expect(403);
      await t.as(reviewer).get('/reports/scheduled').expect(403);
      const opsExporter = await addStaffWithPermissions(t, alpha, ['report.operational', 'report.export']);
      await t.as(opsExporter).post('/reports/scheduled', { ...body(), recipients: [opsExporter.email] }).expect(403); // a financial report
      await t.as(opsExporter).post('/reports/scheduled', { ...body({ reportKey: 'requests-by-status' }), recipients: [opsExporter.email] }).expect(201);
      await t.as(accountant).post('/reports/scheduled', body({ reportKey: 'no-such-report' })).expect(404);
    });

    it('creates a schedule and computes the next run in the time zone of the centre', async () => {
      const created = await create({ recipients: [accountant.email, alpha.owner.email], timeOfDay: '07:00' });
      expect(created).toMatchObject({
        reportKey: 'daily-sales', reportTitle: 'Daily sales', params: { range: 'yesterday' }, format: 'XLSX', frequency: 'DAILY', timeOfDay: '07:00', weekday: null, dayOfMonth: null, timeZone: 'Asia/Dubai',
        recipients: [accountant.email, alpha.owner.email], isActive: true, lastRunAt: null, lastStatus: null, link: `${env().CENTRE_WEB_URL}/reports/scheduled/${created.id}`,
      });
      // 07:00 in Dubai is 03:00 UTC: today if that is still ahead, otherwise tomorrow.
      const todayAtSeven = new Date(dubaiDayStart(0).getTime() + 7 * HOUR);
      const expected = todayAtSeven.getTime() > Date.now() ? todayAtSeven : new Date(todayAtSeven.getTime() + 24 * HOUR);
      expect(created.nextRunAt).toBe(expected.toISOString());
      expect(new Date(created.nextRunAt).getUTCHours()).toBe(3);

      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'report.schedule_created', resourceId: created.id } });
      expect(audit).toMatchObject({ actorUserId: accountant.userId, resourceType: 'ScheduledReport' });
      expect((await t.as(accountant).get(`/reports/scheduled/${created.id}`).expect(200)).body.id).toBe(created.id);
      const list = (await t.as(accountant).get('/reports/scheduled?reportKey=daily-sales').expect(200)).body;
      expect(list.data.map((s: any) => s.id)).toContain(created.id);
    });

    it('only accepts recipients who are active staff of this centre and may see the report', async () => {
      const refuse = async (recipients: string[], code: string, extra: Record<string, unknown> = {}) => {
        const res = await t.as(accountant).post('/reports/scheduled', body({ recipients, ...extra })).expect(422);
        expect(res.body.code).toBe('INVALID_RECIPIENTS');
        expect(res.body.details.recipients).toEqual([expect.objectContaining({ email: recipients[recipients.length - 1], code })]);
        return res.body;
      };
      // An arbitrary external address, a customer of the centre, and a staff member of another centre.
      await refuse([accountant.email, 'cfo@big-bank.example'], 'NOT_ACTIVE_STAFF');
      const customer = await t.addCustomer(alpha);
      await refuse([customer.email], 'NOT_ACTIVE_STAFF');
      await refuse([beta.owner.email], 'NOT_ACTIVE_STAFF');
      // Staff without the permission of the report.
      const noPermission = await refuse([reviewer.email], 'NO_REPORT_PERMISSION');
      expect(noPermission.message).toMatch(/not allowed to view financial reports/);
      // A member limited to one branch cannot receive a report over all branches - but can receive one of their branch.
      await refuse([managerB2.email], 'NO_BRANCH_ACCESS');
      await t.as(accountant).post('/reports/scheduled', body({ recipients: [managerB2.email], params: { range: 'yesterday', branchId: b2 } })).expect(201);
      // A suspended member is not active.
      const leaver = await t.addStaff(alpha, 'accountant');
      await t.sys.tenantMembership.update({ where: { id: leaver.membershipId! }, data: { status: 'SUSPENDED' } });
      await refuse([leaver.email], 'NOT_ACTIVE_STAFF');
      await t.as(accountant).post('/reports/scheduled', body({ recipients: [] })).expect(400);
      await t.as(accountant).post('/reports/scheduled', body({ recipients: ['not-an-email'] })).expect(400);
    });

    it('only accepts relative periods and rows of this centre in the filters', async () => {
      await t.as(accountant).post('/reports/scheduled', body({ params: { from: '2026-01-01', to: '2026-01-31' } })).expect(400);
      await t.as(accountant).post('/reports/scheduled', body({ params: { range: 'yesterday', from: '2026-01-01' } })).expect(400);
      await t.as(accountant).post('/reports/scheduled', body({ params: { range: 'yesterday', branchId: beta.headOfficeId } })).expect(404);
      await t.as(accountant).post('/reports/scheduled', body({ frequency: 'HOURLY' })).expect(400);
      await t.as(accountant).post('/reports/scheduled', body({ format: 'CSV' })).expect(400);
      // A member limited to branches must name one of their own.
      const none = await t.as(managerB2).post('/reports/scheduled', body({ recipients: [managerB2.email] })).expect(422);
      expect(none.body.code).toBe('BRANCH_REQUIRED');
      const other = await t.as(managerB2).post('/reports/scheduled', body({ recipients: [managerB2.email], params: { range: 'yesterday', branchId: alpha.headOfficeId } })).expect(403);
      expect(other.body.code).toBe('BRANCH_FORBIDDEN');
    });

    it('updates, reschedules and deletes', async () => {
      const created = await create();
      const weekly = (await t.as(accountant).patch(`/reports/scheduled/${created.id}`, { frequency: 'WEEKLY', weekday: 0, timeOfDay: '18:30', format: 'PDF' }).expect(200)).body;
      expect(weekly).toMatchObject({ frequency: 'WEEKLY', weekday: 0, timeOfDay: '18:30', format: 'PDF' });
      const next = new Date(weekly.nextRunAt);
      // 18:30 in Dubai on a Sunday = 14:30 UTC on a Sunday.
      expect([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([0, 14, 30]);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 24 * HOUR);

      const monthly = (await t.as(accountant).patch(`/reports/scheduled/${created.id}`, { frequency: 'MONTHLY', dayOfMonth: 15, params: { range: 'last_month' } }).expect(200)).body;
      expect(monthly).toMatchObject({ frequency: 'MONTHLY', dayOfMonth: 15, weekday: null, params: { range: 'last_month' } });
      expect(new Date(new Date(monthly.nextRunAt).getTime() + 4 * HOUR).getUTCDate()).toBe(15);
      await t.as(accountant).patch(`/reports/scheduled/${created.id}`, { recipients: ['stranger@elsewhere.example'] }).expect(422);

      const off = (await t.as(accountant).patch(`/reports/scheduled/${created.id}`, { isActive: false }).expect(200)).body;
      expect(off).toMatchObject({ isActive: false, nextRunAt: null });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'report.schedule_updated', resourceId: created.id } })).toBe(3);

      expect((await t.as(accountant).delete(`/reports/scheduled/${created.id}`).expect(200)).body).toEqual({ id: created.id, status: 'DELETED' });
      await t.as(accountant).get(`/reports/scheduled/${created.id}`).expect(404);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'report.schedule_deleted', resourceId: created.id } })).toBe(1);
    });

    it('hides schedules from other centres and from members who may not see their branch scope', async () => {
      const all = await create();
      const branch = await create({ params: { range: 'yesterday', branchId: b2 }, recipients: [managerB2.email] });
      for (const call of [
        () => t.as(beta.owner).get(`/reports/scheduled/${all.id}`),
        () => t.as(beta.owner).patch(`/reports/scheduled/${all.id}`, { isActive: false }),
        () => t.as(beta.owner).delete(`/reports/scheduled/${all.id}`),
        () => t.as(beta.owner).get(`/reports/scheduled/${all.id}/runs`),
        () => t.as(managerB2).get(`/reports/scheduled/${all.id}`),
        () => t.as(managerB2).delete(`/reports/scheduled/${all.id}`),
      ]) expect((await call()).status).toBe(404);
      expect((await t.as(beta.owner).get('/reports/scheduled').expect(200)).body.data).toEqual([]);
      const mine = (await t.as(managerB2).get('/reports/scheduled').expect(200)).body.data.map((s: any) => s.id);
      expect(mine).toContain(branch.id);
      expect(mine).not.toContain(all.id);
      expect((await row(all.id)).isActive).toBe(true);
    });
  });

  describe('the job', () => {
    it('generates the file, stores it in the vault and emails a link - never the file', async () => {
      const schedule = await create({ recipients: [accountant.email, alpha.owner.email] });
      // Due three days ago at 07:00 Dubai time: "yesterday" is the day before THAT day, even though the job runs late.
      const dueAt = new Date(dubaiDayStart(-3).getTime() + 7 * HOUR);
      await makeDue(schedule.id, dueAt);
      const documentsBefore = (await reportDocuments(alpha.id)).length;
      await runJob();

      const after = await row(schedule.id);
      expect(after.lastStatus).toBe('SUCCESS');
      expect(after.lastRunAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(after.nextRunAt.getUTCHours()).toBe(3);

      const documents = await reportDocuments(alpha.id);
      expect(documents).toHaveLength(documentsBefore + 1);
      const document = documents[documents.length - 1];
      expect(document).toMatchObject({ title: `Scheduled report: Daily sales (${dubaiDay(-4)})`, status: 'AVAILABLE', customerVisible: false, customerId: null, requestId: null, documentTypeKey: 'other' });
      expect(document.documentVersions[0]).toMatchObject({ originalFilename: `daily-sales_${dubaiDay(-4)}.xlsx`, detectedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', scanEngine: 'system-generated' });

      // Each recipient gets an email with a link to the centre application.
      const link = `${env().CENTRE_WEB_URL}/reports/scheduled/${schedule.id}`;
      for (const recipient of [accountant, alpha.owner]) {
        expect(t.messenger.lastFor(recipient.email, 'report.scheduled')).toMatchObject({ channel: 'EMAIL', tenantId: alpha.id, data: { reportName: 'Daily sales', periodLabel: dubaiDay(-4), centreLink: link } });
        const sent = LogProvider.lastFor(recipient.email, 'EMAIL')!.message;
        expect(sent.subject).toBe(`Daily sales is ready (${dubaiDay(-4)})`);
        expect(sent.text).toContain(`Open the report: ${link}`);
        expect(sent.text).toContain('only after you sign in');
        // No attachment exists in the message model, and nothing points at the file or the storage.
        expect(Object.keys(sent)).not.toContain('attachments');
        expect(`${sent.text} ${sent.html}`).not.toMatch(/storage|download|documents\/|\.xlsx/i);
      }
      const notifications = await t.sys.notification.findMany({ where: { tenantId: alpha.id, eventKey: 'report.scheduled', recipientAddress: accountant.email } });
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      expect(notifications[notifications.length - 1].status).toBe('SENT');

      // The file is fetched through the reports module, under the rule of the report.
      const { link: file, bytes } = await download(accountant, document.id);
      expect(file).toMatchObject({ filename: `daily-sales_${dubaiDay(-4)}.xlsx`, disposition: 'attachment' });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes as any);
      const pairs: Record<string, unknown> = {};
      wb.getWorksheet('Parameters')!.eachRow((r) => {
        if (r.getCell(1).value) pairs[String(r.getCell(1).value)] = r.getCell(2).value;
      });
      expect(pairs).toMatchObject({ Report: 'Daily sales', Centre: 'Al Noor Typing', Period: dubaiDay(-4), Branch: 'All branches' });
      expect(wb.getWorksheet('Report')!.rowCount).toBe(3); // header, the one day, totals
      // A customer can never reach the file, and neither can another centre - by either route.
      const customer = await t.addCustomer(alpha);
      await t.as(customer).post(`/documents/${document.id}/download-link`).expect(404);
      await t.as(customer).post(await linkPath(document.id)).expect(403);
      await t.as(beta.owner).post(`/documents/${document.id}/download-link`).expect(404);
      await t.as(beta.owner).post(await linkPath(document.id)).expect(404);
    });

    it('reports the period relative to the due day (yesterday of a run due today is yesterday)', async () => {
      const schedule = await create({ format: 'PDF' });
      await makeDue(schedule.id, new Date(Date.now() - 60_000));
      await runJob();
      const documents = await reportDocuments(alpha.id);
      const document = documents[documents.length - 1];
      expect(document.title).toBe(`Scheduled report: Daily sales (${dubaiDay(-1)})`);
      expect(document.documentVersions[0]).toMatchObject({ originalFilename: `daily-sales_${dubaiDay(-1)}.pdf`, detectedMime: 'application/pdf' });
      const { bytes } = await download(alpha.owner, document.id);
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(bytes.toString('latin1')).toContain('(Al Noor Typing)');
    });

    it('lists the runs of a schedule with the generated documents', async () => {
      const schedule = await create();
      await makeDue(schedule.id, new Date(dubaiDayStart(0).getTime() - 17 * HOUR)); // yesterday 07:00
      await runJob();
      const runs = (await t.as(accountant).get(`/reports/scheduled/${schedule.id}/runs`).expect(200)).body;
      expect(runs.meta.total).toBe(1);
      expect(runs.data[0]).toMatchObject({ status: 'SUCCESS', format: 'XLSX', period: { from: dubaiDay(-2), to: dubaiDay(-2) }, recipients: [accountant.email], rows: 1 });
      expect(runs.data[0].document).toMatchObject({ title: `Scheduled report: Daily sales (${dubaiDay(-2)})`, filename: `daily-sales_${dubaiDay(-2)}.xlsx`, available: true });
      expect(runs.data[0].documentId).toBe(runs.data[0].document.id);
      expect(runs.download).toEqual({ method: 'POST', path: `/reports/scheduled/${schedule.id}/runs/:documentId/download-link`, permission: 'report.financial' });
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'report.scheduled_run', resourceId: schedule.id } });
      expect(audit).toMatchObject({ actorType: 'SYSTEM', resourceType: 'ScheduledReport' });
    });

    it('is idempotent for a due time: running the job again produces nothing', async () => {
      const schedule = await create();
      await makeDue(schedule.id, new Date(Date.now() - 5 * 60_000));
      await runJob();
      const documents = (await reportDocuments(alpha.id)).length;
      const emails = t.messenger.captured.filter((m) => m.eventKey === 'report.scheduled').length;
      const first = await row(schedule.id);
      await runJob();
      await runJob();
      // Two concurrent workers on the same schedule: the row lock lets exactly one of them act.
      const service = t.get(ScheduledReportsService);
      await makeDue(schedule.id, new Date(Date.now() - 60_000));
      const results = await Promise.all([1, 2, 3].map(() => t.inTenant(alpha.id, () => service.runOne(schedule.id))));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await reportDocuments(alpha.id)).length).toBe(documents + 1);
      expect(t.messenger.captured.filter((m) => m.eventKey === 'report.scheduled').length).toBe(emails + 1);
      expect(first.lastStatus).toBe('SUCCESS');
      expect((await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'report.scheduled_run', resourceId: schedule.id } }))).toBe(2);
    });

    it('does not run schedules that are not due, or switched off', async () => {
      const future = await create();
      const off = await create({ isActive: false });
      await makeDue(off.id, new Date(Date.now() - HOUR));
      const before = (await reportDocuments(alpha.id)).length;
      await runJob();
      expect((await reportDocuments(alpha.id)).length).toBe(before);
      expect((await row(future.id)).lastRunAt).toBeNull();
      expect((await row(off.id)).lastRunAt).toBeNull();
    });

    it('a failing schedule does not block the others; it is retried and then gives up for that occurrence', async () => {
      const broken = await create();
      const healthy = await create();
      const dueAt = new Date(Date.now() - 10 * 60_000);
      await makeDue(healthy.id, dueAt);
      // The branch of the broken schedule disappears from under it.
      await t.sys.scheduledReport.update({ where: { id: broken.id }, data: { nextRunAt: new Date(dueAt.getTime() - 60_000), params: { filters: { range: 'yesterday', branchId: '00000000-0000-4000-8000-000000000000' }, timing: { timeOfDay: '07:00', weekday: 1, dayOfMonth: 1 } } } });
      await runJob();
      expect((await row(healthy.id)).lastStatus).toBe('SUCCESS');
      let state = await row(broken.id);
      expect(state.lastStatus).toBe('FAILED: Branch was not found.');
      expect(state.nextRunAt.getTime()).toBe(dueAt.getTime() - 60_000); // still due: tried again on the next tick
      await runJob();
      await runJob();
      state = await row(broken.id);
      expect(state.lastStatus).toBe('FAILED: Branch was not found.');
      expect(state.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // third failure: this occurrence is given up
      const runs = (await t.as(accountant).get(`/reports/scheduled/${broken.id}/runs`).expect(200)).body;
      expect(runs.data.map((r: any) => r.status)).toEqual(['FAILED', 'FAILED', 'FAILED']);
      expect(runs.data[0]).toMatchObject({ detail: 'Branch was not found.', document: null, documentId: null });
    });

    it('re-checks the recipients when it runs', async () => {
      const second = await t.addStaff(alpha, 'accountant');
      const schedule = await create({ recipients: [accountant.email, second.email] });
      await t.sys.tenantMembership.update({ where: { id: second.membershipId! }, data: { status: 'SUSPENDED' } });
      await makeDue(schedule.id, new Date(Date.now() - 60_000));
      const sentBefore = t.messenger.captured.filter((m) => m.to === second.email).length;
      await runJob();
      expect((await row(schedule.id)).lastStatus).toBe('SUCCESS: 1 recipient(s) skipped');
      expect(t.messenger.captured.filter((m) => m.to === second.email).length).toBe(sentBefore);
      expect(t.messenger.lastFor(accountant.email, 'report.scheduled')).toBeDefined();

      // Nobody left who may see it: nothing is generated.
      const lonely = await create({ recipients: [accountant.email] });
      const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'reviewer' } });
      const original = await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: accountant.membershipId! } });
      await t.sys.tenantMembership.update({ where: { id: accountant.membershipId! }, data: { roleId: role.id } });
      await makeDue(lonely.id, new Date(Date.now() - 60_000));
      const documents = (await reportDocuments(alpha.id)).length;
      await runJob();
      await t.sys.tenantMembership.update({ where: { id: accountant.membershipId! }, data: { roleId: original.roleId } });
      expect((await row(lonely.id)).lastStatus).toMatch(/^FAILED: None of the recipients/);
      expect((await reportDocuments(alpha.id)).length).toBe(documents);
    });

    it('builds the file for what the recipients may see', async () => {
      const ops = await addStaffWithPermissions(t, alpha, ['report.operational', 'report.export']);
      const schedule = await create({ reportKey: 'branch-performance', recipients: [ops.email] }, ops);
      await makeDue(schedule.id, new Date(Date.now() - 60_000));
      await runJob();
      expect((await row(schedule.id)).lastStatus).toBe('SUCCESS');
      const documents = await reportDocuments(alpha.id);
      const { bytes } = await download(alpha.owner, documents[documents.length - 1].id);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes as any);
      const header = (wb.getWorksheet('Report')!.getRow(1).values as unknown[]).slice(1);
      expect(header).toEqual(['Branch', 'Requests submitted', 'Requests completed', 'Average processing time (hours)', 'Open requests now', 'Overdue requests now']);
    });

    // ---------------------------------------------------------------- who may open a generated file
    describe('access to the generated files', () => {
      let schedule: { id: string };
      let documentId: string;
      const viaDocuments = (actor: Actor) => t.as(actor).post(`/documents/${documentId}/download-link`);
      const viaReports = (actor: Actor, id = schedule.id, doc = documentId) => t.as(actor).post(`/reports/scheduled/${id}/runs/${doc}/download-link`);

      beforeAll(async () => {
        schedule = await create(); // daily-sales: a financial report over all branches
        await makeDue(schedule.id, new Date(Date.now() - 60_000));
        await runJob();
        const documents = await reportDocuments(alpha.id);
        documentId = documents[documents.length - 1].id;
        expect(await scheduleOf(documentId)).toBe(schedule.id);
      });

      it('the accountant, who holds the report permission but not document.read, can download the file', async () => {
        expect((await t.as(accountant).get('/auth/me').expect(200)).body.permissions).not.toContain('document.read');
        const res = await viaReports(accountant).expect(200);
        expect(res.body).toMatchObject({ filename: `daily-sales_${dubaiDay(-1)}.xlsx`, disposition: 'attachment', reportTitle: 'Daily sales', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
        const { bytes } = await download(accountant, documentId);
        expect(bytes.subarray(0, 2).toString()).toBe('PK'); // an xlsx file
        // Audited as a report action, and written to the access log of the document.
        const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'report.scheduled_file_downloaded', resourceId: schedule.id }, orderBy: { createdAt: 'desc' } });
        expect(audit).toMatchObject({ actorUserId: accountant.userId, resourceType: 'ScheduledReport', after: { documentId, reportKey: 'daily-sales' } });
        const access = await t.sys.documentAccessLog.findFirstOrThrow({ where: { documentId, action: 'DOWNLOAD_LINK' }, orderBy: { createdAt: 'desc' } });
        expect(access).toMatchObject({ actorId: accountant.userId, actorType: 'STAFF' });
        // The runs list tells the client where to fetch it and which permission that takes.
        const runs = (await t.as(accountant).get(`/reports/scheduled/${schedule.id}/runs`).expect(200)).body;
        expect(runs.download).toEqual({ method: 'POST', path: `/reports/scheduled/${schedule.id}/runs/:documentId/download-link`, permission: 'report.financial' });
        expect(runs.data[0].documentId).toBe(documentId);
      });

      it('document.read alone opens nothing: not through the document vault, not through the reports module', async () => {
        const permissions: string[] = (await t.as(reviewer).get('/auth/me').expect(200)).body.permissions;
        expect(permissions).toContain('document.read');
        expect(permissions.filter((p) => p.startsWith('report.'))).toEqual([]);
        await viaDocuments(reviewer).expect(404);
        await t.as(reviewer).get(`/documents/${documentId}`).expect(404);
        await t.as(reviewer).post(`/documents/${documentId}/preview-link`).expect(404);
        const listed = (await t.as(reviewer).get('/documents?pageSize=100&q=Scheduled report').expect(200)).body;
        expect(listed.data).toEqual([]);
        expect((await t.as(reviewer).get('/documents?pageSize=100&category=restricted:scheduled-report').expect(200)).body.data).toEqual([]);
        await viaReports(reviewer).expect(403);
        await t.as(reviewer).get(`/reports/scheduled/${schedule.id}/runs`).expect(403);

        // The same holds for people who hold everything in the vault: the file is not a vault document for them either.
        const vault = await addStaffWithPermissions(t, alpha, ['document.read', 'document.upload', 'document.verify', 'document.delete', 'document.share']);
        await viaDocuments(vault).expect(404);
        await t.as(vault).patch(`/documents/${documentId}`, { title: 'Mine now', customerVisible: true }).expect(404);
        await t.as(vault).delete(`/documents/${documentId}`).expect(404);
        await t.as(vault).post(`/documents/${documentId}/shares`, { expiresInHours: 1 }).expect(404);
        await t.as(vault).post(`/documents/${documentId}/verify`, { decision: 'APPROVED' }).expect(404);
        await t.as(vault).post('/documents/upload-intents', { documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 10, replacesDocumentId: documentId }).expect(404);
        expect(await t.sys.document.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({ title: `Scheduled report: Daily sales (${dubaiDay(-1)})`, customerVisible: false, status: 'AVAILABLE', category: 'restricted:scheduled-report' });
        expect(await t.sys.documentShare.count({ where: { documentId } })).toBe(0);
        // The owner holds document.read AND the report permission: the vault still says no, the report route says yes.
        await viaDocuments(alpha.owner).expect(404);
        await viaReports(alpha.owner).expect(200);
      });

      it('needs the permission of THAT report, and its branch scope', async () => {
        // Operational reports only: no access to the file of a financial report.
        const ops = await addStaffWithPermissions(t, alpha, ['report.operational', 'report.export', 'document.read']);
        expect((await viaReports(ops).expect(403)).body.message).toMatch(/Financial reports are only available/);
        await t.as(ops).get(`/reports/scheduled/${schedule.id}/runs`).expect(403);
        await viaDocuments(ops).expect(404);
        // Holding the report permission without report.export is enough to read the file (but not to manage schedules).
        const reader = await addStaffWithPermissions(t, alpha, ['report.financial']);
        await viaReports(reader).expect(200);
        await t.as(reader).get(`/reports/scheduled/${schedule.id}/runs`).expect(200);
        await t.as(reader).get(`/reports/scheduled/${schedule.id}`).expect(403);
        await t.as(reader).patch(`/reports/scheduled/${schedule.id}`, { isActive: false }).expect(403);
        await t.as(reader).post('/reports/scheduled', body()).expect(403);
        // A manager limited to one branch may not see a report over all branches.
        await viaReports(managerB2).expect(404);
        const ownBranch = await create({ params: { range: 'yesterday', branchId: b2 }, recipients: [managerB2.email] }, managerB2);
        await makeDue(ownBranch.id, new Date(Date.now() - 60_000));
        await runJob();
        const ownFile = (await t.as(managerB2).get(`/reports/scheduled/${ownBranch.id}/runs`).expect(200)).body.data[0].documentId;
        await viaReports(managerB2, ownBranch.id, ownFile).expect(200);
      });

      it('only serves files of that schedule: the route cannot be used to read other documents', async () => {
        const other = await create({ format: 'PDF' });
        await makeDue(other.id, new Date(Date.now() - 60_000));
        await runJob();
        const otherFile = (await t.as(accountant).get(`/reports/scheduled/${other.id}/runs`).expect(200)).body.data[0].documentId;
        // A file of another schedule, a customer's passport, a document that does not exist.
        await viaReports(accountant, schedule.id, otherFile).expect(404);
        const customer = await seedCustomer(t, alpha);
        const passport = await t.sys.document.create({ data: { tenantId: alpha.id, customerId: customer.id, documentTypeKey: 'passport', title: 'Passport', status: 'AVAILABLE' } });
        await viaReports(accountant, schedule.id, passport.id).expect(404);
        await viaReports(alpha.owner, schedule.id, passport.id).expect(404);
        await viaReports(accountant, schedule.id, '00000000-0000-4000-8000-000000000001').expect(404);
        await viaReports(accountant, '00000000-0000-4000-8000-000000000001', documentId).expect(404);
        // Another centre: neither its staff nor its own schedules reach the file.
        const theirs = (await t.as(beta.owner).post('/reports/scheduled', { ...body(), recipients: [beta.owner.email] }).expect(201)).body;
        await viaReports(beta.owner).expect(404);
        await viaReports(beta.owner, theirs.id, documentId).expect(404);
        await t.as(null).post(`/reports/scheduled/${schedule.id}/runs/${documentId}/download-link`).expect(401);
      });

      it('nobody can make an ordinary document look like a report file, or the other way round', async () => {
        const customer = await seedCustomer(t, alpha);
        const intent = { documentTypeKey: 'other', filename: 'x.pdf', mime: 'application/pdf', sizeBytes: 10, customerId: customer.id };
        for (const category of ['restricted:scheduled-report', 'Restricted:anything', ' restricted:x']) {
          expect((await t.as(alpha.owner).post('/documents/upload-intents', { ...intent, category }).expect(422)).body.code).toBe('CATEGORY_RESERVED');
        }
        const ordinary = await t.sys.document.create({ data: { tenantId: alpha.id, customerId: customer.id, documentTypeKey: 'other', title: 'Ordinary', status: 'AVAILABLE' } });
        expect((await t.as(alpha.owner).patch(`/documents/${ordinary.id}`, { category: 'restricted:scheduled-report' }).expect(422)).body.code).toBe('CATEGORY_RESERVED');
        expect((await t.sys.document.findUniqueOrThrow({ where: { id: ordinary.id } })).category).toBeNull();
        await t.as(alpha.owner).patch(`/documents/${ordinary.id}`, { category: 'contracts' }).expect(200);
      });

      it('files generated before this rule existed are taken out of the vault rules on the next tick', async () => {
        const legacy = await create();
        await makeDue(legacy.id, new Date(Date.now() - 60_000));
        await runJob();
        const file = (await t.as(accountant).get(`/reports/scheduled/${legacy.id}/runs`).expect(200)).body.data[0].documentId;
        // As such a file used to be stored: an ordinary, unowned vault document.
        await t.sys.document.update({ where: { id: file }, data: { category: null } });
        await t.as(reviewer).post(`/documents/${file}/download-link`).expect(200);
        // A look-alike that no run produced stays what it is.
        const lookAlike = await t.sys.document.create({ data: { tenantId: alpha.id, documentTypeKey: 'other', title: 'Scheduled report: typed by hand', status: 'AVAILABLE' } });
        await runJob();
        expect((await t.sys.document.findUniqueOrThrow({ where: { id: file } })).category).toBe('restricted:scheduled-report');
        expect((await t.sys.document.findUniqueOrThrow({ where: { id: lookAlike.id } })).category).toBeNull();
        await t.as(reviewer).post(`/documents/${file}/download-link`).expect(404);
        await viaReports(accountant, legacy.id, file).expect(200);
        expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.restricted', resourceId: file } })).toBe(1);
        // Without waiting for the tick: the first download through the report route does the same.
        await t.sys.document.update({ where: { id: file }, data: { category: null } });
        await viaReports(accountant, legacy.id, file).expect(200);
        expect((await t.sys.document.findUniqueOrThrow({ where: { id: file } })).category).toBe('restricted:scheduled-report');
      });
    });

    it('skips a centre whose plan no longer includes scheduled reports', async () => {
      const gamma = await t.createTenant();
      const schedule = (await t.as(gamma.owner).post('/reports/scheduled', { ...body(), recipients: [gamma.owner.email] }).expect(201)).body;
      const plan = await t.sys.subscriptionPlan.findUniqueOrThrow({ where: { key: 'starter' } });
      await t.sys.subscription.update({ where: { tenantId: gamma.id }, data: { planId: plan.id } });
      await makeDue(schedule.id, new Date(Date.now() - 60_000));
      await runJob();
      const state = await row(schedule.id);
      expect(state.lastStatus).toBe('SKIPPED: Scheduled reports are not included in the current plan.');
      expect(state.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(await reportDocuments(gamma.id)).toHaveLength(0);
      // Switching it off is still possible; changing it is not.
      await t.as(gamma.owner).patch(`/reports/scheduled/${schedule.id}`, { format: 'PDF' }).expect(402);
      await t.as(gamma.owner).patch(`/reports/scheduled/${schedule.id}`, { isActive: false }).expect(200);
    });

    it('is registered as a job that runs every 15 minutes', () => {
      expect(t.jobs.names()).toContain(SCHEDULED_JOB);
      expect(t.jobs.schedules().find((s) => s.name === SCHEDULED_JOB)).toMatchObject({ everySeconds: 900 });
    });
  });
});
