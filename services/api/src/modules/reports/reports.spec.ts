import { randomUUID } from 'node:crypto';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { addBranch, addStaffWithPermissions, dubaiDay, seedCustomer, seedHistory, seedReminder, seedRequest, seedService, seedTask } from './fixtures';

/**
 * Operational reports, the registry, permissions and tenant isolation.
 * The fixture lives in March 2025 so that "the period" is fixed; every expected
 * number is worked out by hand in the comments next to the rows.
 */
describe('Reports', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let b1: string;
  let b2: string;
  let accountant: Actor;
  let managerB2: Actor;
  let reviewer: Actor;
  let opsOnly: Actor; // report.operational and nothing else
  let op1: Actor;
  let op2: Actor;
  const ref: Record<string, string> = {};
  const MARCH = 'from=2025-03-01&to=2025-03-31';
  /** A moment in 2025, Dubai wall clock (UTC+4). */
  const at = (day: string, hour = 12) => new Date(Date.parse(`2025-${day}T00:00:00.000Z`) + (hour - 4) * 3_600_000);

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant();
    beta = await t.createTenant();
    b1 = alpha.headOfficeId;
    b2 = (await addBranch(t, alpha)).id;
    accountant = await t.addStaff(alpha, 'accountant');
    managerB2 = await t.addStaff(alpha, 'manager', { branchIds: [b2] });
    reviewer = await t.addStaff(alpha, 'reviewer');
    opsOnly = await addStaffWithPermissions(t, alpha, ['report.operational']);
    op1 = await t.addStaff(alpha, 'operator');
    op2 = await t.addStaff(alpha, 'operator');

    const s1 = await seedService(t, alpha, { name: 'Residence visa', categoryKey: 'visa' });
    const s2 = await seedService(t, alpha, { name: 'Tenancy contract typing' });
    // Customers: 2 before the period, then Jan 2 (one archived), Feb 0, Mar 3 (+1 merged duplicate that never counts).
    const c1 = await seedCustomer(t, alpha, { fullName: 'Fatima Al Mansoori', createdAt: new Date('2024-12-10T08:00:00Z') });
    const c2 = await seedCustomer(t, alpha, { fullName: 'Omar Khalid', createdAt: new Date('2024-12-20T08:00:00Z') });
    await seedCustomer(t, alpha, { createdAt: at('01-10') });
    await seedCustomer(t, alpha, { createdAt: at('01-20'), status: 'ARCHIVED' });
    const march1 = await seedCustomer(t, alpha, { fullName: 'March Individual', createdAt: at('03-03') });
    await seedCustomer(t, alpha, { createdAt: at('03-10') });
    await seedCustomer(t, alpha, { createdAt: at('03-31', 23), type: 'BUSINESS' }); // 23:00 on the last day still is March in Dubai
    await seedCustomer(t, alpha, { createdAt: at('03-15'), status: 'MERGED' });
    Object.assign(ref, { s1: s1.id, s2: s2.id, c1: c1.id, c2: c2.id, march1: march1.id });

    // ---- requests                                                             hours from submission to completion
    const q = async (key: string, data: Parameters<typeof seedRequest>[2]) => {
      ref[key] = (await seedRequest(t, alpha, data)).id;
    };
    const base = { customerId: c1.id, serviceId: s1.id };
    await q('q1', { ...base, createdAt: at('03-02'), completedAt: at('03-04'), status: 'COMPLETED', assignedToId: op1.membershipId }); //                48
    await q('q2', { ...base, createdAt: at('03-05'), completedAt: at('03-05', 24), status: 'COMPLETED', assignedToId: op1.membershipId }); //            12
    await q('q3', { ...base, createdAt: at('03-10'), completedAt: at('03-14'), status: 'COMPLETED', assignedToId: op2.membershipId, branchId: b2 }); //  96
    await q('q4', { customerId: c2.id, serviceId: s2.id, createdAt: at('03-12'), completedAt: at('03-13'), status: 'COMPLETED', assignedToId: op2.membershipId }); // 24
    await q('q5', { customerId: c2.id, serviceId: s2.id, createdAt: at('03-20'), status: 'IN_PREPARATION', assignedToId: op1.membershipId, branchId: b2, targetDate: at('03-25') }); // open, overdue
    await q('q6', { ...base, createdAt: at('03-21'), status: 'SUBMITTED' });
    await q('q7', { ...base, createdAt: at('03-22'), status: 'CANCELLED' });
    await q('q8', { customerId: c2.id, serviceId: s2.id, createdAt: at('02-20'), completedAt: at('03-01'), status: 'COMPLETED', assignedToId: op1.membershipId }); // 216, created in February
    await q('q9', { ...base, createdAt: at('03-15'), status: 'DRAFT', submittedAt: null });
    await seedRequest(t, alpha, { ...base, createdAt: at('03-16'), status: 'SUBMITTED', deletedAt: new Date() }); // deleted: never counted

    // ---- operator assignments (q4 was first given to op1, then to op2)
    const assign = (requestId: string, member: Actor, when: Date, unassignedAt: Date | null = null) =>
      t.sys.requestAssignment.create({ data: { tenantId: alpha.id, requestId, assigneeId: member.membershipId!, role: 'OPERATOR', assignedAt: when, unassignedAt } });
    await assign(ref.q1, op1, at('03-02'));
    await assign(ref.q2, op1, at('03-05'));
    await assign(ref.q3, op2, at('03-10'));
    await assign(ref.q4, op1, at('03-12'), at('03-12', 14));
    await assign(ref.q4, op2, at('03-12', 14));
    await assign(ref.q5, op1, at('03-20'));
    await assign(ref.q8, op1, at('02-20'));
    await seedTask(t, alpha, { assigneeId: op2.membershipId!, status: 'OPEN' });

    // ---- time in "Documents under review":  q1 6 h, q2 1 h + 2 h, q3 24 h, q8 12 h, q4 never
    await seedHistory(t, alpha, ref.q1, 'SUBMITTED', 'UNDER_REVIEW', at('03-02', 13));
    await seedHistory(t, alpha, ref.q1, 'UNDER_REVIEW', 'READY_FOR_PROCESSING', at('03-02', 19));
    await seedHistory(t, alpha, ref.q2, 'SUBMITTED', 'UNDER_REVIEW', at('03-05', 13));
    await seedHistory(t, alpha, ref.q2, 'UNDER_REVIEW', 'UNDER_REVIEW', at('03-05', 13.5)); // a note: not a status change
    await seedHistory(t, alpha, ref.q2, 'UNDER_REVIEW', 'AWAITING_CUSTOMER', at('03-05', 14));
    await seedHistory(t, alpha, ref.q2, 'AWAITING_CUSTOMER', 'UNDER_REVIEW', at('03-05', 16));
    await seedHistory(t, alpha, ref.q2, 'UNDER_REVIEW', 'READY_FOR_PROCESSING', at('03-05', 18));
    await seedHistory(t, alpha, ref.q3, 'SUBMITTED', 'UNDER_REVIEW', at('03-10', 14));
    await seedHistory(t, alpha, ref.q3, 'UNDER_REVIEW', 'READY_FOR_PROCESSING', at('03-11', 14));
    await seedHistory(t, alpha, ref.q8, 'SUBMITTED', 'UNDER_REVIEW', at('02-21', 12));
    await seedHistory(t, alpha, ref.q8, 'UNDER_REVIEW', 'READY_FOR_PROCESSING', at('02-21', 24));

    // ---- expiry reminders: upcoming is relative to today, reminders handled are counted in the period
    const passportSoon = await seedReminder(t, alpha, { customerId: c1.id, documentTypeKey: 'passport', expiryDate: dubaiDay(5), subjectLabel: 'Fatima Al Mansoori', renewalRequestId: ref.q6 });
    const passportLater = await seedReminder(t, alpha, { customerId: c2.id, documentTypeKey: 'passport', expiryDate: dubaiDay(20), status: 'PAUSED', subjectLabel: 'Omar Khalid' });
    const emirates = await seedReminder(t, alpha, { customerId: c1.id, documentTypeKey: 'emirates_id', expiryDate: dubaiDay(10) });
    await seedReminder(t, alpha, { customerId: c1.id, documentTypeKey: 'residence_visa', expiryDate: dubaiDay(40) });
    await seedReminder(t, alpha, { customerId: c1.id, documentTypeKey: 'labour_card', expiryDate: dubaiDay(-2) });
    const dispatch = (scheduleId: string, offsetDays: number, status: string, processedAt: Date | null) =>
      t.sys.reminderDispatch.create({ data: { tenantId: alpha.id, scheduleId, offsetDays, dueOn: new Date('2025-03-01T00:00:00Z'), status, processedAt } });
    await dispatch(passportSoon.id, 90, 'SENT', at('03-03'));
    await dispatch(passportSoon.id, 60, 'SENT', at('03-20'));
    await dispatch(passportLater.id, 90, 'SKIPPED_NO_CONSENT', at('03-21'));
    await dispatch(emirates.id, 90, 'SKIPPED_OPT_OUT', at('03-05'));
    await dispatch(emirates.id, 60, 'FAILED', at('03-25'));
    await dispatch(emirates.id, 30, 'SENT', at('04-02')); // April: outside the period
    await dispatch(passportLater.id, 60, 'PENDING', null);

    // ---- customer feedback in March: 5, 5, 4, 2, 1  -> average 3.40
    const feedback = (rating: number, link: { requestId?: string; ticketId?: string }, when: Date, comment?: string) =>
      t.sys.customerFeedback.create({ data: { tenantId: alpha.id, customerId: c1.id, rating, comment: comment ?? null, createdAt: when, requestId: link.requestId ?? null, ticketId: link.ticketId ?? null } });
    await feedback(5, { requestId: ref.q1 }, at('03-05'), 'Very fast');
    await feedback(5, { ticketId: randomUUID() }, at('03-06'));
    await feedback(4, { requestId: ref.q3 }, at('03-15'));
    await feedback(2, { requestId: ref.q2 }, at('03-06'), '=HYPERLINK("http://evil.example","click")');
    await feedback(1, { ticketId: randomUUID() }, at('03-30'));
    await feedback(5, { requestId: ref.q4 }, at('04-01')); // April

    // ---- another centre
    const bs = await seedService(t, beta);
    const bc = await seedCustomer(t, beta, { createdAt: at('03-05') });
    await seedRequest(t, beta, { customerId: bc.id, serviceId: bs.id, createdAt: at('03-06'), completedAt: at('03-07'), status: 'COMPLETED' });
  });
  afterAll(() => t.close());

  const run = async (actor: Actor, key: string, query = MARCH) => (await t.as(actor).get(`/reports/${key}?${query}`).expect(200)).body;
  const drill = async (actor: Actor, key: string, query = MARCH) => (await t.as(actor).get(`/reports/${key}/drilldown?${query}`).expect(200)).body;

  describe('registry and permissions', () => {
    it('lists what the caller may run, with parameters', async () => {
      const all = (await t.as(accountant).get('/reports').expect(200)).body;
      expect(all.reports.map((r: any) => r.key).sort()).toEqual(
        [
          'branch-performance', 'corporate-revenue', 'customer-growth', 'customer-satisfaction', 'daily-sales', 'document-processing-time', 'expiry-reminders', 'liabilities', 'monthly-service-revenue',
          'outstanding-payments', 'refunds', 'requests-by-status', 'service-profitability', 'staff-workload', 'transactions-by-service',
        ].sort(),
      );
      expect(all.canExport).toBe(true);
      expect(all.exportFormats).toEqual(['xlsx', 'pdf', 'csv']);
      const daily = all.reports.find((r: any) => r.key === 'daily-sales');
      expect(daily).toMatchObject({ title: 'Daily sales', permission: 'report.financial', category: 'FINANCE', hasDrilldown: true, branchScoped: true });
      expect(daily.parameters.map((p: any) => p.key)).toEqual(expect.arrayContaining(['from', 'to', 'range', 'branchId']));

      const ops = (await t.as(opsOnly).get('/reports').expect(200)).body;
      expect(ops.reports.every((r: any) => r.permission === 'report.operational')).toBe(true);
      expect(ops.reports).toHaveLength(7);
      expect(ops.canExport).toBe(false);
      expect(ops.exportFormats).toEqual([]);
    });

    it('refuses roles without a report permission, customers and anonymous callers', async () => {
      await t.as(reviewer).get('/reports').expect(403);
      await t.as(reviewer).get('/reports/requests-by-status').expect(403);
      await t.as(op1).get('/reports/staff-workload').expect(403);
      const customer = await t.addCustomer(alpha);
      await t.as(customer).get('/reports').expect(403);
      await t.as(null).get('/reports/requests-by-status').expect(401);
    });

    it('a financial report needs report.financial, also for its drill-down and export', async () => {
      const res = await t.as(opsOnly).get('/reports/daily-sales').expect(403);
      expect(res.body.message).toMatch(/financial reports/i);
      await t.as(opsOnly).get('/reports/liabilities/drilldown').expect(403);
      await t.as(opsOnly).get('/reports/requests-by-status/export?format=xlsx').expect(403); // no report.export
      const exporter = await addStaffWithPermissions(t, alpha, ['report.operational', 'report.export']);
      await t.as(exporter).get('/reports/daily-sales/export?format=xlsx').expect(403); // export alone does not open financial reports
      await t.as(exporter).get(`/reports/requests-by-status/export?format=csv&${MARCH}`).expect(200);
    });

    it('validates keys and parameters', async () => {
      await t.as(accountant).get('/reports/no-such-report').expect(404);
      await t.as(accountant).get('/reports/requests-by-status?from=2025-03-31&to=2025-03-01').expect(400);
      await t.as(accountant).get('/reports/requests-by-status?range=yesterday&from=2025-03-01').expect(400);
      await t.as(accountant).get('/reports/requests-by-status?tenantId=' + beta.id).expect(400);
      await t.as(accountant).get('/reports/requests-by-status?branchId=nope').expect(400);
      const long = await t.as(accountant).get('/reports/daily-sales?from=2024-01-01&to=2025-06-30').expect(422);
      expect(long.body.code).toBe('PERIOD_TOO_LONG');
      const none = await t.as(accountant).get('/reports/refunds/drilldown').expect(422);
      expect(none.body.code).toBe('NO_DRILLDOWN');
    });

    it('resolves the period: explicit dates, a relative range, or the default month to date', async () => {
      expect((await run(accountant, 'requests-by-status', MARCH)).period).toEqual({ from: '2025-03-01', to: '2025-03-31' });
      expect((await run(accountant, 'requests-by-status', '')).period).toEqual({ from: `${dubaiDay(0).slice(0, 8)}01`, to: dubaiDay(0) });
      expect((await run(accountant, 'requests-by-status', 'range=yesterday')).period).toEqual({ from: dubaiDay(-1), to: dubaiDay(-1) });
      const r = await run(accountant, 'requests-by-status', MARCH);
      expect(r).toMatchObject({ key: 'requests-by-status', timeZone: 'Asia/Dubai', currency: 'AED', branchIds: null });
      expect(typeof r.generatedAt).toBe('string');
    });
  });

  describe('requests by status', () => {
    it('counts the requests created in the period by their current status', async () => {
      const r = await run(accountant, 'requests-by-status');
      // q1-q4 completed, q5 in preparation, q6 submitted, q7 cancelled, q9 draft = 8 (q8 was created in February)
      expect(r.rows.map((x: any) => [x.statusKey, x.count, x.share])).toEqual([['DRAFT', 1, 12.5], ['SUBMITTED', 1, 12.5], ['IN_PREPARATION', 1, 12.5], ['COMPLETED', 4, 50], ['CANCELLED', 1, 12.5]]);
      expect(r.rows.find((x: any) => x.statusKey === 'SUBMITTED').status).toBe('New');
      expect(r.totals).toEqual({ status: 'Total', count: 8, share: 100 });
      expect(r.columns).toEqual([{ key: 'status', label: 'Status', type: 'text' }, { key: 'count', label: 'Requests', type: 'number' }, { key: 'share', label: 'Share', type: 'percent' }]);
      expect(r.chart).toEqual({ type: 'pie', x: 'status', series: [{ key: 'count', label: 'Requests' }] });
    });

    it('is branch scoped: by filter, and by the branches of the viewer', async () => {
      const filtered = await run(accountant, 'requests-by-status', `${MARCH}&branchId=${b2}`);
      expect(filtered.totals.count).toBe(2);
      expect(filtered.branchIds).toEqual([b2]);
      const own = await run(managerB2, 'requests-by-status');
      expect(own.rows.map((x: any) => [x.statusKey, x.count])).toEqual([['IN_PREPARATION', 1], ['COMPLETED', 1]]);
      const refused = await t.as(managerB2).get(`/reports/requests-by-status?${MARCH}&branchId=${b1}`).expect(403);
      expect(refused.body.code).toBe('BRANCH_FORBIDDEN');
    });

    it('drills down to the requests, with ids', async () => {
      const d = await drill(accountant, 'requests-by-status', `${MARCH}&status=COMPLETED`);
      expect(d.meta).toMatchObject({ total: 4, page: 1 });
      expect(d.rows.map((x: any) => x.id)).toEqual([ref.q1, ref.q2, ref.q3, ref.q4]);
      expect(d.rows[0]).toMatchObject({ resourceType: 'ServiceRequest', customer: 'Fatima Al Mansoori', service: 'Residence visa', created: '2025-03-02', status: 'Completed' });
      const paged = await drill(accountant, 'requests-by-status', `${MARCH}&page=2&pageSize=3`);
      expect(paged.meta).toMatchObject({ total: 8, page: 2, pageSize: 3, totalPages: 3 });
      expect(paged.rows).toHaveLength(3);
      // Without customer.read the customer is identified by number only.
      const anonymous = await drill(opsOnly, 'requests-by-status', `${MARCH}&status=COMPLETED`);
      expect(anonymous.rows[0].customer).toMatch(/^CUS-/);
    });
  });

  describe('staff workload and performance', () => {
    it('shows assigned, completed, average handling time and the open workload', async () => {
      const r = await run(accountant, 'staff-workload');
      const row = (actor: Actor) => r.rows.find((x: any) => x.membershipId === actor.membershipId);
      // op1: assigned q1, q2, q4 (first), q5 = 4; completed q1 48 h, q2 12 h, q8 216 h -> average 92.0; open q5 (overdue)
      expect(row(op1)).toMatchObject({ role: 'Typing Operator', assigned: 4, completed: 3, avgHandlingHours: 92, openRequests: 1, overdueRequests: 1, openTasks: 0 });
      // op2: assigned q3, q4 = 2; completed q3 96 h, q4 24 h -> average 60.0; one open task
      expect(row(op2)).toMatchObject({ assigned: 2, completed: 2, avgHandlingHours: 60, openRequests: 0, overdueRequests: 0, openTasks: 1 });
      expect(r.rows).toHaveLength(2);
      expect(r.totals).toMatchObject({ assigned: 6, completed: 5, openRequests: 1, overdueRequests: 1, openTasks: 1 });
    });

    it('is branch scoped and drills down to the cases of one person', async () => {
      const r = await run(accountant, 'staff-workload', `${MARCH}&branchId=${b2}`);
      expect(r.rows.find((x: any) => x.membershipId === op1.membershipId)).toMatchObject({ assigned: 1, completed: 0, avgHandlingHours: null, openRequests: 1 });
      expect(r.rows.find((x: any) => x.membershipId === op2.membershipId)).toMatchObject({ assigned: 1, completed: 1, avgHandlingHours: 96 });
      const d = await drill(accountant, 'staff-workload', `${MARCH}&membershipId=${op1.membershipId}`);
      expect(d.rows.map((x: any) => x.id).sort()).toEqual([ref.q1, ref.q2, ref.q5, ref.q8].sort());
      expect(d.rows[0]).toMatchObject({ id: ref.q5, overdue: 'Yes', status: 'In preparation' }); // open cases first
    });
  });

  describe('branch performance', () => {
    it('counts submissions, completions and processing time per branch', async () => {
      const r = await run(accountant, 'branch-performance');
      const row = (id: string) => r.rows.find((x: any) => x.branchId === id);
      // b1: submitted q1, q2, q4, q6, q7 = 5; completed q1, q2, q4, q8 = 4, average (48 + 12 + 24 + 216) / 4 = 75.0; open q6
      expect(row(b1)).toMatchObject({ requestsSubmitted: 5, requestsCompleted: 4, avgProcessingHours: 75, openRequests: 1, overdueRequests: 0 });
      // b2: submitted q3, q5; completed q3 (96 h); open q5, overdue
      expect(row(b2)).toMatchObject({ requestsSubmitted: 2, requestsCompleted: 1, avgProcessingHours: 96, openRequests: 1, overdueRequests: 1 });
      expect(r.totals).toMatchObject({ requestsSubmitted: 7, requestsCompleted: 5, openRequests: 2, overdueRequests: 1 });
      expect(r.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(['serviceFeeRevenue', 'grossCollections', 'outstanding']));
      expect(row(b1)).toMatchObject({ serviceFeeRevenue: '0.00', grossCollections: '0.00' });
    });

    it('leaves the money columns out for viewers without report.financial', async () => {
      const r = await run(opsOnly, 'branch-performance');
      expect(r.columns.map((c: any) => c.key)).toEqual(['branch', 'requestsSubmitted', 'requestsCompleted', 'avgProcessingHours', 'openRequests', 'overdueRequests']);
      expect(r.rows[0]).not.toHaveProperty('serviceFeeRevenue');
      expect(r.totals).not.toHaveProperty('grossCollections');
      expect(r.notes.join(' ')).toMatch(/only to people who may view financial reports/);
      expect((await run(managerB2, 'branch-performance')).rows.map((x: any) => x.branchId)).toEqual([b2]);
    });
  });

  describe('customer growth', () => {
    it('counts new customers per month and the running total', async () => {
      const r = await run(accountant, 'customer-growth', 'from=2025-01-01&to=2025-03-31');
      // 2 before; January +2 (one archived, still a customer); February 0; March +3 (the merged duplicate is not counted)
      expect(r.rows).toEqual([
        { month: '2025-01', newCustomers: 2, individuals: 2, businesses: 0, totalCustomers: 4, growth: 100 },
        { month: '2025-02', newCustomers: 0, individuals: 0, businesses: 0, totalCustomers: 4, growth: 0 },
        { month: '2025-03', newCustomers: 3, individuals: 2, businesses: 1, totalCustomers: 7, growth: 75 },
      ]);
      expect(r.totals).toMatchObject({ newCustomers: 5, totalCustomers: 7, growth: 250 });
      expect(r.branchIds).toBeNull();
      expect(r.notes.join(' ')).toMatch(/whole centre/);
      const d = await drill(accountant, 'customer-growth', 'from=2025-01-01&to=2025-03-31&month=2025-03');
      expect(d.meta.total).toBe(3);
      expect(d.rows[0]).toMatchObject({ id: ref.march1, resourceType: 'Customer', name: 'March Individual', created: '2025-03-03' });
      expect((await drill(opsOnly, 'customer-growth', 'from=2025-01-01&to=2025-03-31&month=2025-03')).rows[0]).not.toHaveProperty('name');
    });
  });

  describe('expiry reminders', () => {
    it('shows documents that expire soon and what happened to the reminders of the period', async () => {
      const r = await run(accountant, 'expiry-reminders');
      expect(r.rows).toEqual([
        { documentTypeKey: 'passport', documentType: 'Passport', upcoming: 2, renewalsStarted: 1, remindersSent: 2, skippedNoConsent: 1, skippedOptOut: 0, failed: 0 },
        { documentTypeKey: 'emirates_id', documentType: 'Emirates ID', upcoming: 1, renewalsStarted: 0, remindersSent: 0, skippedNoConsent: 0, skippedOptOut: 1, failed: 1 },
      ]);
      expect(r.totals).toMatchObject({ upcoming: 3, renewalsStarted: 1, remindersSent: 2, skippedNoConsent: 1, skippedOptOut: 1, failed: 1 });
      const wider = await run(accountant, 'expiry-reminders', `${MARCH}&withinDays=60`);
      expect(wider.rows.find((x: any) => x.documentTypeKey === 'residence_visa')).toMatchObject({ upcoming: 1, remindersSent: 0 });
      expect(wider.totals.upcoming).toBe(4);
    });

    it('drills down to the schedules and to the reminders', async () => {
      const upcoming = await drill(accountant, 'expiry-reminders', `${MARCH}&kind=upcoming`);
      expect(upcoming.rows.map((x: any) => [x.documentTypeKey, x.daysLeft, x.status, x.renewalStarted])).toEqual([['passport', 5, 'ACTIVE', 'Yes'], ['emirates_id', 10, 'ACTIVE', 'No'], ['passport', 20, 'PAUSED', 'No']]);
      expect(upcoming.rows[0]).toMatchObject({ resourceType: 'ReminderSchedule', customer: 'Fatima Al Mansoori', expiryDate: dubaiDay(5) });
      const sent = await drill(accountant, 'expiry-reminders', `${MARCH}&kind=sent&documentTypeKey=passport`);
      expect(sent.rows.map((x: any) => [x.date, x.status, x.offsetDays])).toEqual([['2025-03-03', 'SENT', 90], ['2025-03-20', 'SENT', 60], ['2025-03-21', 'SKIPPED_NO_CONSENT', 90]]);
    });
  });

  describe('document processing time', () => {
    it('gives average, median and 90th percentile per service, and the time in verification', async () => {
      const r = await run(accountant, 'document-processing-time');
      const row = (id: string) => r.rows.find((x: any) => x.serviceId === id);
      // service 1: 12, 48, 96 h -> average 52.0, median 48.0, p90 = 48 + 0.8 x 48 = 86.4;  verification 3, 6, 24 h -> 11.0 / 6.0 / 20.4
      expect(row(ref.s1)).toMatchObject({ service: 'Residence visa', completed: 3, avgHours: 52, medianHours: 48, p90Hours: 86.4, avgVerificationHours: 11, medianVerificationHours: 6, p90VerificationHours: 20.4 });
      // service 2: 24, 216 h -> 120.0 / 120.0 / 24 + 0.9 x 192 = 196.8;  verification: only q8, 12 h
      expect(row(ref.s2)).toMatchObject({ completed: 2, avgHours: 120, medianHours: 120, p90Hours: 196.8, avgVerificationHours: 12, medianVerificationHours: 12, p90VerificationHours: 12 });
      // all five: 12, 24, 48, 96, 216 -> 79.2 / 48.0 / 96 + 0.6 x 120 = 168.0;  verification 3, 6, 12, 24 -> 11.3 / 9.0 / 12 + 0.7 x 12 = 20.4
      expect(r.totals).toMatchObject({ service: 'All services', completed: 5, avgHours: 79.2, medianHours: 48, p90Hours: 168, avgVerificationHours: 11.3, medianVerificationHours: 9, p90VerificationHours: 20.4 });
    });

    it('is branch scoped and drills down to the requests', async () => {
      const r = await run(accountant, 'document-processing-time', `${MARCH}&branchId=${b2}`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ serviceId: ref.s1, completed: 1, avgHours: 96, avgVerificationHours: 24 });
      const d = await drill(accountant, 'document-processing-time', `${MARCH}&serviceId=${ref.s1}`);
      expect(d.rows.map((x: any) => [x.id, x.totalHours, x.verificationHours])).toEqual([[ref.q3, 96, 24], [ref.q1, 48, 6], [ref.q2, 12, 3]]);
      const empty = await run(accountant, 'document-processing-time', 'from=2024-01-01&to=2024-01-31');
      expect(empty.rows).toEqual([]);
      expect(empty.totals).toMatchObject({ completed: 0, avgHours: null });
    });
  });

  describe('customer satisfaction', () => {
    it('gives the distribution and the average of the ratings', async () => {
      const r = await run(accountant, 'customer-satisfaction');
      expect(r.rows.map((x: any) => [x.ratingValue, x.count, x.share, x.aboutRequests, x.aboutTickets])).toEqual([[5, 2, 40, 1, 1], [4, 1, 20, 1, 0], [3, 0, 0, 0, 0], [2, 1, 20, 1, 0], [1, 1, 20, 0, 1]]);
      expect(r.totals).toMatchObject({ rating: 'Average 3.40 of 5', count: 5, share: 100, average: 3.4, satisfiedShare: 60 });
    });

    it('with a branch, counts only ratings of requests of that branch', async () => {
      const r = await run(accountant, 'customer-satisfaction', `${MARCH}&branchId=${b2}`);
      expect(r.totals).toMatchObject({ count: 1, average: 4 });
      expect(r.notes.join(' ')).toMatch(/support tickets have no branch/);
      const d = await drill(accountant, 'customer-satisfaction', `${MARCH}&rating=5`);
      expect(d.rows.map((x: any) => [x.rating, x.about])).toEqual([[5, 'Support ticket'], [5, 'Request']]);
      expect(d.rows[1]).toMatchObject({ requestId: ref.q1, comment: 'Very fast', resourceType: 'CustomerFeedback' });
      const none = await run(accountant, 'customer-satisfaction', 'from=2024-01-01&to=2024-01-31');
      expect(none.totals).toMatchObject({ rating: 'No ratings', count: 0, average: null, share: null });
    });
  });

  describe('tenant isolation', () => {
    it('another centre sees only its own rows in every report', async () => {
      const status = await run(beta.owner, 'requests-by-status');
      expect(status.rows.map((x: any) => [x.statusKey, x.count])).toEqual([['COMPLETED', 1]]);
      expect((await run(beta.owner, 'staff-workload')).rows).toEqual([]);
      expect((await run(beta.owner, 'customer-satisfaction')).totals.count).toBe(0);
      expect((await run(beta.owner, 'expiry-reminders')).rows).toEqual([]);
      const growth = await run(beta.owner, 'customer-growth', 'from=2025-03-01&to=2025-03-31');
      expect(growth.rows[0]).toMatchObject({ newCustomers: 1, totalCustomers: 1 });
      expect((await run(beta.owner, 'document-processing-time')).totals).toMatchObject({ completed: 1, avgHours: 24 });
    });

    it('ids of another centre lead nowhere', async () => {
      await t.as(beta.owner).get(`/reports/requests-by-status?${MARCH}&branchId=${b1}`).expect(404);
      expect((await drill(beta.owner, 'staff-workload', `${MARCH}&membershipId=${op1.membershipId}`)).rows).toEqual([]);
      expect((await drill(beta.owner, 'document-processing-time', `${MARCH}&serviceId=${ref.s1}`)).rows).toEqual([]);
      expect((await drill(beta.owner, 'requests-by-status', MARCH)).meta.total).toBe(1);
    });
  });
});
