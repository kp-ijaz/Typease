import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OPEN_STATUSES, REQUEST_STATUS_META, TERMINAL_STATUSES } from '@typease/types';
import type { AssignRequestBody } from '@typease/validation';
import type { ServiceRequest } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { AppError, Errors, found } from '../../common/errors';
import { Clock } from '../workflows/clock';
import { AssignmentCandidate, isOnShift, rankCandidates, workloadOf } from './assignment-ranking';
import { RequestAccess } from './request-access';
import { RequestStateMachine } from './request-state-machine.service';
import { RequestViews } from './request-view.service';
import { WorkflowEngine } from './workflow-engine.service';

type AssignmentRole = 'OPERATOR' | 'REVIEWER';
/** What a member must be allowed to do to take each role on a case. */
const ROLE_PERMISSION: Record<AssignmentRole, string> = { OPERATOR: 'request.process', REVIEWER: 'request.review' };

@Injectable()
export class AssignmentService implements OnModuleInit {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly access: RequestAccess,
    private readonly machine: RequestStateMachine,
    private readonly engine: WorkflowEngine,
    private readonly views: RequestViews,
  ) {}

  onModuleInit() {
    // Automatic assignment at submission, when the centre switched it on.
    this.events.on('request.submitted', async (event, tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: this.db.tenantId }, select: { settings: true } });
      if (((tenant?.settings ?? {}) as Record<string, unknown>).autoAssign !== true) return;
      const request = await tx.serviceRequest.findFirst({ where: { id: event.payload.requestId, tenantId: this.db.tenantId } });
      if (!request || request.assignedToId) return;
      const best = (await this.candidates(tx, request))[0];
      // Nobody suitable right now: the request simply stays unassigned for a manager to pick up.
      if (!best) return;
      try {
        await this.apply(tx, request, best.membershipId, 'OPERATOR', 'AUTO', null);
      } catch (e) {
        // `apply` validates before it writes, so a refusal leaves the submission untouched.
        if (!(e instanceof AppError)) throw e;
        this.logger.warn(`automatic assignment of ${request.requestNo} skipped: ${e.message}`);
      }
    });
  }

  async assign(id: string, input: AssignRequestBody) {
    return this.db.tx(async (tx) => {
      await this.access.assertVisible(tx, id);
      const request = await this.machine.lock(tx, id);
      const after = await this.apply(tx, request, input.assigneeMembershipId, input.role, 'MANUAL', input.reason ?? null);
      return this.views.detail(tx, after);
    });
  }

  async autoAssign(id: string) {
    return this.db.tx(async (tx) => {
      await this.access.assertVisible(tx, id);
      const request = await this.machine.lock(tx, id);
      if (request.assignedToId) throw Errors.conflict('ALREADY_ASSIGNED', 'This request already has an operator. Reassign it manually if needed.');
      const ranked = await this.candidates(tx, request);
      if (!ranked.length) throw Errors.unprocessable('NO_ASSIGNEE_AVAILABLE', 'Nobody suitable is available for this request right now. Assign it manually.');
      const after = await this.apply(tx, request, ranked[0].membershipId, 'OPERATOR', 'AUTO', null);
      return { ...(await this.views.detail(tx, after)), autoAssignment: { chosen: ranked[0], considered: ranked.length } };
    });
  }

  /** Ranked operators for a request (best first). */
  async candidates(tx: Tx, request: ServiceRequest): Promise<AssignmentCandidate[]> {
    const tenantId = this.db.tenantId;
    const now = this.clock.now();
    const [service, branch] = await Promise.all([
      tx.service.findFirst({ where: { id: request.serviceId, tenantId }, select: { staffGroupRoleKey: true } }),
      tx.branch.findFirst({ where: { id: request.branchId, tenantId }, select: { timezone: true } }),
    ]);
    const members = await tx.tenantMembership.findMany({
      where: {
        tenantId,
        kind: 'STAFF',
        status: 'ACTIVE',
        isAvailable: true,
        // The service's staff group when it has one; in every case the role must be able to process requests.
        role: { ...(service?.staffGroupRoleKey ? { key: service.staffGroupRoleKey } : {}), rolePermissions: { some: { permissionKey: ROLE_PERMISSION.OPERATOR } } },
        OR: [{ allBranches: true }, { membershipBranches: { some: { branchId: request.branchId } } }],
        // The reviewer of a case does not also prepare it.
        ...(request.reviewerId ? { id: { not: request.reviewerId } } : {}),
      },
      select: {
        id: true,
        staffSkills: { where: { serviceId: request.serviceId }, select: { id: true } },
        staffSchedules: { where: { isActive: true }, select: { branchId: true, weekday: true, startTime: true, endTime: true, isActive: true } },
        assignedRequests: { where: { deletedAt: null, status: { in: OPEN_STATUSES.filter((s) => s !== 'DRAFT') } }, select: { priority: true } },
      },
    });
    return rankCandidates(
      members.map((m) => ({
        membershipId: m.id,
        hasSkill: m.staffSkills.length > 0,
        hasSchedule: m.staffSchedules.length > 0,
        onShift: isOnShift(m.staffSchedules, request.branchId, now, branch?.timezone ?? 'Asia/Dubai'),
        workload: workloadOf(m.assignedRequests.map((r) => r.priority)),
      })),
    );
  }

  /** Validates the assignee, closes the previous assignment, records the new one and keeps the request in sync. */
  private async apply(tx: Tx, request: ServiceRequest, membershipId: string, role: AssignmentRole, method: 'MANUAL' | 'AUTO', reason: string | null): Promise<ServiceRequest> {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const now = this.clock.now();
    if (TERMINAL_STATUSES.includes(request.status)) throw Errors.conflict('REQUEST_CLOSED', `This request is ${REQUEST_STATUS_META[request.status].en.toLowerCase()} and cannot be assigned.`);

    const member = found(
      await tx.tenantMembership.findFirst({
        where: { id: membershipId, tenantId, kind: 'STAFF' },
        include: { user: { select: { id: true, fullName: true } }, role: { include: { rolePermissions: { select: { permissionKey: true } } } }, membershipBranches: { select: { branchId: true } } },
      }),
      'Staff member',
    );
    if (member.status !== 'ACTIVE') throw Errors.unprocessable('ASSIGNEE_NOT_ACTIVE', `${member.user.fullName} is not an active staff member.`);
    if (!member.allBranches && !member.membershipBranches.some((b) => b.branchId === request.branchId)) {
      throw Errors.unprocessable('ASSIGNEE_NOT_AT_BRANCH', `${member.user.fullName} does not work at the branch of this request.`);
    }
    if (!member.role.rolePermissions.some((p) => p.permissionKey === ROLE_PERMISSION[role])) {
      throw Errors.unprocessable(
        'ASSIGNEE_ROLE_NOT_SUITABLE',
        role === 'OPERATOR' ? `${member.user.fullName} (${member.role.name}) cannot prepare applications. Choose an operator.` : `${member.user.fullName} (${member.role.name}) cannot review applications. Choose a reviewer.`,
      );
    }
    const current = role === 'OPERATOR' ? request.assignedToId : request.reviewerId;
    const other = role === 'OPERATOR' ? request.reviewerId : request.assignedToId;
    if (current === membershipId) throw Errors.conflict('ALREADY_ASSIGNED', `${member.user.fullName} is already the ${role.toLowerCase()} of this request.`);
    if (other === membershipId) {
      throw new AppError(409, 'SEGREGATION_OF_DUTIES', 'The same person cannot both prepare and review a case. Choose someone else.');
    }
    if (current && !reason?.trim()) throw Errors.unprocessable('REASON_REQUIRED', 'Please give a reason for the reassignment.');

    await tx.requestAssignment.updateMany({ where: { tenantId, requestId: request.id, role, unassignedAt: null }, data: { unassignedAt: now } });
    const assignment = await tx.requestAssignment.create({
      data: { tenantId, requestId: request.id, assigneeId: membershipId, role, method, reason: reason?.trim() || null, assignedById: method === 'AUTO' && c.actorType !== 'STAFF' ? null : (c.userId ?? null), assignedAt: now },
    });
    const after = await tx.serviceRequest.update({ where: { id: request.id }, data: { ...(role === 'OPERATOR' ? { assignedToId: membershipId } : { reviewerId: membershipId }), version: { increment: 1 } } });
    await this.audit.log(
      {
        action: current ? 'request.reassigned' : 'request.assigned',
        resourceType: 'ServiceRequest',
        resourceId: request.id,
        summary: `${request.requestNo}: ${role.toLowerCase()} ${current ? 'changed to' : 'set to'} ${member.user.fullName}`,
        before: { [role === 'OPERATOR' ? 'assignedToId' : 'reviewerId']: current },
        after: { [role === 'OPERATOR' ? 'assignedToId' : 'reviewerId']: membershipId, method, reason: reason?.trim() || null, assignmentId: assignment.id },
      },
      tx,
    );
    await this.events.emit(tx, 'request.assigned', { requestId: request.id, requestNo: request.requestNo, customerId: request.customerId, assigneeMembershipId: membershipId, assigneeUserId: member.user.id, role, method });
    await this.engine.syncTaskAssignees(tx, after);
    return after;
  }
}
