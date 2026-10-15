import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OPEN_STATUSES, REQUEST_STATUS_META } from '@typease/types';
import type { RequestStatus } from '@typease/types';
import type { BoardTimeLimitsInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { DomainEvents } from '../../common/events.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { TenantDirectory } from '../../common/tenant-directory';
import { Clock } from '../workflows/clock';

export const STAGE_LIMITS_JOB = 'requests.stage_limits';
/** Where a stay in a status started: the latest move into it (or the creation of the request). */
export const stageMarker = (status: string) => `stage:${status}`;
const LIMITABLE: RequestStatus[] = OPEN_STATUSES.filter((s) => s !== 'DRAFT');

/**
 * Time limits on the board: how long a request may stay in each status. Cards turn amber at 75% and red past the
 * limit (the board computes that from `statusSince`); once per stay, managers of the branch and the assignee are
 * told and an escalation task is opened.
 */
@Injectable()
export class StageLimitsService implements OnModuleInit {
  private readonly logger = new Logger(StageLimitsService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.jobs.register(STAGE_LIMITS_JOB, async () => {
      const result = await this.tenants.forEachTenant(STAGE_LIMITS_JOB, async () => void (await this.scan()));
      if (result.failed) this.logger.warn(`${STAGE_LIMITS_JOB}: ${result.failed} tenant(s) failed`);
    });
    this.jobs.schedule({ name: STAGE_LIMITS_JOB, everySeconds: 300, description: 'Tell managers about requests that stayed in a board column longer than its time limit' });
  }

  private read(settings: unknown): Partial<Record<RequestStatus, number>> {
    const raw = ((settings ?? {}) as Record<string, unknown>).boardTimeLimits;
    const out: Partial<Record<RequestStatus, number>> = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (LIMITABLE.includes(k as RequestStatus) && typeof v === 'number' && v > 0) out[k as RequestStatus] = v;
    return out;
  }

  async limits() {
    return this.db.tx(async (tx) => ({ limits: this.read((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } })).settings), statuses: LIMITABLE }));
  }

  async update(input: BoardTimeLimitsInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const unknown = Object.keys(input.limits).filter((k) => !LIMITABLE.includes(k as RequestStatus));
      if (unknown.length) throw Errors.unprocessable('UNKNOWN_STATUS', `These statuses cannot have a time limit: ${unknown.join(', ')}.`);
      const t = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const before = this.read(t.settings);
      const next = { ...before };
      for (const [k, v] of Object.entries(input.limits)) {
        if (v === null) delete next[k as RequestStatus];
        else next[k as RequestStatus] = v;
      }
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...((t.settings ?? {}) as object), boardTimeLimits: next } as Prisma.InputJsonValue } });
      await this.audit.log({ action: 'requests.board_limits_updated', resourceType: 'Tenant', resourceId: tenantId, before, after: next }, tx);
      return { limits: next, statuses: LIMITABLE };
    });
  }

  /** When each request entered its current status. */
  static async statusSince(tx: Tx, rows: Array<{ id: string; status: string; createdAt: Date }>): Promise<Map<string, Date>> {
    if (!rows.length) return new Map();
    const entered = await tx.requestStatusHistory.groupBy({ by: ['requestId', 'toStatus'], where: { requestId: { in: rows.map((r) => r.id) } }, _max: { createdAt: true } });
    const at = new Map(entered.map((e) => [`${e.requestId}:${e.toStatus}`, e._max.createdAt]));
    return new Map(rows.map((r) => [r.id, at.get(`${r.id}:${r.status}`) ?? r.createdAt]));
  }

  /** One centre: every open request past its column's limit gets one alert per stay. */
  async scan(): Promise<{ alerted: number }> {
    const tenantId = this.db.tenantId;
    const now = this.clock.now();
    const candidates = await this.db.tx(async (tx) => {
      const limits = this.read((await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings);
      const statuses = Object.keys(limits) as RequestStatus[];
      if (!statuses.length) return [];
      const rows = await tx.serviceRequest.findMany({ where: { tenantId, deletedAt: null, status: { in: statuses } }, select: { id: true, status: true, createdAt: true }, take: 2000 });
      const since = await StageLimitsService.statusSince(tx, rows);
      return rows.filter((r) => since.get(r.id)!.getTime() + limits[r.status]! * 60_000 < now.getTime()).map((r) => ({ ...r, since: since.get(r.id)!, limit: limits[r.status]! }));
    });
    let alerted = 0;
    for (const c of candidates) {
      const done = await this.db.tx(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "service_requests" WHERE "id" = ${c.id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
        const request = await tx.serviceRequest.findFirst({ where: { id: c.id, tenantId }, include: { assignedTo: { select: { userId: true } } } });
        // Moved on in the meantime, or already told about this stay.
        if (!request || request.status !== c.status) return false;
        if (await tx.task.findFirst({ where: { tenantId, requestId: c.id, source: 'ESCALATION', stepKey: stageMarker(c.status), createdAt: { gte: c.since } }, select: { id: true } })) return false;
        const stage = REQUEST_STATUS_META[c.status as RequestStatus].en;
        const hours = Math.round((now.getTime() - c.since.getTime()) / 360_000) / 10;
        await tx.task.create({
          data: {
            tenantId, branchId: request.branchId, requestId: request.id, customerId: request.customerId,
            title: `Waiting too long in ${stage}: ${request.requestNo}`,
            description: `${request.requestNo} has been "${stage}" for ${hours} h; the board limit for this column is ${Math.round((c.limit / 60) * 10) / 10} h.`,
            type: 'ESCALATION', priority: 'HIGH', status: 'OPEN', source: 'ESCALATION', stepKey: stageMarker(c.status), roleKey: 'manager', createdAt: now,
          },
        });
        await this.events.emit(tx, 'request.stage_overdue', { requestId: request.id, requestNo: request.requestNo, customerId: request.customerId, branchId: request.branchId, status: c.status, since: c.since.toISOString(), limitMinutes: c.limit, assigneeUserId: request.assignedTo?.userId ?? null });
        return true;
      });
      if (done) alerted += 1;
    }
    return { alerted };
  }
}
