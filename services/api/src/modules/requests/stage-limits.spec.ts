import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { Clock } from '../workflows/clock';
import { createCustomer, createService, submittedRequest } from './fixtures';
import { STAGE_LIMITS_JOB, stageMarker } from './stage-limits.service';

describe('Board time limits', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor;
  let operator: Actor;
  let receptionist: Actor;
  let serviceId: string;
  let customerId: string;
  const alertsOf = (requestId: string) => t.sys.task.findMany({ where: { requestId, source: 'ESCALATION', stepKey: { startsWith: 'stage:' } } });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    operator = await t.addStaff(alpha, 'operator');
    receptionist = await t.addStaff(alpha, 'receptionist');
    serviceId = (await createService(t, alpha)).id;
    customerId = (await createCustomer(t, alpha)).id;
  });
  afterEach(() => t.get(Clock).reset());
  afterAll(() => t.close());

  it('managers set a limit per column; others only read them', async () => {
    await t.as(operator).put('/requests/board/limits', { limits: { SUBMITTED: 60 } }).expect(403);
    await t.as(manager).put('/requests/board/limits', { limits: { DRAFT: 60 } }).expect(422);
    await t.as(manager).put('/requests/board/limits', { limits: { SUBMITTED: 2 } }).expect(400);
    const saved = await t.as(manager).put('/requests/board/limits', { limits: { SUBMITTED: 120, UNDER_REVIEW: 240 } }).expect(200);
    expect(saved.body.limits).toEqual({ SUBMITTED: 120, UNDER_REVIEW: 240 });
    await t.as(manager).put('/requests/board/limits', { limits: { UNDER_REVIEW: null } }).expect(200);
    expect((await t.as(operator).get('/requests/board/limits').expect(200)).body.limits).toEqual({ SUBMITTED: 120 });
    expect((await t.as(beta.owner).get('/requests/board/limits').expect(200)).body.limits).toEqual({});
  });

  it('the list tells staff since when each request is in its status', async () => {
    const request = await submittedRequest(t, alpha, receptionist, serviceId, customerId);
    const row = (await t.as(manager).get('/requests').query({ status: 'SUBMITTED' }).expect(200)).body.data.find((r: { id: string }) => r.id === request.id);
    expect(Math.abs(Date.now() - Date.parse(row.statusSince))).toBeLessThan(60_000);
  });

  it('tells managers once per stay when a request is over the limit', async () => {
    const late = await submittedRequest(t, alpha, receptionist, serviceId, customerId);
    const clock = t.get(Clock);
    await t.jobs.runScheduled(STAGE_LIMITS_JOB);
    expect(await alertsOf(late.id)).toEqual([]); // inside the 2 h limit
    clock.travelHours(2.5);
    await t.jobs.runScheduled(STAGE_LIMITS_JOB);
    expect(await alertsOf(late.id)).toEqual([expect.objectContaining({ stepKey: stageMarker('SUBMITTED'), roleKey: 'manager', priority: 'HIGH', status: 'OPEN' })]);
    await t.settle();
    const told = await t.sys.notification.findMany({ where: { tenantId: alpha.id, eventKey: 'request.stage_overdue', relatedId: late.id } });
    expect(told.some((n) => n.recipientUserId === manager.userId)).toBe(true);
    expect(told.some((n) => n.recipientUserId === operator.userId)).toBe(false);

    // Running again changes nothing.
    await t.jobs.runScheduled(STAGE_LIMITS_JOB);
    expect(await alertsOf(late.id)).toHaveLength(1);
    // The request left the column and came back later: a new stay, alerted again once it is over the limit.
    await t.sys.requestStatusHistory.create({ data: { tenantId: alpha.id, requestId: late.id, fromStatus: 'UNDER_REVIEW', toStatus: 'SUBMITTED', actorType: 'SYSTEM', createdAt: new Date(Date.now() + 2.6 * 3_600_000) } });
    clock.travelHours(2.5);
    await t.jobs.runScheduled(STAGE_LIMITS_JOB);
    expect(await alertsOf(late.id)).toHaveLength(2);
  });
});
