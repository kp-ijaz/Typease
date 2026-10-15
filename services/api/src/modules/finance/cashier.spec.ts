import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { localYmd } from '../reports/time';
import { createCustomer, issueInvoice, key, listen, recordPayment } from './fixtures';

describe('Finance: cash register shifts and day-end closing', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let receptionist2: Actor;
  let accountant: Actor;
  let manager: Actor;
  let customerId: string;

  const pay = (actor: Actor, invoice: { id: string; total: string }, method: string, branchId = alpha.headOfficeId) =>
    recordPayment(t, actor, { method, amount: invoice.total, branchId, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] });
  /** A 100.00 service fee + 5% VAT, no pass-through fees: 105.00. */
  const invoice = () => issueInvoice(t, alpha.owner, customerId, { serviceFee: '100.00', governmentFee: '0' });

  beforeAll(async () => {
    t = await listen(await TestApp.create());
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    receptionist2 = await t.addStaff(alpha, 'receptionist');
    accountant = await t.addStaff(alpha, 'accountant');
    manager = await t.addStaff(alpha, 'manager');
    customerId = (await createCustomer(t, alpha)).id;
  });
  afterAll(() => t.close());

  let shiftId: string;

  it('opens one shift per person with an opening float', async () => {
    await t.as(receptionist).get('/cash/shifts/current').expect(200).expect((r) => expect(r.body).toEqual({}));
    const opened = await t.as(receptionist).post('/cash/shifts', { branchId: alpha.headOfficeId, openingFloat: '200.00', note: 'Morning' }).expect(201);
    expect(opened.body).toMatchObject({ status: 'OPEN', openingFloat: '200.00', shiftNo: expect.stringMatching(/^SH-\d{6}$/), tally: { expectedCash: '200.00', paymentCount: 0 } });
    shiftId = opened.body.id;
    const again = await t.as(receptionist).post('/cash/shifts', { branchId: alpha.headOfficeId, openingFloat: '0' }).expect(409);
    expect(again.body.code).toBe('SHIFT_ALREADY_OPEN');
    await t.as(receptionist).post('/cash/shifts', { branchId: alpha.headOfficeId, openingFloat: '-5' }).expect(400);
  });

  it('links counter payments to the open shift and keeps a live expected cash', async () => {
    const cash = await pay(receptionist, await invoice(), 'CASH').expect(201);
    const card = await pay(receptionist, await invoice(), 'CARD_POS').expect(201);
    const rows = await t.sys.payment.findMany({ where: { id: { in: [cash.body.id, card.body.id] } }, select: { shiftId: true } });
    expect(rows.every((r) => r.shiftId === shiftId)).toBe(true);
    const current = await t.as(receptionist).get('/cash/shifts/current').expect(200);
    expect(current.body.tally).toMatchObject({ paymentCount: 2, cashIn: '105.00', expectedCash: '305.00', expectedCard: '105.00', byMethod: { CASH: '105.00', CARD_POS: '105.00' } });
  });

  it('takes cash refunds and cash expenses out of the till of the person paying them', async () => {
    const accShift = (await t.as(accountant).post('/cash/shifts', { branchId: alpha.headOfficeId, openingFloat: '500.00' }).expect(201)).body;
    // Cash expense paid from the drawer.
    const expense = await t.as(accountant).post('/expenses', { branchId: alpha.headOfficeId, category: 'OTHER', description: 'Water for the counter', amount: '20.00', paidOn: localYmd(new Date(), 'Asia/Dubai'), method: 'CASH' }).expect(201);
    expect((await t.sys.expense.findUniqueOrThrow({ where: { id: expense.body.id } })).shiftId).toBe(accShift.id);
    // Cash refund: requested by the manager, approved and paid out by the accountant.
    const paid = await pay(receptionist, await invoice(), 'CASH').expect(201);
    const refund = (await t.as(manager).post('/refunds', { paymentId: paid.body.id, amount: '30.00', reason: 'Service partly cancelled' }).set('Idempotency-Key', key()).expect(201)).body;
    await t.as(accountant).post(`/refunds/${refund.id}/approve`, {}).expect(200);
    await t.as(accountant).post(`/refunds/${refund.id}/complete`, { reference: 'CASH-VOUCHER-7' }).expect(200);
    expect((await t.sys.refund.findUniqueOrThrow({ where: { id: refund.id } })).shiftId).toBe(accShift.id);
    const view = await t.as(accountant).get(`/cash/shifts/${accShift.id}`).expect(200);
    expect(view.body.tally).toMatchObject({ cashRefunds: '30.00', cashExpenses: '20.00', expectedCash: '450.00' });
    expect(view.body.expenses).toHaveLength(1);
    expect(view.body.refunds).toHaveLength(1);
  });

  it('closes with a counted till: notes must add up, a shortage is recorded and flagged to the managers', async () => {
    // Expected: 200 float + 105 + 105 (the payment refunded above was taken in this shift) = 410.
    const bad = await t.as(receptionist).post(`/cash/shifts/${shiftId}/close`, { countedCash: '400.00', denominations: { '200': 1, '100': 1 } }).expect(422);
    expect(bad.body.code).toBe('DENOMINATIONS_MISMATCH');
    const closed = await t
      .as(receptionist)
      .post(`/cash/shifts/${shiftId}/close`, { countedCash: '400.00', countedCard: '105.00', denominations: { '200': 1, '100': 1, '50': 2 }, note: 'Short 10' })
      .expect(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', countedCash: '400.00', cashVariance: '-10.00', cardVariance: '0.00', flagged: true, tally: { expectedCash: '410.00' } });
    await t.as(receptionist).post(`/cash/shifts/${shiftId}/close`, { countedCash: '400.00' }).expect(409);
    // A payment taken after closing no longer lands in the closed shift.
    const late = await pay(receptionist, await invoice(), 'CASH').expect(201);
    expect((await t.sys.payment.findUniqueOrThrow({ where: { id: late.body.id } })).shiftId).toBeNull();

    await t.settle();
    const told = await t.sys.notification.findMany({ where: { tenantId: alpha.id, eventKey: 'cash.variance', channel: 'IN_APP' } });
    const recipients = told.map((n) => n.recipientUserId);
    expect(recipients).toEqual(expect.arrayContaining([manager.userId, accountant.userId, alpha.owner.userId]));
    expect(recipients).not.toContain(receptionist.userId);
    expect(told[0]!.subject).toContain('-10.00');
  });

  it('is reviewed by someone else, never by the cashier', async () => {
    await t.as(receptionist).post(`/cash/shifts/${shiftId}/review`, {}).expect(403);
    const reviewed = await t.as(manager).post(`/cash/shifts/${shiftId}/review`, { note: 'Recounted, confirmed short' }).expect(200);
    expect(reviewed.body).toMatchObject({ status: 'REVIEWED', reviewedById: manager.userId });
    await t.as(manager).post(`/cash/shifts/${shiftId}/review`, {}).expect(409);
  });

  it('shows cashiers only their own shifts; managers see all; other centres see nothing', async () => {
    const own = await t.as(receptionist2).get('/cash/shifts').expect(200);
    expect(own.body.data).toHaveLength(0);
    await t.as(receptionist2).get(`/cash/shifts/${shiftId}`).expect(404);
    const all = await t.as(manager).get('/cash/shifts').expect(200);
    expect(all.body.data.map((s: { id: string }) => s.id)).toContain(shiftId);
    await t.as(beta.owner).get(`/cash/shifts/${shiftId}`).expect(404);
    await t.as(receptionist).get('/cash/day-end').query({ date: '2026-01-01' }).expect(403);
  });

  it('can require an open shift before cash is taken', async () => {
    await t.as(receptionist).put('/cash/settings', { requireShiftForCash: true }).expect(403);
    const settings = await t.as(alpha.owner).put('/cash/settings', { requireShiftForCash: true, cashVarianceTolerance: '2.50' }).expect(200);
    expect(settings.body).toEqual({ requireShiftForCash: true, cashVarianceTolerance: '2.50' });
    const refused = await pay(receptionist2, await invoice(), 'CASH').expect(409);
    expect(refused.body.code).toBe('SHIFT_REQUIRED');
    await pay(receptionist2, await invoice(), 'CARD_POS').expect(201);
    await t.as(receptionist2).post('/cash/shifts', { branchId: alpha.headOfficeId }).expect(201);
    await pay(receptionist2, await invoice(), 'CASH').expect(201);
    await t.as(alpha.owner).put('/cash/settings', { requireShiftForCash: false }).expect(200);
  });

  it('produces the day-end closing for the local day', async () => {
    const today = localYmd(new Date(), 'Asia/Dubai');
    const res = await t.as(manager).get('/cash/day-end').query({ date: today, branchId: alpha.headOfficeId }).expect(200);
    expect(res.body).toMatchObject({ date: today, timeZone: 'Asia/Dubai', currency: 'AED' });
    expect(Number(res.body.collections.byMethod.CASH)).toBeGreaterThanOrEqual(420);
    expect(Number(res.body.collections.byMethod.CARD_POS)).toBeGreaterThanOrEqual(210);
    expect(res.body.refunds).toMatchObject({ cash: '30.00' });
    expect(res.body.expenses).toMatchObject({ cash: '20.00' });
    expect(res.body.shifts.map((s: { id: string }) => s.id)).toContain(shiftId);
    expect(res.body.variance).toMatchObject({ cash: '-10.00' });
    expect(Number(res.body.outsideShifts.count)).toBeGreaterThanOrEqual(2);
    const empty = await t.as(manager).get('/cash/day-end').query({ date: '2020-01-01' }).expect(200);
    expect(empty.body.collections).toMatchObject({ total: '0.00', count: 0 });
  });

  it('rolls new permissions out to existing centres once, respecting later removals', async () => {
    const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: beta.id, key: 'receptionist' } });
    await t.sys.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: 'cash.shift' } });
    await t.sys.platformSetting.deleteMany({ where: { key: 'permission_rollouts' } });
    await t.get(ProvisioningService).bootstrapPlatform();
    expect(await t.sys.rolePermission.count({ where: { roleId: role.id, permissionKey: 'cash.shift' } })).toBe(1);
    // Removed again by the centre: the next start-up leaves it removed.
    await t.sys.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: 'cash.shift' } });
    await t.get(ProvisioningService).bootstrapPlatform();
    expect(await t.sys.rolePermission.count({ where: { roleId: role.id, permissionKey: 'cash.shift' } })).toBe(0);
  });
});
