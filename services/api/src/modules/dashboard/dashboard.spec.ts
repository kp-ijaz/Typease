import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import {
  addBranch, addStaffWithPermissions, creditNote, dubaiDay, dubaiDayStart, issueInvoice, line, pay, refund, seedCustomer, seedHistory, seedIssuedInvoice, seedReminder, seedRequest, seedService, seedTask,
} from '../reports/fixtures';

/**
 * Every figure asserted here was worked out by hand from the fixture below
 * (see the comments next to the fixture), not derived from the code under test.
 */
describe('Centre dashboard', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let b1: string;
  let b2: string;
  let accountant: Actor;
  let managerB2: Actor;
  let operator: Actor;
  let reviewer: Actor;
  let receptionist: Actor;
  let limited: Actor; // request.read.all + reminder.read, nothing else
  const ids: Record<string, string> = {};

  const HOUR = 3_600_000;
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
  const yesterdayNoon = () => new Date(dubaiDayStart(-1).getTime() + 12 * HOUR);

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant();
    beta = await t.createTenant();
    b1 = alpha.headOfficeId;
    b2 = (await addBranch(t, alpha)).id;
    accountant = await t.addStaff(alpha, 'accountant');
    managerB2 = await t.addStaff(alpha, 'manager', { branchIds: [b2] });
    operator = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    receptionist = await t.addStaff(alpha, 'receptionist');
    limited = await addStaffWithPermissions(t, alpha, ['request.read.all', 'reminder.read']);

    const service = await seedService(t, alpha, { name: 'Visa typing' });
    const customer = await seedCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' });
    const other = await seedCustomer(t, alpha, { fullName: 'Omar Khalid' });
    const base = { customerId: customer.id, serviceId: service.id };
    const threeDaysAgo = ago(72);

    // ---- requests (15 live rows + 1 deleted). Branch 1 unless marked b2.
    const new1 = await seedRequest(t, alpha, { ...base, status: 'SUBMITTED', createdAt: threeDaysAgo }); //                        new
    await seedRequest(t, alpha, { ...base, status: 'SUBMITTED', branchId: b2, targetDate: ago(5) }); //                             new, b2, OVERDUE
    await seedRequest(t, alpha, { ...base, status: 'SUBMITTED', deletedAt: new Date() }); //                                       deleted: never counted
    await seedRequest(t, alpha, { ...base, status: 'UNDER_REVIEW', createdAt: yesterdayNoon() }); //                                pending verification (created yesterday)
    await seedRequest(t, alpha, { ...base, status: 'AWAITING_CUSTOMER' }); //                                                      awaiting customer
    await seedRequest(t, alpha, { ...base, status: 'QUOTED' }); //                                                                 awaiting customer
    await seedRequest(t, alpha, { ...base, status: 'AWAITING_PAYMENT' }); //                                                       awaiting payment
    await seedRequest(t, alpha, { ...base, status: 'READY_FOR_PROCESSING', branchId: b2 }); //                                     ready, b2
    await seedRequest(t, alpha, { ...base, status: 'IN_PREPARATION', assignedToId: operator.membershipId, targetDate: ago(2), priority: 'URGENT' }); // in progress, operator, OVERDUE
    const opB2 = await seedRequest(t, alpha, { customerId: other.id, serviceId: service.id, status: 'IN_PREPARATION', assignedToId: operator.membershipId, branchId: b2, targetDate: new Date(Date.now() + 48 * HOUR) }); // in progress, operator, b2
    await seedRequest(t, alpha, { ...base, status: 'PENDING_APPROVAL' }); //                                                       in progress
    await seedRequest(t, alpha, { ...base, status: 'COMPLETED', completedAt: new Date(Date.now() - 60_000), targetDate: ago(30) }); // completed today (a past target date is not "overdue")
    await seedRequest(t, alpha, { ...base, status: 'COMPLETED', completedAt: new Date(Date.now() - 30_000), branchId: b2 }); //     completed today, b2
    await seedRequest(t, alpha, { ...base, status: 'COMPLETED', completedAt: yesterdayNoon(), createdAt: threeDaysAgo }); //        completed yesterday
    await seedRequest(t, alpha, { ...base, status: 'CANCELLED', createdAt: threeDaysAgo });
    await seedRequest(t, alpha, { ...base, status: 'DRAFT', submittedAt: null });
    Object.assign(ids, { new1: new1.id, opB2: opB2.id, customer: customer.id, other: other.id, service: service.id });

    // ---- recent activity
    await seedHistory(t, alpha, new1.id, null, 'DRAFT', ago(3));
    await seedHistory(t, alpha, new1.id, 'DRAFT', 'SUBMITTED', ago(2), alpha.owner.userId);
    await seedHistory(t, alpha, new1.id, 'SUBMITTED', 'SUBMITTED', ago(1)); // a note, not a status change
    await seedHistory(t, alpha, opB2.id, 'READY_FOR_PROCESSING', 'IN_PREPARATION', ago(0.5), operator.userId);

    // ---- tasks
    await seedTask(t, alpha, { assigneeId: operator.membershipId!, status: 'OPEN', dueAt: ago(1) });
    await seedTask(t, alpha, { assigneeId: operator.membershipId!, status: 'DONE' });
    await seedTask(t, alpha, { assigneeId: reviewer.membershipId!, status: 'IN_PROGRESS' });

    // ---- expiries: two inside the next 30 days
    await seedReminder(t, alpha, { customerId: customer.id, expiryDate: dubaiDay(10), subjectLabel: 'Fatima Al Mansoori', documentTypeKey: 'passport' });
    await seedReminder(t, alpha, { customerId: other.id, expiryDate: dubaiDay(29), status: 'PAUSED', subjectLabel: 'Omar Khalid', documentTypeKey: 'emirates_id' });
    await seedReminder(t, alpha, { customerId: customer.id, expiryDate: dubaiDay(31), documentTypeKey: 'residence_visa' }); //  too far
    await seedReminder(t, alpha, { customerId: customer.id, expiryDate: dubaiDay(-1), documentTypeKey: 'labour_card' }); //     already expired
    await seedReminder(t, alpha, { customerId: customer.id, expiryDate: dubaiDay(5), status: 'CANCELLED', documentTypeKey: 'trade_licence' });

    // ---- money, through the finance API
    // inv1 (b1): service 100.00 + 5% tax 5.00 + government 200.00 = 305.00, paid in full, then 30.50 refunded (charge stays)
    const inv1 = await issueInvoice(t, accountant, { customerId: customer.id, branchId: b1, items: [line('SERVICE_FEE', '100.00', { taxRatePercent: 5 }), line('GOVERNMENT_FEE', '200.00', { taxRatePercent: 0 })] });
    const pay1 = await pay(t, accountant, { invoiceId: inv1.id, amount: '305.00', branchId: b1, customerId: customer.id });
    await refund(t, accountant, alpha.owner, { paymentId: pay1.id, invoiceId: inv1.id, amount: '30.50' });
    // inv2 (b2, the operator's case): service 200.00 - 20.00 discount = 180.00 + 5% tax 9.00 + third party 50.00 = 239.00;
    //                                 100.00 paid; credit note 21.00 on the service fee (20.00 + 1.00 tax)
    const inv2 = await issueInvoice(t, accountant, {
      customerId: other.id, branchId: b2, requestId: opB2.id, issuer: alpha.owner,
      items: [line('SERVICE_FEE', '200.00', { discountAmount: '20.00', taxRatePercent: 5 }), line('THIRD_PARTY_FEE', '50.00', { taxRatePercent: 0 })],
    });
    await pay(t, accountant, { invoiceId: inv2.id, amount: '100.00', branchId: b2, customerId: other.id });
    await creditNote(t, accountant, { invoiceId: inv2.id, amount: '21.00', breakdown: { SERVICE_FEE: '21.00' } });
    // inv3 (b1): issued YESTERDAY: service 50.00 + tax 2.50 = 52.50, paid yesterday
    const inv3 = await seedIssuedInvoice(t, alpha, { customerId: customer.id, issuedAt: yesterdayNoon(), serviceFee: '50.00' });
    await pay(t, accountant, { invoiceId: inv3.id, amount: '52.50', branchId: b1, customerId: customer.id, receivedAt: yesterdayNoon() });

    // ---- another centre with its own numbers
    const bService = await seedService(t, beta);
    const bCustomer = await seedCustomer(t, beta, { fullName: 'Beta Customer' });
    await seedRequest(t, beta, { customerId: bCustomer.id, serviceId: bService.id, status: 'SUBMITTED' });
    const bInvoice = await issueInvoice(t, beta.owner, { customerId: bCustomer.id, items: [line('SERVICE_FEE', '1000.00', { taxRatePercent: 5 })] });
    await pay(t, beta.owner, { invoiceId: bInvoice.id, amount: '1050.00', branchId: beta.headOfficeId, customerId: bCustomer.id });
    await t.settle();
  });
  afterAll(() => t.close());

  const dashboard = async (actor: Actor, query = '') => {
    const res = await t.as(actor).get(`/dashboard${query}`).expect(200);
    return res.body;
  };

  describe('request widgets', () => {
    it('counts every bucket for a viewer of all branches', async () => {
      const d = await dashboard(alpha.owner);
      expect(d.timeZone).toBe('Asia/Dubai');
      expect(d.today).toBe(dubaiDay(0));
      expect(d.scope).toEqual({ branchIds: null, requests: 'ALL', finance: 'ALL' });
      expect(d.requests).toMatchObject({
        newRequests: 2, pendingVerification: 1, awaitingCustomer: 2, awaitingPayment: 1, readyForProcessing: 1, inProgress: 3, completedToday: 2, overdue: 2, open: 10, drafts: 1, range: null,
      });
      expect(d.requests.byStatus).toMatchObject({ SUBMITTED: 2, COMPLETED: 3, CANCELLED: 1, IN_PREPARATION: 2 });
    });

    it('a branch filter narrows every count, and equals what a member of only that branch sees', async () => {
      const expected = { newRequests: 1, pendingVerification: 0, awaitingCustomer: 0, awaitingPayment: 0, readyForProcessing: 1, inProgress: 1, completedToday: 1, overdue: 1, open: 3, drafts: 0 };
      const filtered = await dashboard(alpha.owner, `?branchId=${b2}`);
      expect(filtered.requests).toMatchObject(expected);
      expect(filtered.scope.branchIds).toEqual([b2]);
      const own = await dashboard(managerB2);
      expect(own.requests).toMatchObject(expected);
      expect(own.scope.branchIds).toEqual([b2]);
    });

    it('refuses a branch the member is not assigned to, and does not know branches of another centre', async () => {
      const res = await t.as(managerB2).get(`/dashboard?branchId=${b1}`).expect(403);
      expect(res.body.code).toBe('BRANCH_FORBIDDEN');
      await t.as(alpha.owner).get(`/dashboard?branchId=${beta.headOfficeId}`).expect(404);
      await t.as(alpha.owner).get('/dashboard?branchId=not-a-uuid').expect(400);
      await t.as(alpha.owner).get('/dashboard?tenantId=' + beta.id).expect(400);
    });

    it('operators limited to assigned requests get the counts of their own cases only', async () => {
      const d = await dashboard(operator);
      expect(d.scope.requests).toBe('ASSIGNED');
      expect(d.requests).toMatchObject({ newRequests: 0, pendingVerification: 0, awaitingCustomer: 0, awaitingPayment: 0, readyForProcessing: 0, inProgress: 2, completedToday: 0, overdue: 1, open: 2, drafts: 0 });
    });

    it('a date range narrows the population by creation date and adds created / completed in the period', async () => {
      const d = await dashboard(alpha.owner, `?from=${dubaiDay(-1)}&to=${dubaiDay(0)}`);
      expect(d.filters).toMatchObject({ from: dubaiDay(-1), to: dubaiDay(0) });
      // Three requests were created three days ago (one SUBMITTED, one COMPLETED, one CANCELLED): 15 - 3 = 12 created in the period.
      expect(d.requests).toMatchObject({ newRequests: 1, pendingVerification: 1, inProgress: 3, completedToday: 2, overdue: 2 });
      expect(d.requests.range).toEqual({ from: dubaiDay(-1), to: dubaiDay(0), created: 12, completed: 3 });
      await t.as(alpha.owner).get(`/dashboard?from=${dubaiDay(0)}&to=${dubaiDay(-1)}`).expect(400);
    });

    it('"today" follows the time zone of the centre', async () => {
      const zone = 'America/Los_Angeles';
      const gamma = await t.createTenant();
      await t.sys.tenant.update({ where: { id: gamma.id }, data: { timezone: zone } });
      const service = await seedService(t, gamma);
      const customer = await seedCustomer(t, gamma);
      const now = new Date();
      // Local wall clock of the zone, read through Intl independently of the code under test.
      const wall = new Date(now.toLocaleString('en-US', { timeZone: zone }));
      const sinceMidnight = wall.getHours() * HOUR + wall.getMinutes() * 60_000 + wall.getSeconds() * 1000;
      const localMidnight = new Date(now.getTime() - sinceMidnight);
      await seedRequest(t, gamma, { customerId: customer.id, serviceId: service.id, status: 'COMPLETED', completedAt: new Date(now.getTime() - 1000) });
      await seedRequest(t, gamma, { customerId: customer.id, serviceId: service.id, status: 'COMPLETED', completedAt: new Date(localMidnight.getTime() - 120_000) });
      const d = await dashboard(gamma.owner);
      expect(d.timeZone).toBe(zone);
      expect(d.today).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now));
      expect(d.requests.completedToday).toBe(1);
    });
  });

  describe('financial widgets', () => {
    it("shows earned service revenue and gross collections side by side, clearly labelled", async () => {
      const d = await dashboard(alpha.owner);
      // revenue: 100.00 + 180.00 - 20.00 credit = 260.00        tax: 5.00 + 9.00 - 1.00 = 13.00
      // cash:    305.00 + 100.00 - 30.50 refund = 374.50         open: 30.50 (inv1 after the refund) + 118.00 (inv2) = 148.50
      expect(d.finance).toMatchObject({
        serviceRevenueToday: '260.00', otherRevenueToday: '0.00', taxInvoicedToday: '13.00', grossCollectionsToday: '374.50', paymentsToday: '405.00', refundsToday: '30.50',
        outstandingReceivables: '148.50', openInvoices: 2, range: null,
      });
      expect(d.finance.labels.serviceRevenueToday).toMatch(/earned service fees/i);
      expect(d.finance.labels.grossCollectionsToday).toMatch(/gross collections/i);
      expect(d.finance.notes.join(' ')).toMatch(/accrual basis/);
      expect(d.finance.notes.join(' ')).toMatch(/cash basis/);
    });

    it('is scoped to the branch', async () => {
      const expected = { serviceRevenueToday: '160.00', taxInvoicedToday: '8.00', grossCollectionsToday: '100.00', outstandingReceivables: '118.00', openInvoices: 1 };
      expect((await dashboard(alpha.owner, `?branchId=${b2}`)).finance).toMatchObject(expected);
      expect((await dashboard(managerB2)).finance).toMatchObject(expected);
    });

    it('adds the figures of a selected period', async () => {
      const d = await dashboard(accountant, `?from=${dubaiDay(-1)}&to=${dubaiDay(0)}`);
      // + yesterday: 50.00 service fee, 2.50 tax, 52.50 received
      expect(d.finance.range).toEqual({ from: dubaiDay(-1), to: dubaiDay(0), serviceRevenue: '310.00', otherRevenue: '0.00', taxInvoiced: '15.50', grossCollections: '427.00' });
      expect(d.finance.serviceRevenueToday).toBe('260.00');
    });

    it('is null - not zero - for viewers without a financial permission', async () => {
      const d = await dashboard(reviewer);
      expect(d.finance).toBeNull();
      expect(d.scope.finance).toBe('NONE');
      expect(d.requests.newRequests).toBe(2);
      expect((await dashboard(limited)).finance).toBeNull();
    });

    it('viewers with invoice.read see it; cash figures need access to payments', async () => {
      const d = await dashboard(receptionist); // invoice.read + payment.read
      expect(d.finance).toMatchObject({ serviceRevenueToday: '260.00', grossCollectionsToday: '374.50' });
      const invoiceOnly = await addStaffWithPermissions(t, alpha, ['invoice.read']);
      const v = await dashboard(invoiceOnly);
      expect(v.finance).toMatchObject({ serviceRevenueToday: '260.00', grossCollectionsToday: null, paymentsToday: null, outstandingReceivables: '148.50' });
      expect(v.requests).toBeNull();
    });

    it('operators see only the invoices of their own cases, and no cash figures', async () => {
      const d = await dashboard(operator);
      expect(d.scope.finance).toBe('OWN_CASES');
      expect(d.finance).toMatchObject({ serviceRevenueToday: '160.00', grossCollectionsToday: null, outstandingReceivables: '118.00', openInvoices: 1 });
    });
  });

  describe('staff workload, expiries and recent activity', () => {
    it('lists open requests and tasks per person', async () => {
      const d = await dashboard(alpha.owner);
      expect(d.staffWorkload.unassignedRequests).toBe(8);
      const op = d.staffWorkload.staff.find((s: any) => s.membershipId === operator.membershipId);
      expect(op).toMatchObject({ roleKey: 'operator', openRequests: 2, overdueRequests: 1, highPriorityRequests: 1, openTasks: 1, overdueTasks: 1 });
      const rev = d.staffWorkload.staff.find((s: any) => s.membershipId === reviewer.membershipId);
      expect(rev).toMatchObject({ openRequests: 0, openTasks: 1 });
      expect(d.staffWorkload.staff).toHaveLength(2);
      expect(d.staffWorkload.staff[0].membershipId).toBe(operator.membershipId);
    });

    it('is branch scoped, and an operator only sees their own line', async () => {
      const d = await dashboard(managerB2);
      expect(d.staffWorkload.unassignedRequests).toBe(2);
      expect(d.staffWorkload.staff.find((s: any) => s.membershipId === operator.membershipId)).toMatchObject({ openRequests: 1, overdueRequests: 0 });
      const own = await dashboard(operator);
      expect(own.staffWorkload.unassignedRequests).toBeNull();
      expect(own.staffWorkload.staff).toHaveLength(1);
      expect(own.staffWorkload.staff[0]).toMatchObject({ membershipId: operator.membershipId, openRequests: 2, openTasks: 1 });
    });

    it('shows documents that expire within 30 days, soonest first', async () => {
      const d = await dashboard(alpha.owner);
      expect(d.upcomingExpiries).toMatchObject({ withinDays: 30, total: 2, from: dubaiDay(0), to: dubaiDay(30) });
      expect(d.upcomingExpiries.items.map((i: any) => [i.documentTypeKey, i.expiryDate, i.daysLeft, i.status, i.customerName])).toEqual([
        ['passport', dubaiDay(10), 10, 'ACTIVE', 'Fatima Al Mansoori'],
        ['emirates_id', dubaiDay(29), 29, 'PAUSED', 'Omar Khalid'],
      ]);
      expect(d.upcomingExpiries.items[0].documentTypeName).toBe('Passport');
    });

    it('hides names from viewers without customer.read, and the widget from viewers without reminder.read', async () => {
      const d = await dashboard(limited);
      expect(d.upcomingExpiries.total).toBe(2);
      expect(d.upcomingExpiries.items[0]).toMatchObject({ customerName: null, subjectLabel: null, documentTypeKey: 'passport' });
      expect(d.upcomingExpiries.items[0].customerNo).toMatch(/^CUS-/);
      expect((await dashboard(accountant)).upcomingExpiries).toBeNull();
    });

    it('shows the latest status changes, newest first, without notes', async () => {
      const d = await dashboard(alpha.owner);
      expect(d.recentActivity.map((a: any) => [a.requestId, a.from, a.to])).toEqual([
        [ids.opB2, 'READY_FOR_PROCESSING', 'IN_PREPARATION'],
        [ids.new1, 'DRAFT', 'SUBMITTED'],
        [ids.new1, null, 'DRAFT'],
      ]);
      expect(d.recentActivity[0]).toMatchObject({ customerName: 'Omar Khalid', serviceName: 'Visa typing', actorType: 'STAFF', toLabel: { en: 'In preparation' } });
      expect(d.recentActivity[1].actorName).toMatch(/^Owner /);
    });

    it('scopes recent activity like the requests, and gives customer names only with customer.read', async () => {
      expect((await dashboard(managerB2)).recentActivity.map((a: any) => a.requestId)).toEqual([ids.opB2]);
      expect((await dashboard(operator)).recentActivity.map((a: any) => a.requestId)).toEqual([ids.opB2]);
      const d = await dashboard(limited);
      expect(d.recentActivity).toHaveLength(3);
      expect(d.recentActivity.every((a: any) => a.customerName === null && /^CUS-/.test(a.customerNo))).toBe(true);
    });
  });

  describe('trends', () => {
    it('gives requests created / completed and service revenue per day', async () => {
      const res = await t.as(alpha.owner).get(`/dashboard/trends?from=${dubaiDay(-1)}&to=${dubaiDay(0)}`).expect(200);
      expect(res.body.days).toEqual([
        { date: dubaiDay(-1), requestsCreated: 1, requestsCompleted: 1, serviceRevenue: '50.00', grossCollections: '52.50' },
        { date: dubaiDay(0), requestsCreated: 11, requestsCompleted: 2, serviceRevenue: '260.00', grossCollections: '374.50' },
      ]);
    });

    it('defaults to the last 30 days, is branch scoped and hides money without permission', async () => {
      const all = await t.as(alpha.owner).get('/dashboard/trends').expect(200);
      expect(all.body.days).toHaveLength(30);
      expect(all.body.to).toBe(dubaiDay(0));
      expect(all.body.from).toBe(dubaiDay(-29));
      const branch = await t.as(managerB2).get(`/dashboard/trends?from=${dubaiDay(0)}&to=${dubaiDay(0)}`).expect(200);
      expect(branch.body.days).toEqual([{ date: dubaiDay(0), requestsCreated: 4, requestsCompleted: 1, serviceRevenue: '160.00', grossCollections: '100.00' }]);
      const noMoney = await t.as(reviewer).get(`/dashboard/trends?from=${dubaiDay(0)}&to=${dubaiDay(0)}`).expect(200);
      expect(noMoney.body.days[0]).toEqual({ date: dubaiDay(0), requestsCreated: 11, requestsCompleted: 2, serviceRevenue: null, grossCollections: null });
      const own = await t.as(operator).get(`/dashboard/trends?from=${dubaiDay(0)}&to=${dubaiDay(0)}`).expect(200);
      expect(own.body.days[0]).toEqual({ date: dubaiDay(0), requestsCreated: 2, requestsCompleted: 0, serviceRevenue: '160.00', grossCollections: null });
      await t.as(alpha.owner).get(`/dashboard/trends?from=2020-01-01&to=${dubaiDay(0)}`).expect(422);
    });
  });

  describe('access and tenant isolation', () => {
    it('is for staff only', async () => {
      const customer = await t.addCustomer(alpha);
      await t.as(customer).get('/dashboard').expect(403);
      await t.as(customer).get('/dashboard/trends').expect(403);
      await t.as(null).get('/dashboard').expect(401);
    });

    it('another centre sees only its own data', async () => {
      const d = await dashboard(beta.owner);
      expect(d.requests).toMatchObject({ newRequests: 1, pendingVerification: 0, inProgress: 0, completedToday: 0, overdue: 0, open: 1 });
      expect(d.finance).toMatchObject({ serviceRevenueToday: '1000.00', taxInvoicedToday: '50.00', grossCollectionsToday: '1050.00', outstandingReceivables: '0.00', openInvoices: 0 });
      expect(d.staffWorkload).toEqual({ unassignedRequests: 1, staff: [] });
      expect(d.upcomingExpiries.total).toBe(0);
      expect(d.recentActivity).toEqual([]);
      // ... and the first centre's numbers did not move.
      expect((await dashboard(alpha.owner)).finance.serviceRevenueToday).toBe('260.00');
    });
  });
});
