import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OPEN_STATUSES, REQUEST_STATUS_META, WORKFLOW_STEP_META } from '@typease/types';
import type { RequestStatus, WorkflowStepType } from '@typease/types';
import type { ServiceRequest, WorkflowExecution, WorkflowStepExecution } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError, Errors } from '../../common/errors';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { DocumentStorePort } from '../../common/ports';
import { TenantDirectory } from '../../common/tenant-directory';
import { Clock } from '../workflows/clock';
import { evaluateRule } from '../workflows/rule-evaluator';
import { defaultNextKey, WorkflowStepDef } from '../workflows/workflow-validator';
import { WorkflowsService } from '../workflows/workflows.service';
import { formFieldsOf } from './form-validator';
import { derivePaymentStatus } from './payment-policy';
import { RequestGuards } from './request-guards.service';
import { permittedChannels, RequestReader } from './request-reader.service';
import { RequestStateMachine, TransitionOptions, TransitionResult } from './request-state-machine.service';
import { buildRequestSummaryPdf } from './summary-pdf';

type Outcome =
  | { kind: 'WAIT'; blocked?: { code: string; message: string } }
  | { kind: 'COMPLETE'; result?: Record<string, unknown> }
  | { kind: 'SKIP'; result?: Record<string, unknown> }
  | { kind: 'GOTO'; stepKey: string; result?: Record<string, unknown> }
  | { kind: 'FAIL'; message: string; optional: boolean };
const WAIT: Outcome = { kind: 'WAIT' };

type Attempt = { ok: true; request: ServiceRequest } | { ok: false; code: string; message: string };

/** Who a workflow task of a step is for. */
type TaskAudience = 'OPERATOR' | 'REVIEWER' | 'ROLE';
const TASK_AUDIENCE: Partial<Record<WorkflowStepType, TaskAudience>> = {
  QUOTATION: 'ROLE', PAYMENT: 'ROLE', STAFF_TASK: 'OPERATOR', EXTERNAL_PROCESSING: 'OPERATOR', INTERNAL_APPROVAL: 'REVIEWER', COMPLETION: 'REVIEWER',
};

/** Statuses in which the request has not been released for processing yet. */
const BEFORE_PROCESSING: RequestStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT'];
/** Statuses that mean "preparation is finished" for a staff task. */
const AFTER_PREPARATION: RequestStatus[] = ['PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'FINAL_REVIEW', 'COMPLETED'];
const RELEASED: RequestStatus[] = ['READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED', 'FINAL_REVIEW', 'COMPLETED'];

const MAX_STEPS_PER_RUN = 100;
export const SCAN_JOB = 'workflows.scan';
export const ADVANCE_JOB = 'workflows.advance';
export const OVERDUE_MARKER = 'overdue';

/**
 * The workflow execution engine.
 *
 * It does not own the status of a request: the state machine does. The engine
 * is a driver that follows the pinned workflow version step by step and, at
 * each step,
 *   - performs the system transition the step stands for, if the state machine allows it,
 *   - creates the workflow task for the people who have to act,
 *   - decides from the current facts whether the step is finished.
 *
 * Every step handler is a pure function of the database state, so `advance()`
 * can be called any number of times (after every transition, on every domain
 * event, from a retry job) and always converges to the same result. When a
 * guard refuses a transition the engine does not force it: the step stays
 * active with the reason recorded, and is retried on the next advance.
 * All writes happen in the caller's transaction.
 */
@Injectable()
export class WorkflowEngine implements OnModuleInit {
  private readonly logger = new Logger(WorkflowEngine.name);
  /** Request ids being advanced further up the call stack (re-entrancy guard). */
  private readonly running = new AsyncLocalStorage<Set<string>>();
  private savepoints = 0;

  constructor(
    private readonly db: TenantDb,
    private readonly machine: RequestStateMachine,
    private readonly guards: RequestGuards,
    private readonly reader: RequestReader,
    private readonly workflows: WorkflowsService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly clock: Clock,
    @Optional() private documentStore?: DocumentStorePort,
  ) {}

  onModuleInit() {
    this.machine.onTransition((tx, result) => this.onStatusChanged(tx, result));

    const on = (type: Parameters<DomainEvents['on']>[0], handler: (tx: Tx, payload: Record<string, any>, event: DomainEvent) => Promise<string[]>) =>
      this.events.on(type, (event, tx) => this.isolated(tx, type, event.payload, () => handler(tx, event.payload, event)));
    on('document.uploaded', (tx, p) => this.onDocumentUploaded(tx, p));
    on('document.verified', (tx, p, e) => this.onDocumentReviewed(tx, p, 'VERIFIED', e));
    on('document.rejected', (tx, p, e) => this.onDocumentReviewed(tx, p, 'REJECTED', e));
    on('quotation.sent', (tx, p) => this.onRequestEvent(tx, [p.requestId]));
    on('quotation.approved', (tx, p) => this.onRequestEvent(tx, [p.requestId]));
    on('quotation.rejected', (tx, p) => this.onRequestEvent(tx, [p.requestId]));
    on('invoice.issued', (tx, p) => this.onMoneyEvent(tx, [p.requestId], [p.invoiceId]));
    on('payment.completed', (tx, p) => this.onMoneyEvent(tx, p.requestIds ?? [], p.invoiceIds ?? []));
    on('refund.completed', (tx, p) => this.onMoneyEvent(tx, [p.requestId], [p.invoiceId]));
    // A voided invoice no longer counts and a credit note lowers what is owed: both change the payment status.
    on('invoice.voided', (tx, p) => this.onMoneyEvent(tx, [p.requestId], [p.invoiceId]));
    on('creditnote.issued', (tx, p) => this.onMoneyEvent(tx, [p.requestId], [p.invoiceId]));

    this.jobs.register<{ tenantId: string; requestId: string }>(ADVANCE_JOB, async (payload) => {
      await this.db.tx(async (tx) => {
        await this.recomputePaymentStatus(tx, payload.requestId);
        await this.advance(tx, payload.requestId);
      });
    });
    this.jobs.register(SCAN_JOB, async () => {
      await this.tenants.forEachTenant(SCAN_JOB, async () => void (await this.scanTenant()));
    });
    this.jobs.schedule({ name: SCAN_JOB, everySeconds: 300, description: 'Escalate workflow steps past their time limit, flag requests past their target date and send requests with a lapsed quotation back for a revised offer' });
  }

  // =====================================================================================
  // Public API
  // =====================================================================================

  /** Creates the execution of a submitted request (pinned to the request's workflow version). Idempotent. */
  async start(tx: Tx, request: ServiceRequest): Promise<void> {
    const tenantId = this.db.tenantId;
    const existing = await tx.workflowExecution.findFirst({ where: { tenantId, requestId: request.id }, select: { id: true } });
    if (existing) return;
    let versionId = request.workflowVersionId;
    if (!versionId) {
      // Drafts created before a workflow existed are pinned at submission.
      const service = await tx.service.findFirstOrThrow({ where: { id: request.serviceId, tenantId }, select: { workflowDefinitionId: true } });
      versionId = (await this.workflows.resolvePublishedVersion(tx, service.workflowDefinitionId)).versionId;
      await tx.serviceRequest.update({ where: { id: request.id }, data: { workflowVersionId: versionId } });
    }
    const steps = await this.workflows.stepsOf(tx, versionId);
    await tx.workflowExecution.create({ data: { tenantId, requestId: request.id, versionId, status: 'ACTIVE', currentStepKey: steps[0]?.key ?? null, startedAt: this.clock.now() } });
  }

  /** Move the workflow of a request as far as the current facts allow. Safe to call at any time. */
  async advance(tx: Tx, requestId: string): Promise<void> {
    const active = this.running.getStore();
    if (active?.has(requestId)) return; // the loop further up will see the change
    await this.running.run(new Set([...(active ?? []), requestId]), () => this.run(tx, requestId));
  }

  /**
   * "Preparation done": completes the active staff task and lets the workflow
   * decide what comes next (review, submission or final review).
   */
  async completeStaffTask(tx: Tx, request: ServiceRequest, input: { stepKey?: string; note?: string | null }): Promise<void> {
    const execution = await this.lockExecution(tx, request.id);
    const notActive = Errors.conflict('STEP_NOT_ACTIVE', 'There is no preparation task waiting on this request right now.');
    if (!execution || execution.status !== 'ACTIVE' || request.status !== 'IN_PREPARATION') throw notActive;
    const steps = await this.workflows.stepsOf(tx, execution.versionId);
    const step = steps.find((s) => s.key === execution.currentStepKey);
    if (!step || step.type !== 'STAFF_TASK' || (input.stepKey && input.stepKey !== step.key)) throw notActive;
    const open = await this.openStepExecution(tx, execution.id, step.key);
    if (!open) throw notActive;
    await tx.workflowStepExecution.update({
      where: { id: open.id },
      data: { result: { ...(open.result as object), completedBy: ctx().userId ?? null, completedNote: input.note ?? null, completedManually: true } },
    });
    await this.audit.log({ action: 'request.step_completed', resourceType: 'ServiceRequest', resourceId: request.id, summary: `${request.requestNo}: ${step.name} done`, after: { stepKey: step.key, note: input.note ?? null } }, tx);
    await this.advance(tx, request.id);
  }

  /**
   * Explicitly moves ONE running case to the currently published version of
   * its workflow. The current step is matched by key; if the new version has no
   * step with that key the migration is refused.
   */
  async migrate(tx: Tx, request: ServiceRequest): Promise<{ fromVersion: number; toVersion: number; currentStepKey: string | null }> {
    const tenantId = this.db.tenantId;
    if (!request.workflowVersionId) throw Errors.conflict('NO_WORKFLOW', 'This request is not attached to a workflow yet.');
    if (['COMPLETED', 'CANCELLED'].includes(request.status)) throw Errors.conflict('REQUEST_CLOSED', 'A closed request keeps the workflow it was processed with.');
    const current = await tx.workflowVersion.findFirstOrThrow({ where: { id: request.workflowVersionId, tenantId }, select: { id: true, version: true, definitionId: true } });
    const target = await tx.workflowVersion.findFirst({ where: { tenantId, definitionId: current.definitionId, status: 'PUBLISHED' }, select: { id: true, version: true } });
    if (!target) throw Errors.conflict('WORKFLOW_NOT_PUBLISHED', 'This workflow has no published version to migrate to.');
    if (target.id === current.id) throw Errors.conflict('ALREADY_CURRENT', `This request already uses the published version (${current.version}).`);

    const execution = await this.lockExecution(tx, request.id);
    let currentStepKey: string | null = null;
    if (execution) {
      const [oldSteps, newSteps] = [await this.workflows.stepsOf(tx, current.id), await this.workflows.stepsOf(tx, target.id)];
      currentStepKey = execution.currentStepKey ?? oldSteps[0]?.key ?? null;
      const match = newSteps.find((s) => s.key === currentStepKey);
      if (!match) {
        const name = oldSteps.find((s) => s.key === currentStepKey)?.name ?? currentStepKey;
        throw Errors.conflict(
          'STEP_NOT_IN_TARGET',
          `The request is at the step "${name}" (${currentStepKey}), which does not exist in version ${target.version}. Finish this step first, or keep the request on version ${current.version}.`,
          { stepKey: currentStepKey, fromVersion: current.version, toVersion: target.version },
        );
      }
      // A corrected workflow also restarts an execution that was stopped because of a loop.
      await tx.workflowExecution.update({ where: { id: execution.id }, data: { versionId: target.id, migratedFromVersionId: current.id, ...(execution.status === 'FAILED' ? { status: 'ACTIVE' } : {}) } });
      // The open step keeps running under its new definition (name and deadline are refreshed).
      const open = await this.openStepExecution(tx, execution.id, match.key);
      if (open) {
        await tx.workflowStepExecution.update({
          where: { id: open.id },
          data: { stepName: match.name, stepType: match.type, dueAt: match.timeoutHours && open.startedAt ? new Date(open.startedAt.getTime() + match.timeoutHours * 3_600_000) : null },
        });
      }
    }
    await tx.serviceRequest.update({ where: { id: request.id }, data: { workflowVersionId: target.id } });
    await this.audit.log(
      { action: 'request.workflow_migrated', resourceType: 'ServiceRequest', resourceId: request.id, summary: `${request.requestNo}: workflow version ${current.version} -> ${target.version}`, before: { workflowVersionId: current.id, version: current.version }, after: { workflowVersionId: target.id, version: target.version, currentStepKey } },
      tx,
    );
    await this.advance(tx, request.id);
    return { fromVersion: current.version, toVersion: target.version, currentStepKey };
  }

  /** Keeps open workflow tasks pointed at the current operator / reviewer of the request. */
  async syncTaskAssignees(tx: Tx, request: ServiceRequest): Promise<void> {
    const tenantId = this.db.tenantId;
    if (!request.workflowVersionId) return;
    const tasks = await tx.task.findMany({ where: { tenantId, requestId: request.id, source: 'WORKFLOW', status: { in: ['OPEN', 'IN_PROGRESS'] } }, include: { taskAssignments: { where: { unassignedAt: null } } } });
    if (!tasks.length) return;
    const steps = await this.workflows.stepsOf(tx, (await tx.workflowExecution.findFirst({ where: { tenantId, requestId: request.id }, select: { versionId: true } }))?.versionId ?? request.workflowVersionId);
    for (const task of tasks) {
      const audience = TASK_AUDIENCE[steps.find((s) => s.key === task.stepKey)?.type ?? 'NOTIFICATION'];
      const target = audience === 'OPERATOR' ? request.assignedToId : audience === 'REVIEWER' ? request.reviewerId : null;
      if (!target || task.taskAssignments.some((a) => a.assigneeId === target)) continue;
      await tx.taskAssignment.updateMany({ where: { tenantId, taskId: task.id, unassignedAt: null }, data: { unassignedAt: this.clock.now() } });
      await tx.taskAssignment.create({ data: { tenantId, taskId: task.id, assigneeId: target, assignedById: ctx().userId ?? null, assignedAt: this.clock.now() } });
    }
  }

  /** Workflow progress for the API (customers only get customer-visible steps and no internals). */
  async progress(tx: Tx, request: ServiceRequest, options: { forCustomer: boolean }) {
    const tenantId = this.db.tenantId;
    if (!request.workflowVersionId) return null;
    const execution = await tx.workflowExecution.findFirst({ where: { tenantId, requestId: request.id }, include: { workflowStepExecutions: { orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }] } } });
    const versionId = execution?.versionId ?? request.workflowVersionId;
    const [steps, version] = [await this.workflows.stepsOf(tx, versionId), await tx.workflowVersion.findFirst({ where: { id: versionId, tenantId }, select: { version: true, definition: { select: { id: true, key: true, name: true } } } })];
    const latest = new Map<string, WorkflowStepExecution>();
    for (const row of execution?.workflowStepExecutions ?? []) latest.set(row.stepKey, row);
    const rows = steps
      .filter((s) => !options.forCustomer || s.customerVisible !== false)
      .map((s, i) => {
        const row = latest.get(s.key);
        const result = (row?.result ?? {}) as Record<string, any>;
        const base = { key: s.key, name: s.name, nameAr: s.nameAr ?? null, type: s.type, position: i + 1, status: row?.status ?? 'PENDING', current: execution?.status === 'ACTIVE' && execution.currentStepKey === s.key, startedAt: row?.startedAt ?? null, completedAt: row?.completedAt ?? null };
        if (options.forCustomer) return base;
        return { ...base, attempt: row?.attempt ?? 0, dueAt: row?.dueAt ?? null, escalatedAt: row?.escalatedAt ?? null, assigneeRoleKey: s.assigneeRoleKey ?? null, waitsFor: WORKFLOW_STEP_META[s.type].waitsFor, blocked: result.blocked ?? null, note: result.message ?? null };
      });
    const summary = { status: execution?.status ?? 'NOT_STARTED', currentStepKey: execution?.status === 'ACTIVE' ? execution.currentStepKey : null, steps: rows };
    if (options.forCustomer) return summary;
    return { ...summary, definition: version?.definition ?? null, version: version?.version ?? null, versionId, migratedFromVersionId: execution?.migratedFromVersionId ?? null, startedAt: execution?.startedAt ?? null, completedAt: execution?.completedAt ?? null };
  }

  /** request.paymentStatus is derived from the request's invoices; finance never writes it. */
  async recomputePaymentStatus(tx: Tx, requestId: string): Promise<void> {
    const request = await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId: this.db.tenantId }, select: { id: true, paymentStatus: true } });
    if (!request) return;
    const status = derivePaymentStatus(await this.reader.position(tx, requestId));
    if (status !== request.paymentStatus) await tx.serviceRequest.update({ where: { id: requestId }, data: { paymentStatus: status } });
  }

  // =====================================================================================
  // Reactions
  // =====================================================================================

  /** Runs after every status change, in the same transaction. */
  private async onStatusChanged(tx: Tx, { request, from, to }: TransitionResult): Promise<void> {
    if (to === 'SUBMITTED') await this.start(tx, request);
    // Closing the request closes its execution and every open workflow / escalation task, whatever state the execution is in.
    if (to === 'CANCELLED' || to === 'COMPLETED') return this.closeExecution(tx, request.id, to);
    if (to === 'IN_PREPARATION') await this.returnToPreparation(tx, request, from);
    await this.advance(tx, request.id);
  }

  /**
   * A listener of another module's event must never break that module's
   * transaction (a payment has to be recorded even if the workflow cannot be
   * advanced). Each reaction runs inside a savepoint; if it fails, its own
   * writes are undone, the error is logged and a retry job is queued.
   */
  private async isolated(tx: Tx, type: string, payload: Record<string, any>, fn: () => Promise<string[]>): Promise<void> {
    const name = `wf_${++this.savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
    try {
      await fn();
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    } catch (e: any) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      this.logger.error(`workflow reaction to ${type} failed and will be retried: ${e?.stack ?? e}`);
      const tenantId = this.db.tenantId;
      const requestIds = [...new Set([payload.requestId, ...(Array.isArray(payload.requestIds) ? payload.requestIds : [])].filter((id): id is string => typeof id === 'string'))];
      this.db.afterCommit(async () => {
        for (const requestId of requestIds) await this.jobs.enqueue(ADVANCE_JOB, { tenantId, requestId });
      });
    }
  }

  private async openRequest(tx: Tx, requestId: unknown): Promise<ServiceRequest | null> {
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) return null;
    return tx.serviceRequest.findFirst({ where: { id: requestId, tenantId: this.db.tenantId, deletedAt: null } });
  }

  private async onRequestEvent(tx: Tx, requestIds: unknown[]): Promise<string[]> {
    const done: string[] = [];
    for (const id of new Set(requestIds)) {
      const request = await this.openRequest(tx, id);
      if (!request) continue;
      await this.advance(tx, request.id);
      done.push(request.id);
    }
    return done;
  }

  private async onMoneyEvent(tx: Tx, requestIds: unknown[], invoiceIds: unknown[]): Promise<string[]> {
    const ids = new Set<unknown>(requestIds);
    const invoices = invoiceIds.filter((id): id is string => typeof id === 'string');
    if (invoices.length) {
      const rows = await tx.invoice.findMany({ where: { tenantId: this.db.tenantId, id: { in: invoices }, requestId: { not: null } }, select: { requestId: true } });
      for (const row of rows) ids.add(row.requestId);
    }
    const done: string[] = [];
    for (const id of ids) {
      const request = await this.openRequest(tx, id);
      if (!request) continue;
      // The payment status is kept correct for closed requests too; only open ones move.
      await this.recomputePaymentStatus(tx, request.id);
      await this.advance(tx, request.id);
      done.push(request.id);
    }
    return done;
  }

  /** document.uploaded -> the matching checklist line shows the document. */
  private async onDocumentUploaded(tx: Tx, p: Record<string, any>): Promise<string[]> {
    const tenantId = this.db.tenantId;
    const request = await this.openRequest(tx, p.requestId);
    if (!request || ['COMPLETED', 'CANCELLED'].includes(request.status)) return [];
    const document = typeof p.documentId === 'string' ? await tx.document.findFirst({ where: { id: p.documentId, tenantId }, select: { id: true, documentTypeKey: true, isCompletionDocument: true, verificationStatus: true } }) : null;
    if (!document) return [];
    await this.machine.lock(tx, request.id);
    const lines = (await this.reader.checklist(tx, request.id)).lines;
    let line = typeof p.checklistItemId === 'string' ? lines.find((l) => l.id === p.checklistItemId) : undefined;
    if (!line) {
      const kind = document.isCompletionDocument ? 'COMPLETION' : 'INPUT';
      const sameType = lines.filter((l) => l.kind === kind && l.documentTypeKey === (p.documentTypeKey ?? document.documentTypeKey));
      // First a line that still has nothing, then one whose document was rejected (a replacement).
      line = sameType.find((l) => l.status === 'MISSING') ?? sameType.find((l) => l.status === 'REJECTED');
    }
    if (!line) return [];
    // Completed documents come from the centre only (the documents module refuses such an upload; this is the second lock).
    if (line.kind === 'COMPLETION' && ['CUSTOMER', 'CORPORATE'].includes(String(p.uploadedByType))) return [];
    await tx.requestDocument.update({
      where: { id: line.id },
      data: { documentId: document.id, status: document.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'UPLOADED', rejectionReason: null, reviewedById: null, reviewedAt: null },
    });
    await this.advance(tx, request.id);
    return [request.id];
  }

  /** document.verified / document.rejected -> every checklist line that uses the document follows. */
  private async onDocumentReviewed(tx: Tx, p: Record<string, any>, status: 'VERIFIED' | 'REJECTED', event: DomainEvent): Promise<string[]> {
    const tenantId = this.db.tenantId;
    if (typeof p.documentId !== 'string') return [];
    const lines = await tx.requestDocument.findMany({
      where: { tenantId, documentId: p.documentId, status: { not: status }, request: { status: { notIn: ['COMPLETED', 'CANCELLED'] }, deletedAt: null } },
      select: { id: true, requestId: true },
    });
    const requestIds = [...new Set(lines.map((l) => l.requestId))].sort();
    for (const requestId of requestIds) {
      await this.machine.lock(tx, requestId);
      await tx.requestDocument.updateMany({
        where: { tenantId, requestId, documentId: p.documentId, status: { not: status } },
        data: { status, rejectionReason: status === 'REJECTED' ? String(p.reason ?? '').slice(0, 500) || null : null, reviewedById: event.payload?._actor?.userId ?? null, reviewedAt: this.clock.now() },
      });
      await this.advance(tx, requestId);
    }
    return requestIds;
  }

  // =====================================================================================
  // The loop
  // =====================================================================================

  private async lockExecution(tx: Tx, requestId: string): Promise<WorkflowExecution | null> {
    const tenantId = this.db.tenantId;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "workflow_executions" WHERE "requestId" = ${requestId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return rows.length ? tx.workflowExecution.findFirst({ where: { id: rows[0].id, tenantId } }) : null;
  }

  private openStepExecution(tx: Tx, executionId: string, stepKey: string) {
    return tx.workflowStepExecution.findFirst({ where: { tenantId: this.db.tenantId, executionId, stepKey, status: { in: ['ACTIVE', 'FAILED'] }, completedAt: null }, orderBy: { attempt: 'desc' } });
  }

  private async run(tx: Tx, requestId: string): Promise<void> {
    const tenantId = this.db.tenantId;
    // Lock order is always request row, then execution row.
    const exists = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "service_requests" WHERE "id" = ${requestId}::uuid AND "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!exists.length) return;
    const execution = await this.lockExecution(tx, requestId);
    if (!execution || execution.status !== 'ACTIVE') return;
    const steps = await this.workflows.stepsOf(tx, execution.versionId);
    if (!steps.length) return;
    let currentKey = execution.currentStepKey ?? steps[0].key;
    /** Steps handled during this run. Coming back to one without having waited in between is a configuration loop. */
    const entered = new Set<string>();

    for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
      const request = await tx.serviceRequest.findFirstOrThrow({ where: { id: requestId, tenantId } });
      if (request.status === 'CANCELLED') return this.closeExecution(tx, requestId, 'CANCELLED');
      if (request.status === 'COMPLETED') return this.closeExecution(tx, requestId, 'COMPLETED');
      // Nothing moves while the customer has to act, or before submission.
      if (request.status === 'DRAFT' || request.status === 'AWAITING_CUSTOMER') return;

      const index = steps.findIndex((s) => s.key === currentKey);
      if (index < 0) {
        this.logger.error(`workflow execution ${execution.id}: step "${currentKey}" does not exist in version ${execution.versionId}`);
        return;
      }
      const step = steps[index];
      let open = await this.openStepExecution(tx, execution.id, step.key);
      if (!open && entered.has(step.key)) return this.failExecution(tx, execution, request, step);
      entered.add(step.key);
      if (!open) {
        const skip = await this.skipReason(tx, step, request);
        if (skip) {
          await this.recordStep(tx, execution.id, step, 'SKIPPED', { skipped: skip });
          const next = defaultNextKey(steps, index);
          if (!next) return;
          currentKey = next;
          await tx.workflowExecution.update({ where: { id: execution.id }, data: { currentStepKey: currentKey } });
          continue;
        }
        open = await this.recordStep(tx, execution.id, step, 'ACTIVE', {});
        await tx.workflowExecution.update({ where: { id: execution.id }, data: { currentStepKey: step.key } });
      }

      const outcome = await this.handle(tx, step, steps, open, request);
      if (outcome.kind === 'WAIT') {
        await this.noteBlocked(tx, open, outcome.blocked ?? null);
        return;
      }
      if (outcome.kind === 'FAIL') {
        const before = (open.result ?? {}) as Record<string, any>;
        if (open.status !== 'FAILED' || before.message !== outcome.message) {
          await tx.workflowStepExecution.update({
            where: { id: open.id },
            data: { status: 'FAILED', completedAt: outcome.optional ? this.clock.now() : null, result: { ...before, blocked: null, message: outcome.message, continuedBecauseOptional: outcome.optional } },
          });
        }
        // A mandatory step stays current and is retried on the next advance; an optional one is passed.
        if (!outcome.optional) return;
      } else {
        await tx.workflowStepExecution.update({
          where: { id: open.id },
          data: {
            status: outcome.kind === 'SKIP' ? 'SKIPPED' : 'COMPLETED',
            completedAt: this.clock.now(),
            actorId: ctx().userId ?? null,
            result: { ...(open.result as object), ...(outcome.result ?? {}), blocked: null, ...(outcome.kind === 'GOTO' ? { goTo: outcome.stepKey } : {}) },
          },
        });
      }
      await this.closeTasks(tx, requestId, step.key, 'DONE');

      const next = outcome.kind === 'GOTO' ? outcome.stepKey : defaultNextKey(steps, index);
      if (!next) return;
      currentKey = next;
      await tx.workflowExecution.update({ where: { id: execution.id }, data: { currentStepKey: currentKey } });
    }
    this.logger.error(`workflow execution ${execution.id} did not settle after ${MAX_STEPS_PER_RUN} steps; stopped at "${currentKey}"`);
  }

  /**
   * The workflow would run in circles (a branch that always leads back to a
   * step that is already finished). The execution is stopped and marked FAILED
   * instead of spinning; the request itself is unaffected and staff continue
   * with the normal status actions. Migrating the case to a corrected workflow
   * version starts the execution again.
   */
  private async failExecution(tx: Tx, execution: WorkflowExecution, request: ServiceRequest, step: WorkflowStepDef): Promise<void> {
    const message = `The workflow keeps returning to the step "${step.name}" without waiting for anything. It was stopped; correct the workflow and migrate this request to the new version.`;
    this.logger.error(`workflow execution ${execution.id} (${request.requestNo}) stopped: loop at step "${step.key}"`);
    await this.recordStep(tx, execution.id, step, 'FAILED', { message, loop: true });
    await tx.workflowExecution.update({ where: { id: execution.id }, data: { status: 'FAILED', currentStepKey: step.key } });
    await this.audit.log({ action: 'request.workflow_failed', resourceType: 'ServiceRequest', resourceId: request.id, summary: `${request.requestNo}: workflow stopped (loop at "${step.key}")`, after: { stepKey: step.key, versionId: execution.versionId } }, tx);
  }

  /** Why a step is not entered at all, or null when it applies. */
  private async skipReason(tx: Tx, step: WorkflowStepDef, request: ServiceRequest): Promise<string | null> {
    if (step.type === 'COMPLETION') return null;
    if (step.conditions && !evaluateRule(step.conditions, await this.reader.facts(tx, request))) return 'CONDITION_NOT_MET';
    if (step.type === 'EXTERNAL_PROCESSING') {
      // Compliance beats configuration: a preparation-only service is never submitted by the centre.
      const snapshot = await this.reader.snapshot(tx, request);
      if (!permittedChannels(snapshot.complianceCapability).length) return 'SUBMISSION_NOT_PERMITTED';
    }
    return null;
  }

  private async recordStep(tx: Tx, executionId: string, step: WorkflowStepDef, status: 'ACTIVE' | 'SKIPPED' | 'FAILED', result: Record<string, unknown>) {
    const tenantId = this.db.tenantId;
    const now = this.clock.now();
    const attempt = (await tx.workflowStepExecution.count({ where: { tenantId, executionId, stepKey: step.key } })) + 1;
    return tx.workflowStepExecution.create({
      data: {
        tenantId, executionId, stepKey: step.key, stepName: step.name, stepType: step.type, status, attempt,
        startedAt: now, createdAt: now,
        completedAt: status === 'ACTIVE' ? null : now,
        dueAt: status === 'ACTIVE' && step.timeoutHours ? new Date(now.getTime() + step.timeoutHours * 3_600_000) : null,
        result: result as object,
      },
    });
  }

  private async noteBlocked(tx: Tx, open: WorkflowStepExecution, blocked: { code: string; message: string } | null): Promise<void> {
    const current = ((open.result ?? {}) as Record<string, any>).blocked ?? null;
    if ((current?.code ?? null) === (blocked?.code ?? null) && (current?.message ?? null) === (blocked?.message ?? null)) return;
    await tx.workflowStepExecution.update({ where: { id: open.id }, data: { result: { ...(open.result as object), blocked } } });
  }

  /** Ends the execution together with the request (COMPLETED or CANCELLED). */
  private async closeExecution(tx: Tx, requestId: string, status: 'COMPLETED' | 'CANCELLED'): Promise<void> {
    const tenantId = this.db.tenantId;
    const now = this.clock.now();
    const execution = await this.lockExecution(tx, requestId);
    if (execution && execution.status === 'ACTIVE') {
      await tx.workflowStepExecution.updateMany({
        where: { tenantId, executionId: execution.id, status: { in: ['ACTIVE', 'FAILED'] }, completedAt: null },
        data: { status, completedAt: now, actorId: ctx().userId ?? null },
      });
      await tx.workflowExecution.update({ where: { id: execution.id }, data: { status, completedAt: now } });
    }
    await tx.task.updateMany({
      where: { tenantId, requestId, source: { in: ['WORKFLOW', 'ESCALATION'] }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      data: status === 'COMPLETED' ? { status: 'DONE', completedAt: now, completedById: ctx().userId ?? null } : { status: 'CANCELLED', completedAt: now },
    });
  }

  /**
   * The request went (back) to preparation: review rejected, returned by the
   * authority, sent back from final review, or reopened. The workflow restarts
   * at the preparation step that precedes the step it was at.
   */
  private async returnToPreparation(tx: Tx, request: ServiceRequest, from: RequestStatus): Promise<void> {
    const execution = await this.lockExecution(tx, request.id);
    if (!execution || execution.status === 'CANCELLED' || execution.status === 'FAILED') return;
    const steps = await this.workflows.stepsOf(tx, execution.versionId);
    const index = steps.findIndex((s) => s.key === execution.currentStepKey);
    if (index < 0) return;
    const current = steps[index];
    const open = execution.status === 'ACTIVE' ? await this.openStepExecution(tx, execution.id, current.key) : null;
    if (execution.status === 'ACTIVE' && current.type === 'STAFF_TASK') return; // preparation simply starts or resumes

    const rejectedReview = from === 'PENDING_APPROVAL' && current.type === 'INTERNAL_APPROVAL';
    const configured = rejectedReview && current.onRejectStepKey ? steps.find((s) => s.key === current.onRejectStepKey) : undefined;
    const target =
      configured ??
      steps.slice(0, index).reverse().find((s) => s.type === 'STAFF_TASK') ??
      // A finished execution always restarts at a preparation step, wherever its pointer was left.
      (execution.status === 'COMPLETED' ? [...steps].reverse().find((s) => s.type === 'STAFF_TASK') : undefined);
    if (!target) return; // the workflow has not reached preparation yet; the loop catches up by itself

    const now = this.clock.now();
    if (open) {
      await tx.workflowStepExecution.update({
        where: { id: open.id },
        data: {
          status: rejectedReview ? 'COMPLETED' : 'CANCELLED',
          completedAt: now,
          actorId: ctx().userId ?? null,
          result: { ...(open.result as object), blocked: null, outcome: rejectedReview ? 'REJECTED' : 'RETURNED_TO_PREPARATION', returnedFrom: from, goTo: target.key },
        },
      });
      await this.closeTasks(tx, request.id, current.key, 'CANCELLED');
    }
    await tx.workflowExecution.update({ where: { id: execution.id }, data: { status: 'ACTIVE', completedAt: null, currentStepKey: target.key } });
  }

  // =====================================================================================
  // Step handlers
  // =====================================================================================

  private async handle(tx: Tx, step: WorkflowStepDef, steps: WorkflowStepDef[], open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    switch (step.type) {
      case 'CUSTOMER_FORM':
        return (await this.guards.formValid(tx, request)) ? WAIT : { kind: 'COMPLETE' };
      case 'DOCUMENT_UPLOAD':
        return (await this.reader.checklist(tx, request.id)).uploaded ? { kind: 'COMPLETE' } : WAIT;
      case 'STAFF_VERIFICATION':
        return this.staffVerification(tx, step, request);
      case 'QUOTATION':
        return this.quotation(tx, step, open, request);
      case 'CUSTOMER_APPROVAL':
        return this.customerApproval(tx, step, steps, request);
      case 'PAYMENT':
        return this.payment(tx, step, steps, open, request);
      case 'STAFF_TASK':
        return this.staffTask(tx, step, open, request);
      case 'INTERNAL_APPROVAL':
        return this.internalApproval(tx, step, steps, open, request);
      case 'EXTERNAL_PROCESSING':
        return this.externalProcessing(tx, step, open, request);
      case 'NOTIFICATION':
        return this.notification(tx, step, request);
      case 'DOCUMENT_GENERATION':
        return this.documentGeneration(tx, step, request);
      case 'CONDITIONAL_BRANCH':
        return this.conditionalBranch(tx, step, request);
      case 'COMPLETION':
        return this.completion(tx, step, open, request);
      default:
        return { kind: 'FAIL', message: `Step type ${String(step.type)} is not supported by this version.`, optional: false };
    }
  }

  /** A system transition on behalf of a step. A refusal by the state machine is an answer, not an error. */
  private async attempt(tx: Tx, request: ServiceRequest, to: RequestStatus, step: WorkflowStepDef, options: Omit<TransitionOptions, 'actor'> = {}): Promise<Attempt> {
    try {
      const result = await this.machine.transition(tx, request.id, to, { ...options, actor: { kind: 'ENGINE', stepKey: step.key } });
      return { ok: true, request: result.request };
    } catch (e) {
      if (e instanceof AppError && e.getStatus() >= 400 && e.getStatus() < 500) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }
  private static blockedBy(a: Attempt): Outcome {
    return a.ok ? WAIT : { kind: 'WAIT', blocked: { code: a.code, message: a.message } };
  }

  /** SUBMITTED -> UNDER_REVIEW when staff work begins. */
  private async beginReview(tx: Tx, request: ServiceRequest, step: WorkflowStepDef): Promise<ServiceRequest> {
    if (request.status !== 'SUBMITTED') return request;
    const moved = await this.attempt(tx, request, 'UNDER_REVIEW', step);
    return moved.ok ? moved.request : request;
  }

  private async staffVerification(tx: Tx, step: WorkflowStepDef, request: ServiceRequest): Promise<Outcome> {
    request = await this.beginReview(tx, request, step);
    const checklist = await this.reader.checklist(tx, request.id);
    if (checklist.rejected.length && request.status === 'UNDER_REVIEW') {
      const list = checklist.rejected.map((l) => (l.rejectionReason ? `${l.label} (${l.rejectionReason})` : l.label)).join(', ');
      const asked = await this.attempt(tx, request, 'AWAITING_CUSTOMER', step, {
        reason: `Documents rejected: ${list}`,
        customerMessage: `Please replace the following document${checklist.rejected.length > 1 ? 's' : ''}: ${list}.`,
        customerVisible: true,
        meta: { automatic: true, rejectedItemIds: checklist.rejected.map((l) => l.id) },
      });
      return WorkflowEngine.blockedBy(asked);
    }
    return checklist.verified && request.status !== 'SUBMITTED' ? { kind: 'COMPLETE' } : WAIT;
  }

  private async quotation(tx: Tx, step: WorkflowStepDef, open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    // Staff released the request for processing without a quotation: the step is overtaken.
    if (RELEASED.includes(request.status)) return { kind: 'SKIP', result: { skipped: 'OVERTAKEN' } };
    request = await this.beginReview(tx, request, step);
    const quotation = await this.reader.currentQuotation(tx, request.id);
    if (quotation && ['SENT', 'APPROVED'].includes(quotation.status)) {
      if (request.status === 'UNDER_REVIEW') {
        const quoted = await this.attempt(tx, request, 'QUOTED', step, { meta: { quotationId: quotation.id } });
        if (!quoted.ok) return WorkflowEngine.blockedBy(quoted);
      }
      return { kind: 'COMPLETE', result: { quotationId: quotation.id } };
    }
    await this.ensureTask(tx, request, step, open, 'Prepare quotation', 'Prepare the quotation and send it to the customer.');
    return WAIT;
  }

  private async customerApproval(tx: Tx, step: WorkflowStepDef, steps: WorkflowStepDef[], request: ServiceRequest): Promise<Outcome> {
    if (RELEASED.includes(request.status)) return { kind: 'SKIP', result: { skipped: 'OVERTAKEN' } };
    const quotation = await this.reader.currentQuotation(tx, request.id);
    if (quotation?.status === 'APPROVED') return { kind: 'COMPLETE', result: { quotationId: quotation.id } };
    if (quotation?.status === 'SENT') {
      if (request.status === 'UNDER_REVIEW') await this.attempt(tx, request, 'QUOTED', step, { meta: { quotationId: quotation.id } });
      return WAIT;
    }
    // Rejected, expired or withdrawn: back to the quotation step for a revised offer.
    const index = steps.indexOf(step);
    const target = steps.find((s) => s.key === step.onRejectStepKey) ?? steps.slice(0, index).reverse().find((s) => s.type === 'QUOTATION');
    if (!target) return WAIT;
    const outcome = quotation?.status ?? 'WITHDRAWN';
    if (request.status === 'QUOTED') {
      await this.attempt(tx, request, 'UNDER_REVIEW', step, {
        reason: outcome === 'REJECTED' ? `Quotation rejected${quotation?.rejectionReason ? `: ${quotation.rejectionReason}` : ''}` : `Quotation ${outcome.toLowerCase()}`,
        customerMessage: 'We are revising your quotation.',
        customerVisible: true,
        meta: { quotationId: quotation?.id ?? null },
      });
    }
    return { kind: 'GOTO', stepKey: target.key, result: { quotationId: quotation?.id ?? null, outcome } };
  }

  /** Release for processing; falls back to "awaiting payment" when only the payment is missing. */
  private async release(tx: Tx, request: ServiceRequest, step: WorkflowStepDef): Promise<Attempt> {
    request = await this.beginReview(tx, request, step);
    const released = await this.attempt(tx, request, 'READY_FOR_PROCESSING', step);
    if (!released.ok && released.code === 'PAYMENT_REQUIRED' && request.status === 'QUOTED') await this.attempt(tx, request, 'AWAITING_PAYMENT', step);
    return released;
  }

  private async payment(tx: Tx, step: WorkflowStepDef, steps: WorkflowStepDef[], open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    const beforeProcessing = BEFORE_PROCESSING.includes(request.status) || request.status === 'READY_FOR_PROCESSING';
    if (request.status === 'QUOTED' || request.status === 'AWAITING_PAYMENT') {
      // The approved quotation was replaced by a revised one: the customer decides again before anything is paid.
      const quotation = await this.reader.currentQuotation(tx, request.id);
      const back = steps.slice(0, steps.indexOf(step)).reverse().find((s) => s.type === 'CUSTOMER_APPROVAL');
      if (quotation && quotation.status !== 'APPROVED' && back) {
        if (request.status === 'AWAITING_PAYMENT') {
          await this.attempt(tx, request, 'QUOTED', step, { reason: 'Quotation revised', customerMessage: 'Your quotation was revised. Please review it.', customerVisible: true, meta: { quotationId: quotation.id } });
        }
        return { kind: 'GOTO', stepKey: back.key, result: { quotationId: quotation.id, outcome: 'QUOTATION_REVISED' } };
      }
    }
    const payment = await this.reader.payment(tx, request, beforeProcessing ? 'PROCESSING' : 'COMPLETION');
    const figures = { basis: payment.basis, required: payment.required.toFixed(2), outstanding: payment.outstanding.toFixed(2) };
    if (payment.satisfied) {
      // Then the request is released, if nothing else (documents) holds it back; the next staff task retries otherwise.
      if (BEFORE_PROCESSING.includes(request.status)) await this.release(tx, request, step);
      return ['CORPORATE_CREDIT', 'NOT_DUE_YET', 'NOTHING_CHARGED'].includes(payment.basis) ? { kind: 'SKIP', result: { skipped: payment.basis, ...figures } } : { kind: 'COMPLETE', result: figures };
    }
    if (request.status === 'QUOTED') await this.attempt(tx, request, 'AWAITING_PAYMENT', step);
    if (step.assigneeRoleKey) await this.ensureTask(tx, request, step, open, 'Collect payment', `Outstanding: ${figures.outstanding}.`);
    return { kind: 'WAIT', blocked: { code: beforeProcessing ? 'PAYMENT_REQUIRED' : 'PAYMENT_INCOMPLETE', message: `Waiting for payment (${figures.outstanding} outstanding).` } };
  }

  private async staffTask(tx: Tx, step: WorkflowStepDef, open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    if ((open.result as Record<string, unknown> | null)?.completedManually) return { kind: 'COMPLETE' };
    if (BEFORE_PROCESSING.includes(request.status)) {
      const released = await this.release(tx, request, step);
      if (!released.ok) return WorkflowEngine.blockedBy(released);
      request = released.request;
    }
    if (request.status === 'READY_FOR_PROCESSING' || request.status === 'IN_PREPARATION') {
      await this.ensureTask(tx, request, step, open, step.name, 'Prepare the application. When it is ready, send it for review or mark the preparation as done.');
      return WAIT;
    }
    return AFTER_PREPARATION.includes(request.status) ? { kind: 'COMPLETE' } : WAIT;
  }

  private async internalApproval(tx: Tx, step: WorkflowStepDef, steps: WorkflowStepDef[], open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    const tenantId = this.db.tenantId;
    const bound = (open.result as Record<string, any> | null)?.approvalId as string | undefined;
    if (!bound) {
      if (request.status === 'IN_PREPARATION') {
        const sent = await this.attempt(tx, request, 'PENDING_APPROVAL', step);
        if (!sent.ok) return WorkflowEngine.blockedBy(sent);
        request = sent.request;
      }
      if (['READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED', 'FINAL_REVIEW'].includes(request.status)) {
        // The case was reviewed before the workflow reached this step (for example after a migration).
        const { approved } = await this.reader.review(tx, request.id);
        return approved ? { kind: 'COMPLETE', result: { outcome: 'APPROVED', approvalId: approved.id } } : WAIT;
      }
      if (request.status !== 'PENDING_APPROVAL') return WAIT;
      // The state machine created the pending review when the request entered PENDING_APPROVAL.
      const pending = await tx.requestApproval.findFirst({ where: { tenantId, requestId: request.id, type: 'REVIEW', status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
      if (!pending) return WAIT;
      await tx.requestApproval.update({ where: { id: pending.id }, data: { stepKey: step.key } });
      await tx.workflowStepExecution.update({ where: { id: open.id }, data: { result: { ...(open.result as object), approvalId: pending.id } } });
      await this.ensureTask(tx, request, step, open, 'Review the prepared application', 'Check the prepared application and approve it or send it back with a comment.');
      return WAIT;
    }
    const approval = await tx.requestApproval.findFirst({ where: { id: bound, tenantId } });
    if (approval?.status === 'APPROVED' && request.status !== 'PENDING_APPROVAL') return { kind: 'COMPLETE', result: { outcome: 'APPROVED' } };
    if (approval?.status === 'REJECTED' && request.status !== 'PENDING_APPROVAL') {
      const index = steps.indexOf(step);
      const target = steps.find((s) => s.key === step.onRejectStepKey) ?? steps.slice(0, index).reverse().find((s) => s.type === 'STAFF_TASK');
      if (target) return { kind: 'GOTO', stepKey: target.key, result: { outcome: 'REJECTED' } };
    }
    return WAIT;
  }

  private async externalProcessing(tx: Tx, step: WorkflowStepDef, open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    if (request.status === 'IN_PREPARATION') {
      const ready = await this.attempt(tx, request, 'READY_TO_SUBMIT', step);
      if (!ready.ok) return WorkflowEngine.blockedBy(ready);
      request = ready.request;
    }
    if (request.status === 'READY_TO_SUBMIT') {
      await this.ensureTask(tx, request, step, open, 'Submit application and record the reference', 'Submit through a permitted channel, then record the channel and the reference number on the request.');
      return WAIT;
    }
    // Submitted: the "submit" task is done, the step now waits for the result.
    if (request.status === 'EXTERNAL_PROCESSING') await this.closeTasks(tx, request.id, step.key, 'DONE', ['WORKFLOW']);
    return request.status === 'FINAL_REVIEW' ? { kind: 'COMPLETE', result: { outcome: 'COMPLETED' } } : WAIT;
  }

  private async completion(tx: Tx, step: WorkflowStepDef, open: WorkflowStepExecution, request: ServiceRequest): Promise<Outcome> {
    if (request.status === 'IN_PREPARATION' || request.status === 'READY_TO_SUBMIT') {
      const moved = await this.attempt(tx, request, 'FINAL_REVIEW', step);
      if (!moved.ok) return WorkflowEngine.blockedBy(moved);
      request = moved.request;
    }
    if (request.status === 'FINAL_REVIEW') {
      await this.ensureTask(tx, request, step, open, 'Final review', 'Check the completed documents and the payment, then complete the request.');
    }
    // The step ends when the request is completed (handled at the top of the loop).
    return WAIT;
  }

  private async notification(tx: Tx, step: WorkflowStepDef, request: ServiceRequest): Promise<Outcome> {
    const config = (step.config ?? {}) as Record<string, unknown>;
    const message = typeof config.message === 'string' && config.message.trim() ? config.message.trim().slice(0, 500) : step.name;
    const customerVisible = step.customerVisible !== false;
    await this.machine.note(tx, request.id, { customerMessage: message, customerVisible, meta: { stepKey: step.key } });
    // Informational: the status itself is unchanged (from === to).
    await this.events.emit(tx, 'request.status_changed', {
      requestId: request.id, customerId: request.customerId, requestNo: request.requestNo, from: request.status, to: request.status, customerVisible, customerMessage: message, informational: true, stepKey: step.key,
    });
    return { kind: 'COMPLETE', result: { message } };
  }

  private async conditionalBranch(tx: Tx, step: WorkflowStepDef, request: ServiceRequest): Promise<Outcome> {
    const facts = await this.reader.facts(tx, request);
    const matched = (step.branches ?? []).findIndex((b) => evaluateRule(b.when, facts));
    if (matched >= 0) return { kind: 'GOTO', stepKey: step.branches![matched].goTo, result: { matchedBranch: matched + 1 } };
    return { kind: 'COMPLETE', result: { matchedBranch: null } };
  }

  private async documentGeneration(tx: Tx, step: WorkflowStepDef, request: ServiceRequest): Promise<Outcome> {
    const config = (step.config ?? {}) as Record<string, unknown>;
    const optional = config.optional === true;
    if (!this.documentStore) {
      return { kind: 'FAIL', optional, message: 'The document could not be generated: document storage is not available in this installation (the documents module is not loaded).' };
    }
    const tenantId = this.db.tenantId;
    const name = `wf_${++this.savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
    try {
      const [tenant, customer, schema, values, checklist] = await Promise.all([
        tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true } }),
        tx.customer.findFirstOrThrow({ where: { id: request.customerId, tenantId }, select: { fullName: true } }),
        this.reader.formSchema(tx, request.formDefinitionId),
        this.reader.fieldValues(tx, request.id),
        this.reader.checklist(tx, request.id),
      ]);
      const snapshot = await this.reader.snapshot(tx, request);
      const content = await buildRequestSummaryPdf({
        centreName: tenant.name,
        requestNo: request.requestNo,
        serviceName: snapshot.name,
        customerName: customer.fullName,
        statusLabel: REQUEST_STATUS_META[request.status].en,
        submittedAt: request.submittedAt,
        targetDate: request.targetDate,
        generatedAt: this.clock.now(),
        instructions: request.customerInstructions,
        // Fields marked sensitive are left out of generated summaries.
        fields: formFieldsOf(schema).filter((f) => !f.sensitive && values[f.key] !== undefined && values[f.key] !== null).map((f) => ({ label: f.label, value: Array.isArray(values[f.key]) ? (values[f.key] as unknown[]).join(', ') : String(values[f.key]) })),
        checklist: checklist.lines.filter((l) => l.kind === 'INPUT').map((l) => ({ label: l.label, status: l.status })),
      });
      const stored = await this.documentStore.storeGenerated({
        customerId: request.customerId,
        corporateAccountId: request.corporateAccountId,
        requestId: request.id,
        documentTypeKey: typeof config.documentTypeKey === 'string' ? config.documentTypeKey : 'other',
        title: typeof config.title === 'string' && config.title.trim() ? config.title.trim().slice(0, 160) : `Request summary ${request.requestNo}`,
        filename: `${request.requestNo}-summary.pdf`,
        mime: 'application/pdf',
        content,
        isCompletionDocument: false,
        customerVisible: config.customerVisible === true,
      });
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
      return { kind: 'COMPLETE', result: { documentId: stored.documentId, versionId: stored.versionId, message: null } };
    } catch (e: any) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      this.logger.warn(`document generation failed for ${request.requestNo}: ${e?.message ?? e}`);
      return { kind: 'FAIL', optional, message: `The document could not be generated: ${String(e?.message ?? e).slice(0, 300)}` };
    }
  }

  // =====================================================================================
  // Workflow tasks
  // =====================================================================================

  private async ensureTask(tx: Tx, request: ServiceRequest, step: WorkflowStepDef, open: WorkflowStepExecution, title: string, description: string): Promise<void> {
    const tenantId = this.db.tenantId;
    const existing = await tx.task.findFirst({ where: { tenantId, requestId: request.id, source: 'WORKFLOW', stepKey: step.key, status: { in: ['OPEN', 'IN_PROGRESS'] } }, select: { id: true } });
    if (existing) return;
    const audience = TASK_AUDIENCE[step.type] ?? 'ROLE';
    const now = this.clock.now();
    const task = await tx.task.create({
      data: {
        tenantId,
        branchId: request.branchId,
        requestId: request.id,
        customerId: request.customerId,
        title: `${title} - ${request.requestNo}`,
        description,
        type: audience === 'REVIEWER' ? 'APPROVAL' : 'WORKFLOW_STEP',
        priority: request.priority,
        status: 'OPEN',
        source: 'WORKFLOW',
        stepKey: step.key,
        roleKey: step.assigneeRoleKey ?? (audience === 'REVIEWER' ? 'reviewer' : audience === 'OPERATOR' ? 'operator' : null),
        dueAt: open.dueAt,
        createdById: ctx().userId ?? null,
        createdAt: now,
      },
    });
    const assignee = audience === 'OPERATOR' ? request.assignedToId : audience === 'REVIEWER' ? request.reviewerId : null;
    if (assignee) await tx.taskAssignment.create({ data: { tenantId, taskId: task.id, assigneeId: assignee, assignedById: ctx().userId ?? null, assignedAt: now } });
  }

  private async closeTasks(tx: Tx, requestId: string, stepKey: string, status: 'DONE' | 'CANCELLED', sources: string[] = ['WORKFLOW', 'ESCALATION']): Promise<void> {
    const now = this.clock.now();
    await tx.task.updateMany({
      where: { tenantId: this.db.tenantId, requestId, stepKey, source: { in: sources }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      data: { status, completedAt: now, completedById: status === 'DONE' ? (ctx().userId ?? null) : null },
    });
  }

  // =====================================================================================
  // Timeouts and escalation (job workflows.scan)
  // =====================================================================================

  /**
   * One tenant. Idempotent: each overdue step and each overdue request is escalated exactly once,
   * and a request whose quotation lapsed goes back for a revised offer exactly once.
   */
  async scanTenant(): Promise<{ stepsEscalated: number; requestsOverdue: number; quotationsLapsed: number }> {
    const tenantId = this.db.tenantId;
    const now = this.clock.now();
    let stepsEscalated = 0;
    let requestsOverdue = 0;
    let quotationsLapsed = 0;

    // Finance marks a quotation past its validity date EXPIRED without announcing it (there is no
    // event for it), so the waiting customer-approval step is re-evaluated here: QUOTED -> UNDER_REVIEW
    // and a new quotation task, exactly as after a rejection.
    const lapsed = await this.db.tx((tx) =>
      tx.serviceRequest.findMany({
        where: { tenantId, deletedAt: null, status: 'QUOTED', quotations: { some: { status: 'EXPIRED' } } },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: 500,
      }),
    );
    for (const { id } of lapsed) {
      const moved = await this.db.tx(async (tx) => {
        const request = await this.machine.lock(tx, id);
        if (request.status !== 'QUOTED') return false;
        // Only when the CURRENT quotation lapsed: an older expired one next to a newer offer changes nothing.
        if ((await this.reader.currentQuotation(tx, id))?.status !== 'EXPIRED') return false;
        await this.advance(tx, id);
        return (await this.machine.lock(tx, id)).status !== 'QUOTED';
      });
      if (moved) quotationsLapsed += 1;
    }

    const dueSteps = await this.db.tx((tx) =>
      tx.workflowStepExecution.findMany({
        where: { tenantId, status: 'ACTIVE', dueAt: { lt: now }, escalatedAt: null, execution: { status: 'ACTIVE' } },
        select: { id: true },
        orderBy: { dueAt: 'asc' },
        take: 500,
      }),
    );
    for (const due of dueSteps) {
      const escalated = await this.db.tx(async (tx) => {
        // Claim the row: a concurrent scan (or a second run) finds nothing to do.
        const claimed = await tx.workflowStepExecution.updateMany({ where: { id: due.id, tenantId, status: 'ACTIVE', escalatedAt: null }, data: { escalatedAt: now } });
        if (!claimed.count) return false;
        const row = await tx.workflowStepExecution.findFirstOrThrow({ where: { id: due.id }, include: { execution: { select: { requestId: true, versionId: true } } } });
        const request = await tx.serviceRequest.findFirstOrThrow({ where: { id: row.execution.requestId, tenantId } });
        const step = (await this.workflows.stepsOf(tx, row.execution.versionId)).find((s) => s.key === row.stepKey);
        const roleKey = step?.escalateToRoleKey ?? 'manager';
        await tx.task.create({
          data: {
            tenantId, branchId: request.branchId, requestId: request.id, customerId: request.customerId,
            title: `Overdue step: ${row.stepName} - ${request.requestNo}`,
            description: `The step "${row.stepName}" was due on ${row.dueAt!.toISOString()} and is still open.`,
            type: 'ESCALATION', priority: 'HIGH', status: 'OPEN', source: 'ESCALATION', stepKey: row.stepKey, roleKey, createdAt: now,
          },
        });
        await this.events.emit(tx, 'request.step_overdue', { requestId: request.id, customerId: request.customerId, requestNo: request.requestNo, stepKey: row.stepKey, stepName: row.stepName, escalateToRoleKey: roleKey });
        return true;
      });
      if (escalated) stepsEscalated += 1;
    }

    const late = await this.db.tx((tx) =>
      tx.serviceRequest.findMany({
        where: { tenantId, deletedAt: null, status: { in: OPEN_STATUSES.filter((s) => s !== 'DRAFT') }, targetDate: { lt: now } },
        select: { id: true },
        orderBy: { targetDate: 'asc' },
        take: 500,
      }),
    );
    for (const { id } of late) {
      const flagged = await this.db.tx(async (tx) => {
        const request = await this.machine.lock(tx, id);
        if (!request.targetDate || request.targetDate >= now || !OPEN_STATUSES.includes(request.status) || request.status === 'DRAFT') return false;
        // The marker is valid for the target date it was created after: moving the date re-arms it.
        const marker = await tx.task.findFirst({ where: { tenantId, requestId: id, source: 'ESCALATION', stepKey: OVERDUE_MARKER, createdAt: { gte: request.targetDate } }, select: { id: true } });
        if (marker) return false;
        const assignee = request.assignedToId ? await tx.tenantMembership.findFirst({ where: { id: request.assignedToId, tenantId }, select: { userId: true } }) : null;
        await tx.task.create({
          data: {
            tenantId, branchId: request.branchId, requestId: id, customerId: request.customerId,
            title: `Overdue request - ${request.requestNo}`,
            description: `The target date ${request.targetDate.toISOString()} has passed and the request is still open (${REQUEST_STATUS_META[request.status].en}).`,
            type: 'ESCALATION', priority: 'HIGH', status: 'OPEN', source: 'ESCALATION', stepKey: OVERDUE_MARKER, roleKey: 'manager', createdAt: now,
          },
        });
        await this.events.emit(tx, 'request.overdue', { requestId: id, customerId: request.customerId, requestNo: request.requestNo, ...(assignee ? { assigneeUserId: assignee.userId } : {}) });
        return true;
      });
      if (flagged) requestsOverdue += 1;
    }
    return { stepsEscalated, requestsOverdue, quotationsLapsed };
  }
}
