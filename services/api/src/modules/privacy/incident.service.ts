import { Injectable } from '@nestjs/common';
import type { Prisma, ProcessorRecord, SecurityIncident } from '@typease/database';
import type {
  PrivacyIncidentInput, PrivacyIncidentListQuery, PrivacyIncidentStatusInput, PrivacyIncidentUpdateInput, PrivacyProcessorInput, PrivacyProcessorListQuery,
  PrivacyProcessorReviewInput, PrivacyProcessorUpdateInput,
} from '@typease/validation';
import { AuditEntry, AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { SystemDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';

/**
 * Whose register is being worked on. A tenant id = that centre's own rows;
 * null = the platform-level register kept by TypEase staff.
 */
export type RegisterScope = string | null;

type IncidentStatus = 'OPEN' | 'INVESTIGATING' | 'CONTAINED' | 'RESOLVED';
/** OPEN -> INVESTIGATING -> CONTAINED -> RESOLVED. An investigation can be resumed; nothing can be skipped. */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['INVESTIGATING'],
  INVESTIGATING: ['CONTAINED'],
  CONTAINED: ['RESOLVED', 'INVESTIGATING'],
  RESOLVED: ['INVESTIGATING'],
};

/**
 * Incident register and processor (vendor) register.
 *
 * `security_incidents` and `processor_records` are system-only tables: the
 * tenant-scoped database role has no access to them, so there is no row-level
 * security to fall back on. This is the ONLY class of the privacy module that
 * uses the system connection, and every statement below filters on the scope
 * (`tenantId = <the caller's tenant>` or `tenantId IS NULL`) explicitly. The
 * scope always comes from the verified request context, never from input.
 */
@Injectable()
export class IncidentService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
  ) {}

  private async record(scope: RegisterScope, entry: AuditEntry) {
    if (scope) await this.audit.log(entry);
    else await this.audit.logSystem(entry, null);
  }

  // ------------------------------------------------------------------ incidents
  async listIncidents(scope: RegisterScope, query: PrivacyIncidentListQuery) {
    const where: Prisma.SecurityIncidentWhereInput = { ...within(scope), ...(query.status ? { status: query.status } : {}), ...(query.severity ? { severity: query.severity } : {}) };
    const [rows, total] = await Promise.all([
      this.sys.client.securityIncident.findMany({ where, ...pageArgs(query, ['detectedAt', 'createdAt', 'updatedAt'] as const, 'detectedAt:desc') }),
      this.sys.client.securityIncident.count({ where }),
    ]);
    return pageResult(rows, total, query);
  }

  async getIncident(scope: RegisterScope, id: string): Promise<SecurityIncident> {
    return found(await this.sys.client.securityIncident.findFirst({ where: { id, ...within(scope) } }), 'Incident');
  }

  async createIncident(scope: RegisterScope, input: PrivacyIncidentInput) {
    const row = await this.sys.client.securityIncident.create({
      data: {
        ...within(scope),
        title: input.title,
        description: input.description,
        severity: input.severity,
        status: 'OPEN',
        affectedData: input.affectedData ?? null,
        personalDataInvolved: input.personalDataInvolved,
        notificationRequired: input.notificationRequired ?? null,
        detectedAt: input.detectedAt ? new Date(input.detectedAt) : new Date(),
        reportedById: ctx().userId ?? null,
      },
    });
    await this.record(scope, { action: 'privacy.incident_reported', resourceType: 'SecurityIncident', resourceId: row.id, after: { title: row.title, severity: row.severity, personalDataInvolved: row.personalDataInvolved } });
    return row;
  }

  async updateIncident(scope: RegisterScope, id: string, input: PrivacyIncidentUpdateInput) {
    const before = await this.getIncident(scope, id);
    const date = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));
    const data: Prisma.SecurityIncidentUpdateManyMutationInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.affectedData !== undefined ? { affectedData: input.affectedData ?? null } : {}),
      ...(input.personalDataInvolved !== undefined ? { personalDataInvolved: input.personalDataInvolved } : {}),
      ...(input.notificationRequired !== undefined ? { notificationRequired: input.notificationRequired } : {}),
      ...(input.detectedAt !== undefined ? { detectedAt: new Date(input.detectedAt) } : {}),
      ...(input.authorityNotifiedAt !== undefined ? { authorityNotifiedAt: date(input.authorityNotifiedAt) } : {}),
      ...(input.individualsNotifiedAt !== undefined ? { individualsNotifiedAt: date(input.individualsNotifiedAt) } : {}),
      ...(input.resolutionNotes !== undefined ? { resolutionNotes: input.resolutionNotes ?? null } : {}),
    };
    for (const stamp of [data.authorityNotifiedAt, data.individualsNotifiedAt]) {
      if (stamp instanceof Date && stamp.getTime() > Date.now() + 60_000) throw Errors.unprocessable('DATE_IN_FUTURE', 'A notification time cannot be in the future. Record it once the notification has been sent.');
    }
    // updateMany with the scope in the filter: the row cannot be changed from another scope even by id.
    await this.sys.client.securityIncident.updateMany({ where: { id: before.id, ...within(scope) }, data });
    const after = await this.getIncident(scope, id);
    await this.record(scope, { action: 'privacy.incident_updated', resourceType: 'SecurityIncident', resourceId: id, before: pick(before, Object.keys(data)), after: pick(after, Object.keys(data)) });
    return after;
  }

  async changeIncidentStatus(scope: RegisterScope, id: string, input: PrivacyIncidentStatusInput) {
    const before = await this.getIncident(scope, id);
    const from = before.status as IncidentStatus;
    if (from === input.status) return before;
    if (!INCIDENT_TRANSITIONS[from]?.includes(input.status)) {
      throw Errors.conflict('INVALID_TRANSITION', `An incident that is ${from} cannot move to ${input.status}. Allowed next steps: ${INCIDENT_TRANSITIONS[from].join(', ') || 'none'}.`, { from, to: input.status, allowed: INCIDENT_TRANSITIONS[from] });
    }
    const data: Prisma.SecurityIncidentUpdateManyMutationInput = { status: input.status };
    if (input.status === 'RESOLVED') {
      const notes = input.resolutionNotes ?? before.resolutionNotes;
      if (!notes) throw Errors.unprocessable('RESOLUTION_NOTES_REQUIRED', 'Describe how the incident was resolved before closing it.');
      if (before.personalDataInvolved && before.notificationRequired === null) {
        throw Errors.unprocessable('NOTIFICATION_DECISION_REQUIRED', 'Personal data was involved. Record whether the authority and the affected people must be notified before closing the incident.');
      }
      if (before.notificationRequired === true && !before.authorityNotifiedAt) {
        throw Errors.unprocessable('NOTIFICATION_NOT_RECORDED', 'Notification is marked as required. Record when the authority was notified before closing the incident.');
      }
      data.resolutionNotes = notes;
      data.resolvedAt = new Date();
    } else {
      if (input.resolutionNotes !== undefined) data.resolutionNotes = input.resolutionNotes ?? null;
      if (from === 'RESOLVED') data.resolvedAt = null; // reopened
    }
    // The current status is part of the filter: two people moving the same incident cannot both succeed.
    const changed = await this.sys.client.securityIncident.updateMany({ where: { id: before.id, ...within(scope), status: from }, data });
    if (!changed.count) throw Errors.conflict('INCIDENT_CHANGED', 'This incident was changed by someone else. Reload it and try again.');
    await this.record(scope, { action: 'privacy.incident_status_changed', resourceType: 'SecurityIncident', resourceId: id, before: { status: from }, after: { status: input.status } });
    return this.getIncident(scope, id);
  }

  async incidentCounts(scope: RegisterScope): Promise<Record<IncidentStatus, number>> {
    const grouped = await this.sys.client.securityIncident.groupBy({ by: ['status'], where: within(scope), _count: { _all: true } });
    const out: Record<IncidentStatus, number> = { OPEN: 0, INVESTIGATING: 0, CONTAINED: 0, RESOLVED: 0 };
    for (const g of grouped) if (g.status in out) out[g.status as IncidentStatus] = g._count._all;
    return out;
  }

  // ------------------------------------------------------------------ processors / vendors
  async listProcessors(scope: RegisterScope, query: PrivacyProcessorListQuery) {
    const where: Prisma.ProcessorRecordWhereInput = { ...within(scope), ...(query.status ? { status: query.status } : {}), ...(query.crossBorder !== undefined ? { crossBorder: query.crossBorder } : {}) };
    const [rows, total] = await Promise.all([
      this.sys.client.processorRecord.findMany({ where, ...pageArgs(query, ['name', 'createdAt'] as const, 'name:asc') }),
      this.sys.client.processorRecord.count({ where }),
    ]);
    return pageResult(rows, total, query);
  }

  async getProcessor(scope: RegisterScope, id: string): Promise<ProcessorRecord> {
    return found(await this.sys.client.processorRecord.findFirst({ where: { id, ...within(scope) } }), 'Processor');
  }

  async createProcessor(scope: RegisterScope, input: PrivacyProcessorInput) {
    const row = await this.sys.client.processorRecord.create({
      data: {
        ...within(scope),
        name: input.name,
        purpose: input.purpose,
        dataCategories: input.dataCategories,
        country: input.country,
        // Anything processed outside the UAE is a cross-border transfer unless someone says otherwise on purpose.
        crossBorder: input.crossBorder ?? input.country !== 'AE',
        safeguards: input.safeguards ?? null,
        status: 'PENDING_REVIEW',
      },
    });
    await this.record(scope, { action: 'privacy.processor_added', resourceType: 'ProcessorRecord', resourceId: row.id, after: { name: row.name, country: row.country, crossBorder: row.crossBorder } });
    return row;
  }

  async updateProcessor(scope: RegisterScope, id: string, input: PrivacyProcessorUpdateInput) {
    const before = await this.getProcessor(scope, id);
    const country = input.country ?? before.country;
    const data: Prisma.ProcessorRecordUpdateManyMutationInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.dataCategories !== undefined ? { dataCategories: input.dataCategories } : {}),
      ...(input.country !== undefined ? { country } : {}),
      ...(input.crossBorder !== undefined ? { crossBorder: input.crossBorder } : input.country !== undefined ? { crossBorder: country !== 'AE' } : {}),
      ...(input.safeguards !== undefined ? { safeguards: input.safeguards ?? null } : {}),
    };
    // What was reviewed has changed: the review no longer covers it.
    const material = ['purpose', 'dataCategories', 'country', 'crossBorder'].some((k) => (input as any)[k] !== undefined && JSON.stringify((input as any)[k]) !== JSON.stringify((before as any)[k]));
    if (material && before.status !== 'PENDING_REVIEW') Object.assign(data, { status: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null });
    await this.sys.client.processorRecord.updateMany({ where: { id: before.id, ...within(scope) }, data });
    const after = await this.getProcessor(scope, id);
    await this.record(scope, { action: 'privacy.processor_updated', resourceType: 'ProcessorRecord', resourceId: id, before: pick(before, Object.keys(data)), after: pick(after, Object.keys(data)) });
    return after;
  }

  /** Cross-border processing review: a person approves or rejects the vendor. */
  async reviewProcessor(scope: RegisterScope, id: string, input: PrivacyProcessorReviewInput) {
    const before = await this.getProcessor(scope, id);
    const safeguards = input.safeguards ?? before.safeguards;
    if (input.decision === 'APPROVED' && before.crossBorder && !safeguards) {
      throw Errors.unprocessable('SAFEGUARDS_REQUIRED', 'This vendor processes data outside the UAE. Record the safeguards for the transfer before approving it.');
    }
    await this.sys.client.processorRecord.updateMany({
      where: { id: before.id, ...within(scope) },
      data: { status: input.decision, safeguards: safeguards ?? null, reviewedById: ctx().userId ?? null, reviewedAt: new Date() },
    });
    await this.record(scope, { action: 'privacy.processor_reviewed', resourceType: 'ProcessorRecord', resourceId: id, before: { status: before.status }, after: { status: input.decision, crossBorder: before.crossBorder } });
    return this.getProcessor(scope, id);
  }

  async removeProcessor(scope: RegisterScope, id: string) {
    const before = await this.getProcessor(scope, id);
    await this.sys.client.processorRecord.deleteMany({ where: { id: before.id, ...within(scope) } });
    await this.record(scope, { action: 'privacy.processor_removed', resourceType: 'ProcessorRecord', resourceId: id, before: { name: before.name, country: before.country, status: before.status } });
    return { id, deleted: true };
  }

  async processorCounts(scope: RegisterScope) {
    const [total, pendingReview, crossBorder, crossBorderUnapproved] = await Promise.all([
      this.sys.client.processorRecord.count({ where: within(scope) }),
      this.sys.client.processorRecord.count({ where: { ...within(scope), status: 'PENDING_REVIEW' } }),
      this.sys.client.processorRecord.count({ where: { ...within(scope), crossBorder: true } }),
      this.sys.client.processorRecord.count({ where: { ...within(scope), crossBorder: true, status: { not: 'APPROVED' } } }),
    ]);
    return { total, pendingReview, crossBorder, crossBorderUnapproved };
  }
}

const pick = (row: Record<string, any>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The scope filter for every statement. Prisma ignores `undefined` in a filter,
 * which on a connection without row-level security would mean "all tenants":
 * anything that is not a tenant id or an explicit null is refused.
 */
function within(scope: RegisterScope): { tenantId: string | null } {
  if (scope !== null && (typeof scope !== 'string' || !UUID_RE.test(scope))) throw new Error('Register scope must be a tenant id or null.');
  return { tenantId: scope };
}
