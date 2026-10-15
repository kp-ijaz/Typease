import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { makeCustomer, makeRequest } from '../notifications/fixtures';
import { OVERDUE_JOB } from './tasks.service';

describe('Tasks', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor;
  let receptionist: Actor; // task.read only
  let operator: Actor; // task.read + task.manage, but only sees requests assigned to them
  let accountant: Actor; // no task permission
  const create = (actor: Actor, body: Record<string, unknown>) => t.as(actor).post('/tasks', { title: 'Call the customer', ...body });
  const status = (actor: Actor, id: string, value: string, reason?: string) => t.as(actor).post(`/tasks/${id}/status`, { status: value, reason });
  const workflowTask = (tenant: TenantFixture, data: Record<string, any> = {}) =>
    t.sys.task.create({ data: { tenantId: tenant.id, title: 'Review documents', type: 'WORKFLOW_STEP', source: 'WORKFLOW', stepKey: 'document_review', roleKey: 'reviewer', ...data } });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    accountant = await t.addStaff(alpha, 'accountant');
    await t.settle();
  });
  afterAll(() => t.close());

  describe('creating and reading', () => {
    it('creates a manual task linked to a request, with assignees, and validates the references', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Fatima Al Mansoori' });
      const request = await makeRequest(t, alpha, customer.id);
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      const res = await create(manager, { requestId: request.id, description: 'Ask for the missing passport copy', type: 'FOLLOW_UP', priority: 'HIGH', dueAt, assigneeIds: [receptionist.membershipId] }).expect(201);
      expect(res.body).toMatchObject({
        title: 'Call the customer',
        description: 'Ask for the missing passport copy',
        type: 'FOLLOW_UP',
        priority: 'HIGH',
        status: 'OPEN',
        source: 'MANUAL',
        workflowManaged: false,
        requestId: request.id,
        requestNo: request.requestNo,
        // Taken from the request when not given.
        customerId: customer.id,
        customerName: 'Fatima Al Mansoori',
        branchId: alpha.headOfficeId,
        dueAt,
        overdue: false,
        assignedToMe: false,
      });
      expect(res.body.assignees).toEqual([{ membershipId: receptionist.membershipId, userId: receptionist.userId, name: expect.stringContaining('receptionist'), assignedAt: expect.any(String) }]);
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'task.created', resourceId: res.body.id } });
      expect(audit.actorUserId).toBe(manager.userId);

      const plain = await create(manager, {}).expect(201);
      expect(plain.body).toMatchObject({ type: 'GENERAL', priority: 'NORMAL', branchId: null, requestId: null, customerId: null, assignees: [], claimable: true });

      await create(manager, { title: 'x' }).expect(400);
      await create(manager, { type: 'NOT_A_TYPE' }).expect(400);
      await create(manager, { requestId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      await create(manager, { customerId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      await create(manager, { assigneeIds: ['00000000-0000-4000-8000-000000000000'] }).expect(404);
      expect((await create(manager, { roleKey: 'astronaut' }).expect(422)).body.code).toBe('UNKNOWN_ROLE');
      // A customer account can never be an assignee.
      const portal = await t.addCustomer(alpha);
      await create(manager, { assigneeIds: [portal.membershipId] }).expect(404);
    });

    it('enforces permissions: read needs task.read, changes need task.manage, customers have no access', async () => {
      const task = (await create(manager, {}).expect(201)).body;
      await create(receptionist, {}).expect(403);
      await t.as(receptionist).patch(`/tasks/${task.id}`, { title: 'Changed' }).expect(403);
      await t.as(receptionist).put(`/tasks/${task.id}/assignees`, { assigneeIds: [receptionist.membershipId] }).expect(403);
      expect((await t.as(receptionist).get(`/tasks/${task.id}`).expect(200)).body.id).toBe(task.id);
      await t.as(accountant).get('/tasks').expect(403);
      await t.as(accountant).get(`/tasks/${task.id}`).expect(404); // not theirs, and no task.read
      const portal = await t.addCustomer(alpha);
      await t.as(portal).get('/tasks').expect(403);
      await t.as(portal).get('/tasks/mine').expect(403);
      await t.as(portal).get(`/tasks/${task.id}`).expect(403);
      await t.as(portal).post(`/tasks/${task.id}/status`, { status: 'DONE' }).expect(403);
      await t.as(null).get('/tasks').expect(401);
    });

    it('filters by status, overdue, assignee, request, type, role and text', async () => {
      const gamma = await t.createTenant();
      const clerk = await t.addStaff(gamma, 'receptionist');
      const customer = await makeCustomer(t, gamma);
      const request = await makeRequest(t, gamma, customer.id);
      const past = new Date(Date.now() - 3_600_000).toISOString();
      const late = (await create(gamma.owner, { title: 'Late follow-up', type: 'FOLLOW_UP', dueAt: past, assigneeIds: [clerk.membershipId] }).expect(201)).body;
      const linked = (await create(gamma.owner, { title: 'Check the documents', type: 'DOCUMENT_REVIEW', requestId: request.id, roleKey: 'reviewer' }).expect(201)).body;
      const done = (await create(gamma.owner, { title: 'Old task', dueAt: past }).expect(201)).body;
      await status(gamma.owner, done.id, 'DONE').expect(200);
      const ids = async (query: string) => (await t.as(gamma.owner).get(`/tasks?${query}`).expect(200)).body.data.map((x: any) => x.id).sort();

      expect(late.overdue).toBe(true);
      expect(await ids('')).toEqual([late.id, linked.id, done.id].sort());
      expect(await ids('overdue=true')).toEqual([late.id]); // a finished task is never overdue
      expect(await ids('open=true')).toEqual([late.id, linked.id].sort());
      expect(await ids('status=DONE')).toEqual([done.id]);
      expect(await ids(`assigneeId=${clerk.membershipId}`)).toEqual([late.id]);
      expect(await ids('unassigned=true')).toEqual([linked.id, done.id].sort());
      expect(await ids(`requestId=${request.id}`)).toEqual([linked.id]);
      expect(await ids(`customerId=${customer.id}`)).toEqual([linked.id]);
      expect(await ids('type=FOLLOW_UP')).toEqual([late.id]);
      expect(await ids('roleKey=reviewer')).toEqual([linked.id]);
      expect(await ids('q=documents')).toEqual([linked.id]);
      expect(await ids('source=WORKFLOW')).toEqual([]);
      const page = await t.as(gamma.owner).get('/tasks?pageSize=2&sort=dueAt:asc').expect(200);
      expect(page.body.meta).toMatchObject({ total: 3, pageSize: 2, totalPages: 2 });
      await t.as(gamma.owner).get('/tasks?status=NOPE').expect(400);
    });
  });

  describe('assignment', () => {
    it('assigns and reassigns with an audit record of who had the task before and after', async () => {
      const task = (await create(manager, { title: 'Prepare the contract' }).expect(201)).body;
      const first = await t.as(manager).put(`/tasks/${task.id}/assignees`, { assigneeIds: [receptionist.membershipId] }).expect(200);
      expect(first.body.assignees.map((a: any) => a.membershipId)).toEqual([receptionist.membershipId]);

      const second = await t.as(manager).put(`/tasks/${task.id}/assignees`, { assigneeIds: [operator.membershipId, accountant.membershipId], reason: 'Reception is fully booked today' }).expect(200);
      expect(second.body.assignees.map((a: any) => a.membershipId).sort()).toEqual([operator.membershipId, accountant.membershipId].sort());

      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceType: 'Task', resourceId: task.id, action: { in: ['task.assigned', 'task.reassigned'] } }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['task.assigned', 'task.reassigned']);
      expect(audit[1]).toMatchObject({ actorUserId: manager.userId, summary: 'Reception is fully booked today' });
      expect(audit[1].before).toEqual({ assigneeIds: [receptionist.membershipId] });
      expect((audit[1].after as any).removed).toEqual([receptionist.membershipId]);
      expect((audit[1].after as any).added.sort()).toEqual([operator.membershipId, accountant.membershipId].sort());
      // History is kept: the earlier assignment is closed, not deleted.
      const history = await t.sys.taskAssignment.findMany({ where: { taskId: task.id } });
      expect(history).toHaveLength(3);
      expect(history.find((h) => h.assigneeId === receptionist.membershipId)!.unassignedAt).not.toBeNull();
      expect(history.filter((h) => h.unassignedAt === null)).toHaveLength(2);

      // Nothing changes -> nothing is audited. Unassigning everybody is allowed.
      await t.as(manager).put(`/tasks/${task.id}/assignees`, { assigneeIds: [operator.membershipId, accountant.membershipId] }).expect(200);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: task.id, action: 'task.reassigned' } })).toBe(1);
      expect((await t.as(manager).put(`/tasks/${task.id}/assignees`, { assigneeIds: [] }).expect(200)).body.assignees).toEqual([]);
      const suspended = await t.addStaff(alpha, 'receptionist');
      await t.sys.tenantMembership.update({ where: { id: suspended.membershipId! }, data: { status: 'SUSPENDED' } });
      expect((await t.as(manager).put(`/tasks/${task.id}/assignees`, { assigneeIds: [suspended.membershipId] }).expect(422)).body.code).toBe('ASSIGNEE_INACTIVE');
    });

    it('lets staff without task.manage work on and complete the tasks assigned to them', async () => {
      const mine = (await create(manager, { title: 'Scan the passport', assigneeIds: [receptionist.membershipId, accountant.membershipId] }).expect(201)).body;
      const notMine = (await create(manager, { title: 'Somebody else' }).expect(201)).body;

      const list = await t.as(receptionist).get('/tasks/mine').expect(200);
      expect(list.body.data.map((x: any) => x.id)).toContain(mine.id);
      expect(list.body.data.map((x: any) => x.id)).not.toContain(notMine.id);
      expect(list.body.data.find((x: any) => x.id === mine.id)).toMatchObject({ assignedToMe: true });
      // The accountant has no task permission at all, but still sees and handles their own task.
      expect((await t.as(accountant).get('/tasks/mine').expect(200)).body.data.map((x: any) => x.id)).toEqual([mine.id]);
      expect((await t.as(accountant).get(`/tasks/${mine.id}`).expect(200)).body.title).toBe('Scan the passport');
      await t.as(accountant).get(`/tasks/${notMine.id}`).expect(404);

      expect((await status(receptionist, mine.id, 'IN_PROGRESS').expect(200)).body.status).toBe('IN_PROGRESS');
      expect((await status(receptionist, notMine.id, 'IN_PROGRESS').expect(403)).body.code).toBe('NOT_YOUR_TASK');
      expect((await status(receptionist, mine.id, 'CANCELLED').expect(403)).body.message).toMatch(/manages tasks can cancel/);
      const done = await status(accountant, mine.id, 'DONE').expect(200);
      expect(done.body).toMatchObject({ status: 'DONE', completedById: accountant.userId });
      expect(done.body.completedAt).toBeTruthy();
      // Finished work leaves "my tasks" unless asked for; reopening needs task.manage.
      expect((await t.as(receptionist).get('/tasks/mine').expect(200)).body.data.map((x: any) => x.id)).not.toContain(mine.id);
      expect((await t.as(receptionist).get('/tasks/mine?status=DONE').expect(200)).body.data.map((x: any) => x.id)).toContain(mine.id);
      await status(receptionist, mine.id, 'OPEN').expect(403);
      expect((await status(manager, mine.id, 'OPEN', 'Scan was unreadable').expect(200)).body).toMatchObject({ status: 'OPEN', completedAt: null, completedById: null });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: mine.id, action: { in: ['task.in_progress', 'task.done', 'task.reopened'] } } })).toBe(3);
    });

    it('shows unassigned role tasks to members of that role, who can claim them', async () => {
      const second = await t.addStaff(alpha, 'receptionist');
      const queued = (await create(manager, { title: 'Greet the delegation', roleKey: 'receptionist' }).expect(201)).body;
      const forReviewers = (await create(manager, { title: 'Verify certificates', roleKey: 'reviewer' }).expect(201)).body;

      const queue = (await t.as(receptionist).get('/tasks/mine').expect(200)).body.data;
      expect(queue.find((x: any) => x.id === queued.id)).toMatchObject({ claimable: true, assignedToMe: false, roleKey: 'receptionist' });
      expect(queue.some((x: any) => x.id === forReviewers.id)).toBe(false);
      expect((await t.as(accountant).get('/tasks/mine').expect(200)).body.data.some((x: any) => x.id === queued.id)).toBe(false);
      await t.as(accountant).get(`/tasks/${queued.id}`).expect(404);
      expect((await t.as(accountant).post(`/tasks/${queued.id}/claim`).expect(404)).body.code).toBe('NOT_FOUND');
      // A receptionist can see the reviewers' task (task.read) but it is not in their queue.
      expect((await t.as(receptionist).post(`/tasks/${forReviewers.id}/claim`).expect(403)).body.code).toBe('NOT_IN_ROLE_QUEUE');

      const claimed = await t.as(receptionist).post(`/tasks/${queued.id}/claim`).expect(200);
      expect(claimed.body).toMatchObject({ assignedToMe: true, claimable: false });
      expect((await t.as(second).post(`/tasks/${queued.id}/claim`).expect(409)).body.code).toBe('ALREADY_ASSIGNED');
      expect((await t.as(second).get('/tasks/mine').expect(200)).body.data.some((x: any) => x.id === queued.id)).toBe(false);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: queued.id, action: 'task.claimed', actorUserId: receptionist.userId } })).toBe(1);
      expect((await status(receptionist, queued.id, 'DONE').expect(200)).body.status).toBe('DONE');
    });
  });

  describe('status rules', () => {
    it('follows OPEN -> IN_PROGRESS -> DONE / CANCELLED and refuses anything else', async () => {
      const task = (await create(manager, {}).expect(201)).body;
      expect((await status(manager, task.id, 'OPEN').expect(409)).body.code).toBe('NO_CHANGE');
      await status(manager, task.id, 'IN_PROGRESS').expect(200);
      await status(manager, task.id, 'OPEN').expect(200); // put back
      await status(manager, task.id, 'DONE').expect(200); // straight to done is fine
      expect((await status(manager, task.id, 'IN_PROGRESS').expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await status(manager, task.id, 'CANCELLED').expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await t.as(manager).patch(`/tasks/${task.id}`, { title: 'Too late' }).expect(409)).body.code).toBe('TASK_CLOSED');
      expect((await t.as(manager).put(`/tasks/${task.id}/assignees`, { assigneeIds: [operator.membershipId] }).expect(409)).body.code).toBe('TASK_CLOSED');
      await status(manager, task.id, 'OPEN').expect(200);
      const cancelled = await status(manager, task.id, 'CANCELLED', 'No longer needed').expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      await status(manager, task.id, 'WAITING').expect(400);
      const edited = (await create(manager, {}).expect(201)).body;
      const patched = await t.as(manager).patch(`/tasks/${edited.id}`, { title: 'New title', priority: 'URGENT', dueAt: null, roleKey: 'manager' }).expect(200);
      expect(patched.body).toMatchObject({ title: 'New title', priority: 'URGENT', dueAt: null, roleKey: 'manager' });
    });

    it('leaves workflow tasks to the workflow engine: assign and start only', async () => {
      const customer = await makeCustomer(t, alpha);
      const request = await makeRequest(t, alpha, customer.id);
      const wf = await workflowTask(alpha, { requestId: request.id, branchId: alpha.headOfficeId });

      const shown = await t.as(manager).get(`/tasks/${wf.id}`).expect(200);
      expect(shown.body).toMatchObject({ source: 'WORKFLOW', workflowManaged: true, stepKey: 'document_review', roleKey: 'reviewer', requestNo: request.requestNo });
      expect((await t.as(manager).get('/tasks?source=WORKFLOW').expect(200)).body.data.map((x: any) => x.id)).toContain(wf.id);

      await t.as(manager).put(`/tasks/${wf.id}/assignees`, { assigneeIds: [receptionist.membershipId] }).expect(200);
      expect((await status(receptionist, wf.id, 'IN_PROGRESS').expect(200)).body.status).toBe('IN_PROGRESS');
      for (const actor of [receptionist, manager]) {
        for (const value of ['DONE', 'CANCELLED']) {
          const res = await status(actor, wf.id, value).expect(409);
          expect(res.body).toMatchObject({ code: 'WORKFLOW_TASK', message: 'This task completes automatically when the request moves on' });
        }
      }
      expect((await t.as(manager).patch(`/tasks/${wf.id}`, { title: 'Renamed' }).expect(409)).body.code).toBe('WORKFLOW_TASK');
      expect((await t.sys.task.findUniqueOrThrow({ where: { id: wf.id } })).status).toBe('IN_PROGRESS');
      // Once the engine closed it, nobody reopens it by hand.
      await t.sys.task.update({ where: { id: wf.id }, data: { status: 'DONE', completedAt: new Date() } });
      expect((await status(manager, wf.id, 'OPEN').expect(409)).body.code).toBe('WORKFLOW_TASK');
    });
  });

  describe('overdue scan (job tasks.overdue_scan)', () => {
    it('records each overdue task once in the activity trail and emits no events', async () => {
      const delta = await t.createTenant();
      const overdue = (await create(delta.owner, { title: 'Overdue task', dueAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }).expect(201)).body;
      const future = (await create(delta.owner, { title: 'Future task', dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }).expect(201)).body;
      const finished = (await create(delta.owner, { title: 'Finished task', dueAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }).expect(201)).body;
      await status(delta.owner, finished.id, 'DONE').expect(200);
      await t.settle();
      const eventsBefore = await t.sys.outboxEvent.count({ where: { tenantId: delta.id } });
      const records = () => t.sys.auditLog.findMany({ where: { tenantId: delta.id, action: 'task.overdue' }, orderBy: { createdAt: 'asc' } });

      await t.jobs.execute(OVERDUE_JOB, {}, { attempt: 1, maxAttempts: 1 });
      await t.jobs.execute(OVERDUE_JOB, {}, { attempt: 1, maxAttempts: 1 });
      let rows = await records();
      expect(rows.map((r) => r.resourceId)).toEqual([overdue.id]);
      expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', resourceType: 'Task' });
      expect(await t.sys.outboxEvent.count({ where: { tenantId: delta.id } })).toBe(eventsBefore);
      // The task itself is untouched; lists compute "overdue" live.
      expect((await t.as(delta.owner).get(`/tasks/${overdue.id}`).expect(200)).body).toMatchObject({ status: 'OPEN', overdue: true });
      expect((await t.as(delta.owner).get(`/tasks/${future.id}`).expect(200)).body.overdue).toBe(false);
      expect((await t.as(delta.owner).get(`/tasks/${finished.id}`).expect(200)).body.overdue).toBe(false);

      // A new due date that is missed again is a new entry.
      await t.as(delta.owner).patch(`/tasks/${overdue.id}`, { dueAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(200);
      await t.jobs.execute(OVERDUE_JOB, {}, { attempt: 1, maxAttempts: 1 });
      rows = await records();
      expect(rows).toHaveLength(2);
      // "Later" from the job's point of view: the future task becomes overdue.
      await t.jobs.execute(OVERDUE_JOB, { now: new Date(Date.now() + 3 * 3_600_000).toISOString() }, { attempt: 1, maxAttempts: 1 });
      expect((await records()).map((r) => r.resourceId)).toEqual([overdue.id, overdue.id, future.id]);
    });
  });

  describe('scope and tenant isolation', () => {
    it('applies branch scope: branch staff do not see tasks of other branches', async () => {
      const second = (await t.as(alpha.owner).post('/branches', { code: 'T2', name: 'Second Branch' }).expect(201)).body;
      const branchManager = await t.addStaff(alpha, 'manager', { branchIds: [second.id] });
      const main = (await create(manager, { title: 'Main branch task', branchId: alpha.headOfficeId }).expect(201)).body;
      const other = (await create(manager, { title: 'Second branch task', branchId: second.id }).expect(201)).body;
      const general = (await create(manager, { title: 'Centre-wide task' }).expect(201)).body;

      const visible = (await t.as(branchManager).get('/tasks?pageSize=100').expect(200)).body.data.map((x: any) => x.id);
      expect(visible).toEqual(expect.arrayContaining([other.id, general.id]));
      expect(visible).not.toContain(main.id);
      await t.as(branchManager).get(`/tasks/${main.id}`).expect(404);
      await status(branchManager, main.id, 'DONE').expect(404);
      await t.as(branchManager).put(`/tasks/${main.id}/assignees`, { assigneeIds: [branchManager.membershipId] }).expect(404);
      expect((await create(branchManager, { branchId: alpha.headOfficeId }).expect(403)).body.code).toBe('BRANCH_FORBIDDEN');
      // Somebody who does not work at the branch cannot be given its task ...
      expect((await t.as(manager).put(`/tasks/${main.id}/assignees`, { assigneeIds: [branchManager.membershipId] }).expect(422)).body.code).toBe('ASSIGNEE_BRANCH');
      // ... but a task explicitly assigned to a person is always visible to them.
      await t.sys.taskAssignment.create({ data: { tenantId: alpha.id, taskId: main.id, assigneeId: branchManager.membershipId! } });
      expect((await t.as(branchManager).get(`/tasks/${main.id}`).expect(200)).body.assignedToMe).toBe(true);
    });

    it('hides tasks of requests an operator is not assigned to', async () => {
      const customer = await makeCustomer(t, alpha);
      const request = await makeRequest(t, alpha, customer.id);
      const linked = (await create(manager, { title: 'Confidential request task', requestId: request.id }).expect(201)).body;
      const free = (await create(manager, { title: 'General operator task' }).expect(201)).body;
      const seen = async () => (await t.as(operator).get('/tasks?pageSize=100').expect(200)).body.data.map((x: any) => x.id);
      expect(await seen()).toContain(free.id);
      expect(await seen()).not.toContain(linked.id);
      await t.as(operator).get(`/tasks/${linked.id}`).expect(404);
      await create(operator, { requestId: request.id }).expect(404); // cannot attach tasks to a request they cannot see
      await t.sys.serviceRequest.update({ where: { id: request.id }, data: { assignedToId: operator.membershipId } });
      expect(await seen()).toContain(linked.id);
      expect((await t.as(operator).get(`/tasks/${linked.id}`).expect(200)).body.requestNo).toBe(request.requestNo);
    });

    it('never lets tenant B read, change or reference tenant A tasks', async () => {
      const customer = await makeCustomer(t, alpha);
      const request = await makeRequest(t, alpha, customer.id);
      const task = (await create(manager, { title: 'Alpha only', requestId: request.id }).expect(201)).body;
      await t.as(beta.owner).get(`/tasks/${task.id}`).expect(404);
      await t.as(beta.owner).patch(`/tasks/${task.id}`, { title: 'Hijacked' }).expect(404);
      await t.as(beta.owner).put(`/tasks/${task.id}/assignees`, { assigneeIds: [beta.owner.membershipId] }).expect(404);
      await t.as(beta.owner).post(`/tasks/${task.id}/claim`).expect(404);
      await status(beta.owner, task.id, 'DONE').expect(404);
      // Cross-tenant references are "not found".
      await create(beta.owner, { requestId: request.id }).expect(404);
      await create(beta.owner, { customerId: customer.id }).expect(404);
      await create(beta.owner, { branchId: alpha.headOfficeId }).expect(404);
      await create(beta.owner, { assigneeIds: [manager.membershipId] }).expect(404);
      const own = (await create(beta.owner, { title: 'Beta task' }).expect(201)).body;
      await t.as(beta.owner).put(`/tasks/${own.id}/assignees`, { assigneeIds: [manager.membershipId] }).expect(404);

      const list = await t.as(beta.owner).get('/tasks?pageSize=100').expect(200);
      expect(list.body.data.map((x: any) => x.id)).toEqual([own.id]);
      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.task.findMany({ select: { tenantId: true } })));
      expect(seen.every((r) => r.tenantId === beta.id)).toBe(true);
      await expect(
        t.inTenant(beta.id, () => t.db.tx((tx) => tx.taskAssignment.create({ data: { tenantId: beta.id, taskId: task.id, assigneeId: beta.owner.membershipId! } }))),
      ).rejects.toThrow(/cross-tenant|violates|security/i);
      expect((await t.sys.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('Alpha only');
    });
  });
});
