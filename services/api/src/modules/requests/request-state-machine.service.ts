import { Injectable } from '@nestjs/common';
import { findTransition, REQUEST_STATUS_META, REQUEST_TRANSITIONS } from '@typease/types';
import type { RequestStatus, TransitionRule } from '@typease/types';
import type { Prisma, ServiceRequest } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { ctx, Ctx } from '../../common/context';
import { randomToken, sha256 } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors } from '../../common/errors';
import { UsageService } from '../../common/usage.service';
import { Clock } from '../workflows/clock';
import { RequestAccess, requestActorKind } from './request-access';
import { guardError, GuardFailure, RequestGuards } from './request-guards.service';
import { externalResultOf, RequestReader } from './request-reader.service';

/**
 * On whose authority a transition happens.
 *
 *  CONTEXT  the signed-in actor of the current HTTP request: staff need a permission of the
 *           edge, customers / corporate admins need `customer: true` and their own request.
 *  SYSTEM   automation without a person deciding (jobs, "resubmit" bookkeeping): only edges
 *           marked `system: true`.
 *  ENGINE   the workflow engine performing a guarded step. May use any edge of the table.
 *           This value is only ever constructed inside the requests module; no controller
 *           accepts it from a client.
 *
 * Whatever the authority, the edge must exist in REQUEST_TRANSITIONS and every guard applies.
 */
export type TransitionActor = { kind: 'CONTEXT' } | { kind: 'SYSTEM' } | { kind: 'ENGINE'; stepKey?: string };
export const AS_CONTEXT: TransitionActor = { kind: 'CONTEXT' };
export const AS_SYSTEM: TransitionActor = { kind: 'SYSTEM' };

export interface TransitionOptions {
  actor: TransitionActor;
  /** Internal reason, shown to staff in the history. Never shown to customers. */
  reason?: string | null;
  /** Text for the customer; defaults to the standard customer wording of the new status. */
  customerMessage?: string | null;
  customerVisible?: boolean;
  meta?: Record<string, unknown>;
  /** Optimistic concurrency: the version the caller last saw. */
  expectedVersion?: number;
  /** Extra columns written together with the status (internal callers only). */
  set?: Prisma.ServiceRequestUncheckedUpdateManyInput;
}
export interface TransitionResult {
  request: ServiceRequest;
  from: RequestStatus;
  to: RequestStatus;
  /** Only when this transition generated the public tracking code. Shown once, stored only as a hash. */
  trackingCode?: string;
}
export type TransitionHook = (tx: Tx, result: TransitionResult) => Promise<void>;

export interface AvailableTransition {
  to: RequestStatus;
  action: string;
  requiresReason: boolean;
  /** False when a business guard currently blocks it; `blocked` then says why. */
  enabled: boolean;
  blocked?: { code: string; message: string };
}

const DEFAULT_TARGET_HOURS = 72;
/** 10 characters without look-alikes (no 0/O, 1/I/L). */
const TRACKING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newTrackingCode(): string {
  const bytes = Buffer.from(randomToken(16), 'base64url');
  let code = '';
  for (let i = 0; i < 10; i++) code += TRACKING_ALPHABET[bytes[i] % TRACKING_ALPHABET.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
export const trackingHash = (code: string) => sha256(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));

/**
 * The service-request state machine. EVERY status change in the system goes
 * through `transition()`; nothing else writes `service_requests.status`.
 *
 * One call = one database transaction step, in this order:
 *   1. the request must be visible to the actor (-> 404), then the row is locked (SELECT ... FOR UPDATE)
 *   2. the edge must be listed in REQUEST_TRANSITIONS          -> 409 INVALID_TRANSITION
 *   3. the actor must be allowed to use the edge                -> 403
 *   4. a reason must be given when the edge requires one        -> 422 REASON_REQUIRED
 *   5. business guards (documents, payment, approval, channel)  -> 422 with a specific code
 *   6. status + timestamps + version bump, append-only history, side effects that belong to
 *      the status itself (approval rows, external result), audit entry, domain events
 *   7. transition hooks (the workflow engine follows the new status)
 */
@Injectable()
export class RequestStateMachine {
  private readonly hooks: TransitionHook[] = [];

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly usage: UsageService,
    private readonly clock: Clock,
    private readonly access: RequestAccess,
    private readonly guards: RequestGuards,
    private readonly reader: RequestReader,
  ) {}

  /** Called after every committed-to transition, inside the same database transaction. */
  onTransition(hook: TransitionHook): void {
    this.hooks.push(hook);
  }

  /** Row lock. Serialises everything that changes the status or depends on it. */
  async lock(tx: Tx, requestId: string): Promise<ServiceRequest> {
    const tenantId = this.db.tenantId;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "service_requests"
      WHERE "id" = ${requestId}::uuid AND "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL
      FOR UPDATE`;
    if (!locked.length) throw Errors.notFound('Request');
    return tx.serviceRequest.findFirstOrThrow({ where: { id: requestId, tenantId } });
  }

  /** May this actor use this edge at all? (No guards, no row scoping.) */
  authorise(rule: TransitionRule, actor: TransitionActor, c: Ctx = ctx()): GuardFailure | null {
    if (actor.kind === 'ENGINE') return null;
    const automatic: GuardFailure = { status: 403, code: 'TRANSITION_NOT_ALLOWED', message: 'This step happens automatically and cannot be triggered by hand.' };
    if (actor.kind === 'SYSTEM') return rule.system ? null : automatic;
    switch (requestActorKind(c)) {
      case 'SYSTEM':
        return rule.system ? null : automatic;
      case 'STAFF':
        if (!rule.staff.length) return automatic;
        return rule.staff.some((p) => c.permissions.has(p)) ? null : { status: 403, code: 'FORBIDDEN', message: 'You do not have permission to do this.' };
      case 'CORPORATE_ADMIN':
      case 'CUSTOMER':
      case 'CORPORATE_EMPLOYEE':
        if (rule.customer) return null;
        if (rule.to === 'CANCELLED') {
          return { status: 403, code: 'CANCELLATION_NOT_ALLOWED', message: 'This request is already being processed, so it can no longer be cancelled online. Please contact the centre.' };
        }
        return { status: 403, code: 'FORBIDDEN', message: 'This step is done by the centre.' };
    }
  }

  /** The buttons to show for the current actor: edges they may use, with the guard verdict. */
  async available(tx: Tx, request: ServiceRequest): Promise<AvailableTransition[]> {
    const out: AvailableTransition[] = [];
    for (const rule of REQUEST_TRANSITIONS[request.status] ?? []) {
      if (this.authorise(rule, AS_CONTEXT)) continue;
      const blocked = await this.guards.check(tx, request, rule.to);
      out.push({ to: rule.to, action: rule.action, requiresReason: !!rule.reason, enabled: !blocked, ...(blocked ? { blocked: { code: blocked.code, message: blocked.message } } : {}) });
    }
    return out;
  }

  async transition(tx: Tx, requestId: string, to: RequestStatus, options: TransitionOptions): Promise<TransitionResult> {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const now = this.clock.now();
    // A request outside the actor's scope does not exist for them: this comes before anything
    // that could reveal its status.
    if (options.actor.kind === 'CONTEXT' && requestActorKind(c) !== 'SYSTEM') await this.access.assertVisible(tx, requestId);
    const request = await this.lock(tx, requestId);
    const from = request.status;

    // 1. The edge must exist. Nothing below can widen the table.
    const rule = findTransition(from, to);
    if (!rule) {
      throw Errors.conflict('INVALID_TRANSITION', `A request cannot go from ${REQUEST_STATUS_META[from].en} to ${REQUEST_STATUS_META[to]?.en ?? to}.`, { from, to });
    }

    // 2. Who.
    const denied = this.authorise(rule, options.actor, c);
    if (denied) throw guardError(denied);

    if (options.expectedVersion !== undefined && options.expectedVersion !== request.version) {
      throw Errors.conflict('STALE_VERSION', 'This request was changed by someone else in the meantime. Reload it and try again.', { currentVersion: request.version });
    }

    // 3. Reason.
    const reason = options.reason?.trim() || null;
    if (rule.reason && !reason) throw Errors.unprocessable('REASON_REQUIRED', `Please give a reason to ${rule.action.toLowerCase()}.`);

    // 4. Guards.
    const blocked = await this.guards.check(tx, request, to);
    if (blocked) throw guardError(blocked);

    // 5. Write.
    const meta: Record<string, unknown> = { ...(options.meta ?? {}), via: options.actor.kind };
    if (options.actor.kind === 'ENGINE' && options.actor.stepKey) meta.stepKey = options.actor.stepKey;
    const data: Prisma.ServiceRequestUncheckedUpdateManyInput = { ...(options.set ?? {}), status: to, version: { increment: 1 } };
    let trackingCode: string | undefined;
    const followUps: Array<() => Promise<void>> = [];

    if (to === 'SUBMITTED') {
      await this.usage.assertWithinLimit('monthlyRequests', tx);
      await this.usage.record('monthlyRequests', 1, tx);
      data.submittedAt = now;
      if (!request.targetDate && data.targetDate === undefined) data.targetDate = await this.defaultTargetDate(tx, request, now);
      if (!request.trackingCodeHash) {
        trackingCode = newTrackingCode();
        data.trackingCodeHash = trackingHash(trackingCode);
      }
    }
    if (to === 'AWAITING_CUSTOMER') meta.origin = from;
    if (to === 'PENDING_APPROVAL') followUps.push(() => this.ensurePendingReview(tx, requestId, c));
    if (from === 'PENDING_APPROVAL' && to !== 'READY_TO_SUBMIT') {
      // The review ends without an approval: sent back by the reviewer, or the request was cancelled.
      await tx.requestApproval.updateMany({
        where: { tenantId, requestId, type: 'REVIEW', status: 'PENDING' },
        data: to === 'CANCELLED' ? { status: 'CANCELLED', decidedAt: now } : { status: 'REJECTED', decidedById: c.userId ?? null, decidedAt: now, comment: reason },
      });
    }
    if (to === 'IN_PREPARATION') {
      // Whatever was approved before is reworked now: earlier approvals stop counting.
      await this.supersedeReviews(tx, requestId, now, from);
      if (from === 'COMPLETED') {
        data.reopenedCount = { increment: 1 };
        data.completedAt = null;
      }
    }
    if (from === 'EXTERNAL_PROCESSING' && (to === 'RETURNED' || to === 'REJECTED')) {
      Object.assign(data, await this.stampExternalOutcome(tx, requestId, to, reason, now));
    }
    if (to === 'COMPLETED') data.completedAt = now;
    if (to === 'CANCELLED') {
      data.cancelledAt = now;
      data.cancellationReason = reason;
      // Cancelling never refunds by itself. Money already received is flagged for finance.
      const position = await this.reader.position(tx, requestId);
      if (position.paid.gt(0)) {
        meta.refundReviewNeeded = true;
        meta.amountHeld = position.paid.toFixed(2);
      }
    }

    const updated = await tx.serviceRequest.updateMany({ where: { id: requestId, tenantId, status: from, version: request.version }, data });
    if (updated.count !== 1) throw Errors.conflict('CONCURRENT_UPDATE', 'This request was changed at the same moment. Reload it and try again.');
    for (const followUp of followUps) await followUp();

    const customerVisible = options.customerVisible ?? REQUEST_STATUS_META[from].customerEn !== REQUEST_STATUS_META[to].customerEn;
    const customerMessage = options.customerMessage?.trim() || REQUEST_STATUS_META[to].customerEn;
    await this.appendHistory(tx, { requestId, from, to, reason, customerVisible, customerMessage, meta, at: now });

    const after = await tx.serviceRequest.findFirstOrThrow({ where: { id: requestId, tenantId } });
    await this.audit.log(
      {
        action: 'request.status_changed',
        resourceType: 'ServiceRequest',
        resourceId: requestId,
        summary: `${request.requestNo}: ${REQUEST_STATUS_META[from].en} -> ${REQUEST_STATUS_META[to].en}`,
        before: { status: from },
        after: { status: to, reason, via: options.actor.kind, ...(meta.refundReviewNeeded ? { refundReviewNeeded: true } : {}) },
      },
      tx,
    );

    // 6. Events.
    const base = { requestId, customerId: request.customerId };
    await this.events.emit(tx, 'request.status_changed', { ...base, requestNo: request.requestNo, from, to, customerVisible, customerMessage, ...(reason ? { reason } : {}) });
    if (to === 'SUBMITTED') await this.events.emit(tx, 'request.submitted', base);
    if (to === 'AWAITING_CUSTOMER') await this.events.emit(tx, 'request.information_requested', { ...base, message: customerMessage });
    if (to === 'COMPLETED') await this.events.emit(tx, 'request.completed', base);
    if (to === 'CANCELLED') {
      await this.events.emit(tx, 'request.cancelled', { ...base, ...(reason ? { reason } : {}), refundReviewNeeded: meta.refundReviewNeeded === true, ...(meta.amountHeld ? { amountHeld: meta.amountHeld } : {}) });
    }

    // 7. Hooks (workflow engine).
    const result: TransitionResult = { request: after, from, to, trackingCode };
    for (const hook of this.hooks) await hook(tx, result);
    return { ...result, request: await tx.serviceRequest.findFirstOrThrow({ where: { id: requestId, tenantId } }) };
  }

  /**
   * A customer-visible update that does not change the status (workflow
   * notification steps). Recorded in the same append-only history.
   */
  async note(tx: Tx, requestId: string, input: { customerMessage: string; customerVisible: boolean; meta?: Record<string, unknown> }): Promise<void> {
    const request = await this.lock(tx, requestId);
    await this.appendHistory(tx, {
      requestId, from: request.status, to: request.status, reason: null, customerVisible: input.customerVisible, customerMessage: input.customerMessage, meta: { ...(input.meta ?? {}), kind: 'NOTE' }, at: this.clock.now(),
    });
  }

  // ------------------------------------------------------------------ internals
  private async appendHistory(
    tx: Tx,
    row: { requestId: string; from: RequestStatus | null; to: RequestStatus; reason: string | null; customerVisible: boolean; customerMessage: string | null; meta: Record<string, unknown>; at: Date },
  ): Promise<void> {
    const c = ctx();
    // The request row is locked, so the sequence number is exact. It orders rows written in the same millisecond.
    const seq = (await tx.requestStatusHistory.count({ where: { tenantId: this.db.tenantId, requestId: row.requestId } })) + 1;
    await tx.requestStatusHistory.create({
      data: {
        tenantId: this.db.tenantId,
        requestId: row.requestId,
        fromStatus: row.from,
        toStatus: row.to,
        actorId: c.userId ?? null,
        actorType: c.actorType,
        reason: row.reason,
        customerVisible: row.customerVisible,
        customerMessage: row.customerMessage,
        meta: { ...row.meta, seq } as object,
        createdAt: row.at,
      },
    });
  }

  /** First history row of a request (creation). */
  async recordCreation(tx: Tx, requestId: string): Promise<void> {
    await this.appendHistory(tx, { requestId, from: null, to: 'DRAFT', reason: null, customerVisible: true, customerMessage: REQUEST_STATUS_META.DRAFT.customerEn, meta: { via: 'CONTEXT' }, at: this.clock.now() });
  }

  private async defaultTargetDate(tx: Tx, request: ServiceRequest, now: Date): Promise<Date> {
    const snapshot = await this.reader.snapshot(tx, request);
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
    const configured = Number(((tenant.settings ?? {}) as Record<string, unknown>).defaultTargetHours);
    const hours = snapshot.estimatedProcessingHours ?? (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TARGET_HOURS);
    return new Date(now.getTime() + hours * 3_600_000);
  }

  private async ensurePendingReview(tx: Tx, requestId: string, c: Ctx): Promise<void> {
    const tenantId = this.db.tenantId;
    const pending = await tx.requestApproval.findFirst({ where: { tenantId, requestId, type: 'REVIEW', status: 'PENDING' }, select: { id: true } });
    if (!pending) await tx.requestApproval.create({ data: { tenantId, requestId, type: 'REVIEW', status: 'PENDING', requestedById: c.userId ?? null, createdAt: this.clock.now() } });
  }

  private async supersedeReviews(tx: Tx, requestId: string, now: Date, from: RequestStatus): Promise<void> {
    const approved = await tx.requestApproval.findMany({ where: { tenantId: this.db.tenantId, requestId, type: 'REVIEW', status: 'APPROVED' }, select: { id: true, payload: true } });
    for (const approval of approved) {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      if (payload.supersededAt) continue;
      await tx.requestApproval.update({ where: { id: approval.id }, data: { payload: { ...payload, supersededAt: now.toISOString(), supersededBecause: `Returned to preparation from ${from}` } as object } });
    }
  }

  /** Writes RETURNED / REJECTED onto the open submission and mirrors it on the request. */
  private async stampExternalOutcome(tx: Tx, requestId: string, outcome: 'RETURNED' | 'REJECTED', note: string | null, now: Date) {
    const reference = await this.reader.latestExternalReference(tx, requestId);
    if (!reference || externalResultOf(reference)) return {};
    const source = reference.channel === 'AUTHORISED_PARTNER' ? 'PARTNER_PROVIDED' : 'STAFF_ENTERED';
    await tx.requestExternalReference.update({ where: { id: reference.id }, data: { status: outcome, statusSource: source, notes: note ?? reference.notes } });
    return { externalStatus: outcome, externalStatusSource: source, externalStatusAt: now } as const;
  }
}
