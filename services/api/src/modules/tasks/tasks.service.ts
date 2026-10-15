import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AssignTaskInput, CreateTaskInput, TaskListQuery, TaskStatusInput, UpdateTaskInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased } from '../../common/customer-ref';
import { JobQueue } from '../../common/jobs/job-queue';
import { pageArgs, pageResult } from '../../common/pagination';
import { assertBranchAccess, branchFilter } from '../../common/scope';
import { TenantDirectory } from '../../common/tenant-directory';

export const OVERDUE_JOB = 'tasks.overdue_scan';
const SORT = ['createdAt', 'dueAt', 'priority', 'status', 'updatedAt'] as const;
const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;
type Status = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

/** Allowed status changes. Reopening (DONE / CANCELLED -> OPEN) and cancelling need task.manage. */
export const TASK_TRANSITIONS: Record<Status, Status[]> = {
  OPEN: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  IN_PROGRESS: ['OPEN', 'DONE', 'CANCELLED'],
  DONE: ['OPEN'],
  CANCELLED: ['OPEN'],
};

const include = {
  taskAssignments: { where: { unassignedAt: null }, orderBy: { assignedAt: 'asc' as const }, select: { assigneeId: true, assignedAt: true, assignee: { select: { userId: true, user: { select: { fullName: true } } } } } },
  request: { select: { requestNo: true, assignedToId: true, reviewerId: true } },
} as const;
type Row = Prisma.TaskGetPayload<{ include: typeof include }>;

export interface SystemTaskInput {
  title: string;
  description?: string | null;
  type: string;
  source: 'AUTOMATION' | 'ESCALATION';
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  roleKey?: string | null;
  branchId?: string | null;
  requestId?: string | null;
  customerId?: string | null;
  dueAt?: Date | null;
}

/**
 * Staff tasks: manual tasks, role queues, assignment and progress. Tasks with
 * source WORKFLOW belong to the workflow engine: they are listed and can be
 * assigned and started here, but only the engine closes them.
 */
@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
  ) {}

  onModuleInit() {
    this.jobs.register(OVERDUE_JOB, async (payload: { now?: string }) => void (await this.tenants.forEachTenant(OVERDUE_JOB, async () => void (await this.scanOverdue(payload?.now ? new Date(payload.now) : new Date())))), { attempts: 1 });
    this.jobs.schedule({ name: OVERDUE_JOB, everySeconds: 1800, description: 'Record tasks that passed their due date in the activity trail (no events)' });
  }

  // ------------------------------------------------------------------ visibility
  private manages = () => can('task.manage');
  private reads = () => can('task.read') || can('task.manage');
  /** Staff who may only see requests assigned to them must not learn about other requests through tasks. */
  private restrictedToOwnRequests = () => ctx().actorType === 'STAFF' && !can('request.read.all');

  private isAssignee(row: Row, membershipId = ctx().membershipId) {
    return !!membershipId && row.taskAssignments.some((a) => a.assigneeId === membershipId);
  }
  /** Unassigned task in the queue of the caller's role. */
  private inMyRoleQueue(row: Row) {
    return !!row.roleKey && row.roleKey === ctx().roleKey && row.taskAssignments.length === 0 && OPEN_STATUSES.includes(row.status as any);
  }
  private inMyBranches(row: { branchId: string | null }) {
    const c = ctx();
    return c.actorType !== 'STAFF' || c.allBranches || !row.branchId || c.branchIds.includes(row.branchId);
  }
  private canSee(row: Row) {
    if (this.isAssignee(row)) return true;
    if (!this.inMyBranches(row)) return false;
    if (this.inMyRoleQueue(row)) return true;
    if (!this.reads()) return false;
    if (row.requestId && this.restrictedToOwnRequests()) {
      const me = ctx().membershipId;
      return !!me && (row.request?.assignedToId === me || row.request?.reviewerId === me);
    }
    return true;
  }
  /** WHERE clause for everything the caller may see. */
  private visibleWhere(): Prisma.TaskWhereInput {
    const c = ctx();
    const NOBODY = '00000000-0000-0000-0000-000000000000';
    const me = c.membershipId ?? NOBODY;
    const mine: Prisma.TaskWhereInput = { taskAssignments: { some: { assigneeId: me, unassignedAt: null } } };
    const branch: Prisma.TaskWhereInput = branchFilter() ? { OR: [{ branchId: null }, { branchId: branchFilter() }] } : {};
    const queue: Prisma.TaskWhereInput = c.roleKey ? { ...branch, roleKey: c.roleKey, status: { in: [...OPEN_STATUSES] }, taskAssignments: { none: { unassignedAt: null } } } : { id: NOBODY };
    if (!this.reads()) return { OR: [mine, queue] };
    // Unrestricted readers see everything (an empty filter inside OR would match nothing, so return it directly).
    if (!branchFilter() && !this.restrictedToOwnRequests()) return {};
    const general: Prisma.TaskWhereInput = this.restrictedToOwnRequests() ? { AND: [branch, { OR: [{ requestId: null }, { request: { OR: [{ assignedToId: me }, { reviewerId: me }] } }] }] } : branch;
    return { OR: [mine, queue, general] };
  }

  private async shape(tx: Tx, rows: Row[], now = new Date()) {
    const customerIds = can('customer.read') ? [...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v))] : [];
    const customers = customerIds.length ? await tx.customer.findMany({ where: { tenantId: this.db.tenantId, id: { in: customerIds } }, select: { id: true, fullName: true } }) : [];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      type: r.type,
      priority: r.priority,
      status: r.status,
      source: r.source,
      /** Closed automatically by the workflow engine; cannot be marked done or cancelled by hand. */
      workflowManaged: r.source === 'WORKFLOW',
      stepKey: r.stepKey,
      roleKey: r.roleKey,
      branchId: r.branchId,
      requestId: r.requestId,
      requestNo: r.request?.requestNo ?? null,
      customerId: r.customerId,
      customerName: customers.find((c) => c.id === r.customerId)?.fullName ?? null,
      dueAt: r.dueAt,
      overdue: !!r.dueAt && OPEN_STATUSES.includes(r.status as any) && r.dueAt.getTime() < now.getTime(),
      completedAt: r.completedAt,
      completedById: r.completedById,
      createdById: r.createdById,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      assignees: r.taskAssignments.map((a) => ({ membershipId: a.assigneeId, userId: a.assignee.userId, name: a.assignee.user.fullName, assignedAt: a.assignedAt })),
      assignedToMe: this.isAssignee(r),
      claimable: this.inMyRoleQueue(r) || (r.taskAssignments.length === 0 && OPEN_STATUSES.includes(r.status as any) && this.manages()),
    }));
  }
  private async load(tx: Tx, id: string): Promise<Row> {
    const row = found(await tx.task.findFirst({ where: { id, tenantId: this.db.tenantId }, include }), 'Task');
    // Hidden tasks look exactly like missing ones.
    if (!this.canSee(row)) throw Errors.notFound('Task');
    return row;
  }
  private async lock(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "tasks" WHERE "id" = ${id}::uuid AND "tenantId" = ${this.db.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Task');
  }

  // ------------------------------------------------------------------ lists
  private filters(query: TaskListQuery, now: Date): Prisma.TaskWhereInput {
    return {
      ...(query.status ? { status: query.status } : query.open ? { status: { in: [...OPEN_STATUSES] } } : {}),
      ...(query.overdue ? { status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } } : {}),
      ...(query.assigneeId ? { taskAssignments: { some: { assigneeId: query.assigneeId, unassignedAt: null } } } : {}),
      ...(query.unassigned ? { taskAssignments: { none: { unassignedAt: null } } } : {}),
      ...(query.requestId ? { requestId: query.requestId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.roleKey ? { roleKey: query.roleKey } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.q ? { OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
  }
  async list(query: TaskListQuery) {
    return this.db.tx(async (tx) => {
      const now = new Date();
      const where: Prisma.TaskWhereInput = { tenantId: this.db.tenantId, AND: [this.visibleWhere(), this.filters(query, now)] };
      const rows = await tx.task.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc'), include });
      const total = await tx.task.count({ where });
      return pageResult(await this.shape(tx, rows, now), total, query);
    });
  }
  /** Tasks assigned to me, plus unassigned tasks waiting in the queue of my role. */
  async mine(query: TaskListQuery) {
    const c = ctx();
    if (!c.membershipId) throw Errors.forbidden();
    return this.db.tx(async (tx) => {
      const now = new Date();
      const assigned: Prisma.TaskWhereInput = { taskAssignments: { some: { assigneeId: c.membershipId!, unassignedAt: null } } };
      const branch: Prisma.TaskWhereInput = branchFilter() ? { OR: [{ branchId: null }, { branchId: branchFilter() }] } : {};
      const queue: Prisma.TaskWhereInput = { ...branch, roleKey: c.roleKey ?? '-', status: { in: [...OPEN_STATUSES] }, taskAssignments: { none: { unassignedAt: null } } };
      // Open work by default: finished tasks only when a status is asked for.
      const status = query.status || query.open === false ? {} : { status: { in: [...OPEN_STATUSES] } };
      const where: Prisma.TaskWhereInput = { tenantId: this.db.tenantId, AND: [{ OR: [assigned, queue] }, status, this.filters({ ...query, open: undefined }, now)] };
      const rows = await tx.task.findMany({ where, ...pageArgs(query, SORT, 'dueAt:asc'), include });
      const total = await tx.task.count({ where });
      const overdue = await tx.task.count({ where: { tenantId: this.db.tenantId, AND: [assigned, { status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } }] } });
      return { ...pageResult(await this.shape(tx, rows, now), total, query), overdueCount: overdue };
    });
  }
  async get(id: string) {
    return this.db.tx(async (tx) => (await this.shape(tx, [await this.load(tx, id)]))[0]);
  }

  // ------------------------------------------------------------------ create / update
  private async assertRole(tx: Tx, roleKey: string | null | undefined) {
    if (!roleKey) return;
    const role = await tx.role.findFirst({ where: { tenantId: this.db.tenantId, key: roleKey, kind: 'STAFF' }, select: { id: true } });
    if (!role) throw Errors.unprocessable('UNKNOWN_ROLE', 'That role does not exist in your centre. Choose one of your staff roles.');
  }
  /** Assignees must be active staff of this centre who work at the task's branch. */
  private async assertAssignees(tx: Tx, ids: string[], branchId: string | null) {
    if (!ids.length) return;
    const members = await tx.tenantMembership.findMany({ where: { tenantId: this.db.tenantId, id: { in: ids }, kind: 'STAFF' }, select: { id: true, status: true, allBranches: true, membershipBranches: { select: { branchId: true } }, user: { select: { fullName: true } } } });
    if (members.length !== new Set(ids).size) throw Errors.notFound('Staff member');
    for (const m of members) {
      if (m.status !== 'ACTIVE') throw Errors.unprocessable('ASSIGNEE_INACTIVE', `${m.user.fullName} is not an active member of your team.`);
      if (branchId && !m.allBranches && !m.membershipBranches.some((b) => b.branchId === branchId)) throw Errors.unprocessable('ASSIGNEE_BRANCH', `${m.user.fullName} does not work at the branch of this task.`);
    }
  }

  async create(input: CreateTaskInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      let branchId = input.branchId ?? null;
      let customerId = input.customerId ?? null;
      if (input.requestId) {
        const request = found(await tx.serviceRequest.findFirst({ where: { id: input.requestId, tenantId, deletedAt: null }, select: { id: true, branchId: true, customerId: true, assignedToId: true, reviewerId: true } }), 'Request');
        const me = ctx().membershipId;
        if (this.restrictedToOwnRequests() && request.assignedToId !== me && request.reviewerId !== me) throw Errors.notFound('Request');
        branchId ??= request.branchId;
        customerId ??= request.customerId;
      }
      if (branchId) {
        found(await tx.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } }), 'Branch');
        assertBranchAccess(branchId);
      }
      await assertCustomerNotErased(tx, tenantId, customerId);
      if (customerId) found(await tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null }, select: { id: true } }), 'Customer');
      await this.assertRole(tx, input.roleKey);
      const assigneeIds = [...new Set(input.assigneeIds)];
      await this.assertAssignees(tx, assigneeIds, branchId);

      const task = await tx.task.create({
        data: {
          tenantId, branchId, requestId: input.requestId ?? null, customerId,
          title: input.title, description: input.description ?? null, type: input.type, priority: input.priority,
          source: 'MANUAL', roleKey: input.roleKey ?? null, dueAt: input.dueAt ? new Date(input.dueAt) : null, createdById: ctx().userId ?? null,
        },
      });
      if (assigneeIds.length) await tx.taskAssignment.createMany({ data: assigneeIds.map((assigneeId) => ({ tenantId, taskId: task.id, assigneeId, assignedById: ctx().userId ?? null })) });
      await this.audit.log({ action: 'task.created', resourceType: 'Task', resourceId: task.id, after: { ...input, branchId, customerId } }, tx);
      return (await this.shape(tx, [await this.load(tx, task.id)]))[0];
    });
  }

  /** Used by other modules of this workstream (e.g. SLA escalation). Not exposed over HTTP. */
  async createSystemTask(tx: Tx, input: SystemTaskInput): Promise<string> {
    const task = await tx.task.create({
      data: {
        tenantId: this.db.tenantId, branchId: input.branchId ?? null, requestId: input.requestId ?? null, customerId: input.customerId ?? null,
        title: input.title, description: input.description ?? null, type: input.type, priority: input.priority ?? 'HIGH', source: input.source,
        roleKey: input.roleKey ?? null, dueAt: input.dueAt ?? null,
      },
    });
    await this.audit.log({ action: 'task.created', resourceType: 'Task', resourceId: task.id, summary: `Created automatically (${input.source.toLowerCase()})`, after: { title: input.title, type: input.type, roleKey: input.roleKey ?? null } }, tx);
    return task.id;
  }

  private assertNotWorkflow(row: { source: string }) {
    if (row.source === 'WORKFLOW') throw Errors.conflict('WORKFLOW_TASK', 'This task completes automatically when the request moves on');
  }

  async update(id: string, input: UpdateTaskInput) {
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      const before = await this.load(tx, id);
      this.assertNotWorkflow(before);
      if (!OPEN_STATUSES.includes(before.status as any)) throw Errors.conflict('TASK_CLOSED', 'This task is closed. Reopen it before changing it.');
      if (input.roleKey) await this.assertRole(tx, input.roleKey);
      await tx.task.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
          ...(input.roleKey !== undefined ? { roleKey: input.roleKey } : {}),
        },
      });
      await this.audit.log({ action: 'task.updated', resourceType: 'Task', resourceId: id, before: { title: before.title, description: before.description, type: before.type, priority: before.priority, dueAt: before.dueAt, roleKey: before.roleKey }, after: input }, tx);
      return (await this.shape(tx, [await this.load(tx, id)]))[0];
    });
  }

  // ------------------------------------------------------------------ assignment
  private async setAssignees(tx: Tx, task: Row, next: string[], action: 'task.assigned' | 'task.reassigned' | 'task.claimed', reason?: string | null) {
    const tenantId = this.db.tenantId;
    const current = task.taskAssignments.map((a) => a.assigneeId);
    const added = next.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !next.includes(id));
    if (!added.length && !removed.length) return;
    await this.assertAssignees(tx, added, task.branchId);
    const now = new Date();
    if (removed.length) await tx.taskAssignment.updateMany({ where: { tenantId, taskId: task.id, assigneeId: { in: removed }, unassignedAt: null }, data: { unassignedAt: now } });
    if (added.length) await tx.taskAssignment.createMany({ data: added.map((assigneeId) => ({ tenantId, taskId: task.id, assigneeId, assignedById: ctx().userId ?? null })) });
    // Every change of responsibility leaves a record of who had the task before and after.
    await this.audit.log({ action, resourceType: 'Task', resourceId: task.id, summary: reason ?? undefined, before: { assigneeIds: current }, after: { assigneeIds: next, added, removed } }, tx);
  }

  /** Replace the set of assignees (assign, reassign or unassign). */
  async assign(id: string, input: AssignTaskInput) {
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      const task = await this.load(tx, id);
      if (!OPEN_STATUSES.includes(task.status as any)) throw Errors.conflict('TASK_CLOSED', 'This task is closed and cannot be reassigned.');
      await this.setAssignees(tx, task, [...new Set(input.assigneeIds)], task.taskAssignments.length ? 'task.reassigned' : 'task.assigned', input.reason);
      return (await this.shape(tx, [await this.load(tx, id)]))[0];
    });
  }

  /** Take an unassigned task from the queue of my role. */
  async claim(id: string) {
    const me = ctx().membershipId;
    if (!me) throw Errors.forbidden();
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      const task = await this.load(tx, id);
      if (!OPEN_STATUSES.includes(task.status as any)) throw Errors.conflict('TASK_CLOSED', 'This task is already closed.');
      if (task.taskAssignments.length) throw Errors.conflict('ALREADY_ASSIGNED', `This task was already taken by ${task.taskAssignments.map((a) => a.assignee.user.fullName).join(', ')}.`);
      if (!this.manages() && !this.inMyRoleQueue(task)) throw Errors.forbidden('NOT_IN_ROLE_QUEUE', 'This task is not in the queue of your role.');
      await this.setAssignees(tx, task, [me], 'task.claimed');
      return (await this.shape(tx, [await this.load(tx, id)]))[0];
    });
  }

  // ------------------------------------------------------------------ progress
  async setStatus(id: string, input: TaskStatusInput) {
    return this.db.tx(async (tx) => {
      await this.lock(tx, id);
      const before = await this.load(tx, id);
      const from = before.status as Status;
      const to = input.status as Status;
      const assignee = this.isAssignee(before);
      if (!this.manages() && !assignee) throw Errors.forbidden('NOT_YOUR_TASK', 'Only the people this task is assigned to can update it.');
      if (from === to) throw Errors.conflict('NO_CHANGE', `This task is already ${to.toLowerCase().replace('_', ' ')}.`);
      // The workflow engine owns these: staff may start working, nothing else.
      if (before.source === 'WORKFLOW' && (to === 'DONE' || to === 'CANCELLED' || from === 'DONE' || from === 'CANCELLED')) this.assertNotWorkflow(before);
      if (!TASK_TRANSITIONS[from].includes(to)) throw Errors.conflict('INVALID_TRANSITION', `A task that is ${from.toLowerCase().replace('_', ' ')} cannot be set to ${to.toLowerCase().replace('_', ' ')}.`, { from, to });
      if ((to === 'CANCELLED' || from === 'DONE' || from === 'CANCELLED') && !this.manages()) {
        throw Errors.forbidden('FORBIDDEN', to === 'CANCELLED' ? 'Only a team member who manages tasks can cancel a task.' : 'Only a team member who manages tasks can reopen a task.');
      }
      const now = new Date();
      await tx.task.update({ where: { id }, data: { status: to, completedAt: to === 'DONE' ? now : null, completedById: to === 'DONE' ? (ctx().userId ?? null) : null } });
      await this.audit.log({ action: `task.${to === 'OPEN' && (from === 'DONE' || from === 'CANCELLED') ? 'reopened' : to.toLowerCase()}`, resourceType: 'Task', resourceId: id, summary: input.reason ?? undefined, before: { status: from }, after: { status: to } }, tx);
      return (await this.shape(tx, [await this.load(tx, id)]))[0];
    });
  }

  // ------------------------------------------------------------------ job (one tenant)
  /**
   * Records each task that passed its due date in the activity trail, once per
   * task and due date. It emits no events and changes no task: lists compute
   * `overdue` live; this gives managers and reports the moment it happened.
   */
  async scanOverdue(now = new Date()): Promise<number> {
    const tenantId = this.db.tenantId;
    return this.db.tx(async (tx) => {
      const rows = await tx.task.findMany({ where: { tenantId, status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } }, select: { id: true, title: true, dueAt: true, priority: true }, orderBy: { dueAt: 'asc' }, take: 500 });
      if (!rows.length) return 0;
      const known = await tx.auditLog.findMany({ where: { tenantId, resourceType: 'Task', action: 'task.overdue', resourceId: { in: rows.map((r) => r.id) } }, select: { resourceId: true, summary: true } });
      const seen = new Set(known.map((k) => `${k.resourceId}|${k.summary}`));
      let recorded = 0;
      for (const row of rows) {
        const summary = `Due ${row.dueAt!.toISOString()}`;
        if (seen.has(`${row.id}|${summary}`)) continue;
        await this.audit.log({ action: 'task.overdue', resourceType: 'Task', resourceId: row.id, summary, after: { title: row.title, priority: row.priority, dueAt: row.dueAt } }, tx);
        recorded += 1;
      }
      return recorded;
    });
  }
}
