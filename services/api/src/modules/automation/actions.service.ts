import { Injectable, Optional } from '@nestjs/common';
import { AUTOMATION_ACTIONS, REQUEST_STATUS_META } from '@typease/types';
import type { AutomationActionType, RequestStatus } from '@typease/types';
import type { AutomationAction, AutomationActionConfig } from '@typease/validation';
import { env } from '../../config/env';
import { decryptJson } from '../../common/crypto';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError } from '../../common/errors';
import { DocumentStorePort } from '../../common/ports';
import { NotificationService, Recipient } from '../notifications/notification.service';
import { renderText } from '../notifications/render';
import { RemindersService } from '../reminders/reminders.service';
import { addDays, localYmd, safeTimeZone } from '../reports/time';
import { AssignmentService } from '../requests/assignment.service';
import { formFieldsOf } from '../requests/form-validator';
import { RequestReader } from '../requests/request-reader.service';
import { AS_SYSTEM, RequestStateMachine } from '../requests/request-state-machine.service';
import { buildRequestSummaryPdf } from '../requests/summary-pdf';
import { WorkflowEngine } from '../requests/workflow-engine.service';
import { TasksService } from '../tasks/tasks.service';
import type { EventContext } from './event-context.service';
import { checkUrl, DestinationPolicy, destinationOf, postSigned, resolvePinned, safeEventData, WebhookFailed, WebhookRefused } from './webhook';

/** An action that did not do its job. `retryable` decides between another attempt and the dead-letter list. */
export class ActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}
export interface ActionOutcome {
  /** SKIPPED: there was nothing to act on (e.g. the event has no request). Counts as done. */
  status: 'SUCCEEDED' | 'SKIPPED';
  output: Record<string, unknown>;
}
export interface ActionRun {
  executionId: string;
  index: number;
  ruleId: string;
  ruleName: string;
}

const done = (output: Record<string, unknown> = {}): ActionOutcome => ({ status: 'SUCCEEDED', output });
const skipped = (reason: string): ActionOutcome => ({ status: 'SKIPPED', output: { reason } });
const NO_REQUEST = 'The event does not belong to a request.';

/** Business refusals that may be different a moment later. Everything else with a 4xx status is final. */
const RETRYABLE_CODES = new Set(['CONCURRENT_UPDATE', 'STALE_VERSION', 'NO_ASSIGNEE_AVAILABLE', 'RATE_LIMITED', 'INTEGRATION_NOT_CONFIGURED']);

/** Turns whatever an action threw into a code, a message for the execution log, and the retry decision. */
export function classify(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof ActionError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof WebhookRefused) return { code: error.code, message: error.message, retryable: false };
  if (error instanceof WebhookFailed) return { code: error.status ? `WEBHOOK_HTTP_${error.status}` : 'WEBHOOK_UNREACHABLE', message: error.message, retryable: error.retryable };
  if (error instanceof AppError) {
    const status = error.getStatus();
    return { code: error.code, message: error.message, retryable: status >= 500 || status === 429 || RETRYABLE_CODES.has(error.code) };
  }
  // Database hiccups, serialisation failures, bugs: try again, the retry budget bounds it.
  const message = String((error as any)?.message ?? error).replace(/\s+/g, ' ').slice(0, 300);
  return { code: 'UNEXPECTED_ERROR', message: message || 'Unexpected error', retryable: true };
}

export const isExternalAction = (type: AutomationActionType) => type === 'call_webhook';

/**
 * The ten automation actions. None of them writes another module's tables:
 * each calls the service of the module that owns the data, so every rule of
 * that module (state machine and its guards, consent, plan limits, audit)
 * applies to automations exactly as it applies to people.
 */
@Injectable()
export class AutomationActions {
  private savepoints = 0;

  constructor(
    private readonly db: TenantDb,
    private readonly tasks: TasksService,
    private readonly assignment: AssignmentService,
    private readonly machine: RequestStateMachine,
    private readonly engine: WorkflowEngine,
    private readonly reader: RequestReader,
    private readonly reminders: RemindersService,
    private readonly notifications: NotificationService,
    @Optional() private readonly documentStore?: DocumentStorePort,
  ) {}

  /** Runs one transactional action. The caller records the outcome in the same transaction. */
  async run(tx: Tx, action: AutomationAction, c: EventContext, run: ActionRun): Promise<ActionOutcome> {
    switch (action.type) {
      case 'create_task':
        return this.createTask(tx, action.config, c);
      case 'create_follow_up':
        return this.createFollowUp(tx, action.config, c);
      case 'assign_staff':
        return this.assignStaff(action.config, c);
      case 'send_notification':
        return this.sendNotification(tx, action.config, c, run);
      case 'schedule_reminder':
        return this.scheduleReminder(action.config, c);
      case 'generate_document':
        return this.generateDocument(tx, action.config, c);
      case 'update_workflow_state':
        return this.updateWorkflowState(tx, action.config, c, run);
      case 'request_approval':
        return this.requestApproval(tx, action.config, c);
      case 'escalate':
        return this.escalate(tx, action.config, c, run);
      case 'call_webhook':
        throw new ActionError('INTERNAL', 'Webhooks are sent outside database transactions.', false);
      default:
        throw new ActionError('UNKNOWN_ACTION', `"${String((action as any).type)}" is not an action this version knows.`, false);
    }
  }

  // ------------------------------------------------------------------ helpers
  private text(template: string | undefined | null, c: EventContext, max: number): string {
    return renderText(template ?? '', c.variables).slice(0, max);
  }
  private async assertRole(tx: Tx, roleKey: string | null | undefined): Promise<string | null> {
    if (!roleKey) return null;
    const role = await tx.role.findFirst({ where: { tenantId: this.db.tenantId, key: roleKey, kind: 'STAFF' }, select: { name: true } });
    if (!role) throw new ActionError('UNKNOWN_ROLE', `The role "${roleKey}" no longer exists in your centre. Edit the automation and choose another role.`, false);
    return role.name;
  }
  /** Active staff holding a role; for a request only those who work at its branch. */
  private async roleHolders(tx: Tx, roleKey: string, branchId: string | null): Promise<string[]> {
    const tenantId = this.db.tenantId;
    const members = await tx.tenantMembership.findMany({
      where: {
        tenantId, kind: 'STAFF', status: 'ACTIVE', role: { key: roleKey, tenantId },
        ...(branchId ? { OR: [{ allBranches: true }, { membershipBranches: { some: { branchId } } }] } : {}),
      },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return [...new Set(members.map((m) => m.userId))];
  }
  private related(c: EventContext): { type: string; id: string } | null {
    if (c.request) return { type: 'ServiceRequest', id: c.request.id };
    if (c.customerId) return { type: 'Customer', id: c.customerId };
    return null;
  }

  // ------------------------------------------------------------------ tasks
  private async createTask(tx: Tx, config: AutomationActionConfig['create_task'], c: EventContext): Promise<ActionOutcome> {
    await this.assertRole(tx, config.roleKey);
    const title = this.text(config.title, c, 160) || 'Task created by an automation';
    const taskId = await this.tasks.createSystemTask(tx, {
      title,
      description: config.description ? this.text(config.description, c, 1000) : null,
      type: config.type,
      source: 'AUTOMATION',
      priority: config.priority,
      roleKey: config.roleKey ?? null,
      branchId: c.branchId,
      requestId: c.request?.id ?? null,
      customerId: c.customerId,
      dueAt: config.dueInHours ? new Date(Date.now() + config.dueInHours * 3_600_000) : null,
    });
    return done({ taskId, title });
  }

  private async createFollowUp(tx: Tx, config: AutomationActionConfig['create_follow_up'], c: EventContext): Promise<ActionOutcome> {
    await this.assertRole(tx, config.roleKey);
    const title = this.text(config.title, c, 160) || 'Follow up';
    const dueAt = new Date(Date.now() + config.dueInDays * 86_400_000);
    const taskId = await this.tasks.createSystemTask(tx, {
      title,
      description: config.description ? this.text(config.description, c, 1000) : null,
      type: 'FOLLOW_UP',
      source: 'AUTOMATION',
      priority: config.priority,
      roleKey: config.roleKey ?? null,
      branchId: c.branchId,
      requestId: c.request?.id ?? null,
      customerId: c.customerId,
      dueAt,
    });
    return done({ taskId, title, dueAt: dueAt.toISOString() });
  }

  // ------------------------------------------------------------------ assignment
  private async assignStaff(config: AutomationActionConfig['assign_staff'], c: EventContext): Promise<ActionOutcome> {
    const request = c.request;
    if (!request) return skipped(NO_REQUEST);
    const role = config.mode === 'MEMBER' ? config.role : 'OPERATOR';
    const current = role === 'OPERATOR' ? request.assignedToId : request.reviewerId;
    // An automation fills an empty seat; it never takes a case away from the person who has it.
    if (current) return skipped(`The request already has ${role === 'OPERATOR' ? 'an operator' : 'a reviewer'}.`);
    try {
      if (config.mode === 'AUTO') {
        const result = await this.assignment.autoAssign(request.id);
        return done({ assigneeMembershipId: result.autoAssignment.chosen.membershipId, role, method: 'AUTO', considered: result.autoAssignment.considered });
      }
      await this.assignment.assign(request.id, { assigneeMembershipId: config.membershipId, role: config.role });
      return done({ assigneeMembershipId: config.membershipId, role, method: 'MANUAL' });
    } catch (e) {
      if (e instanceof AppError && e.code === 'ALREADY_ASSIGNED') return skipped(e.message);
      throw e;
    }
  }

  // ------------------------------------------------------------------ notifications
  private async sendNotification(tx: Tx, config: AutomationActionConfig['send_notification'], c: EventContext, run: ActionRun): Promise<ActionOutcome> {
    let recipients: Recipient[];
    if (config.to === 'CUSTOMER') {
      if (!c.customerId) return skipped('The event does not belong to a customer.');
      recipients = [{ kind: 'CUSTOMER', customerId: c.customerId }];
    } else if (config.to === 'ASSIGNEE') {
      if (!c.assignee) return skipped('The request has no operator to notify.');
      recipients = [{ kind: 'USER', userId: c.assignee.userId }];
    } else {
      await this.assertRole(tx, config.roleKey);
      const holders = await this.roleHolders(tx, config.roleKey!, c.request ? c.branchId : null);
      if (!holders.length) return skipped(`Nobody active holds the role "${config.roleKey}"${c.request ? ' at the branch of the request' : ''}.`);
      recipients = holders.map((userId) => ({ kind: 'USER', userId }));
    }
    const counts = { queued: 0, delivered: 0, suppressed: 0 };
    const suppressedReasons = new Set<string>();
    for (const recipient of recipients) {
      // The notifications module decides: consent, opt-out, rate limit and plan limit apply, and every outcome is logged there.
      const created = await this.notifications.sendCustom({
        dedupeId: `automation:${run.executionId}:${run.index}`,
        recipient,
        channels: config.channels,
        subject: config.subject ?? null,
        body: config.body,
        data: c.variables,
        purpose: config.purpose,
        whatsappTemplateName: config.whatsappTemplateName ?? null,
        related: this.related(c),
      });
      for (const n of created) {
        if (n.status === 'QUEUED') counts.queued += 1;
        else if (n.status === 'SENT') counts.delivered += 1;
        else {
          counts.suppressed += 1;
          if (n.suppressedReason) suppressedReasons.add(n.suppressedReason);
        }
      }
    }
    return done({ to: config.to, recipients: recipients.length, ...counts, ...(suppressedReasons.size ? { suppressedReasons: [...suppressedReasons] } : {}) });
  }

  // ------------------------------------------------------------------ reminders
  private async scheduleReminder(config: AutomationActionConfig['schedule_reminder'], c: EventContext): Promise<ActionOutcome> {
    if (!c.customerId && !c.corporateAccountId) return skipped('The event does not belong to a customer or a company.');
    const documentTypeKey = config.documentTypeKey ?? c.document?.typeKey;
    if (!documentTypeKey) throw new ActionError('NO_DOCUMENT_TYPE', 'The automation does not say which document the reminder is for, and the event has no document.', false);
    const sameDocument = !!c.document && c.document.typeKey === documentTypeKey;
    const today = localYmd(new Date(), safeTimeZone(c.tenant.timezone));
    const expiryDate = (sameDocument ? c.document!.expiryDate : null) ?? (config.expiryInDays ? addDays(today, config.expiryInDays) : null);
    if (!expiryDate) return skipped('No expiry date is known for the document, so there is nothing to remind about.');
    if (expiryDate < today) return skipped('The document has already expired.');
    try {
      const reminder = await this.reminders.create({
        ...(c.customerId ? { customerId: c.customerId } : { corporateAccountId: c.corporateAccountId! }),
        ...(sameDocument && c.document!.id ? { documentId: c.document!.id } : {}),
        documentTypeKey,
        ...(config.subjectLabel ? { subjectLabel: config.subjectLabel } : {}),
        expiryDate,
        ...(config.offsetsDays ? { offsetsDays: config.offsetsDays } : {}),
      });
      return done({ reminderId: reminder.id, documentTypeKey, expiryDate });
    } catch (e) {
      // The reminders module keeps one open reminder per document: an existing one is exactly what was asked for.
      if (e instanceof AppError && e.code === 'DUPLICATE_REMINDER') return done({ reminderId: (e.details as { id?: string } | undefined)?.id ?? null, documentTypeKey, expiryDate, alreadyScheduled: true });
      throw e;
    }
  }

  // ------------------------------------------------------------------ documents
  private async generateDocument(tx: Tx, config: AutomationActionConfig['generate_document'], c: EventContext): Promise<ActionOutcome> {
    const request = c.request;
    if (!request) return skipped(NO_REQUEST);
    if (!this.documentStore) throw new ActionError('DOCUMENT_STORAGE_UNAVAILABLE', 'Documents cannot be generated: document storage is not available in this installation.', false);
    const tenantId = this.db.tenantId;
    const [customer, schema, values, checklist, snapshot] = await Promise.all([
      tx.customer.findFirstOrThrow({ where: { id: request.customerId, tenantId }, select: { fullName: true } }),
      this.reader.formSchema(tx, request.formDefinitionId),
      this.reader.fieldValues(tx, request.id),
      this.reader.checklist(tx, request.id),
      this.reader.snapshot(tx, request),
    ]);
    const content = await buildRequestSummaryPdf({
      centreName: c.tenant.name,
      requestNo: request.requestNo,
      serviceName: snapshot.name,
      customerName: customer.fullName,
      statusLabel: REQUEST_STATUS_META[request.status].en,
      submittedAt: request.submittedAt,
      targetDate: request.targetDate,
      generatedAt: new Date(),
      instructions: request.customerInstructions,
      // Fields marked sensitive (identity numbers and the like) never appear in a generated summary.
      fields: formFieldsOf(schema)
        .filter((f) => !f.sensitive && values[f.key] !== undefined && values[f.key] !== null)
        .map((f) => ({ label: f.label, value: Array.isArray(values[f.key]) ? (values[f.key] as unknown[]).join(', ') : String(values[f.key]) })),
      checklist: checklist.lines.filter((l) => l.kind === 'INPUT').map((l) => ({ label: l.label, status: l.status })),
    });
    const title = (config.title ? this.text(config.title, c, 160) : '') || `Request summary ${request.requestNo}`;
    const stored = await this.documentStore.storeGenerated({
      customerId: request.customerId,
      corporateAccountId: request.corporateAccountId,
      requestId: request.id,
      documentTypeKey: config.documentTypeKey,
      title,
      filename: `${request.requestNo}-summary.pdf`,
      mime: 'application/pdf',
      content,
      isCompletionDocument: false,
      customerVisible: config.customerVisible,
    });
    return done({ documentId: stored.documentId, versionId: stored.versionId, title });
  }

  // ------------------------------------------------------------------ status
  /**
   * The ONLY way an automation changes a status: the state machine, with the
   * SYSTEM authority. That authority may use the edges marked `system: true`
   * and nothing else, and every guard of the edge is evaluated as for anyone.
   */
  private async updateWorkflowState(tx: Tx, config: AutomationActionConfig['update_workflow_state'], c: EventContext, run: ActionRun): Promise<ActionOutcome> {
    if (!c.request) return skipped(NO_REQUEST);
    const current = await this.machine.lock(tx, c.request.id);
    if (current.status === config.to) return done({ from: current.status, to: config.to, alreadyInStatus: true });
    const result = await this.machine.transition(tx, current.id, config.to as RequestStatus, {
      actor: AS_SYSTEM,
      reason: config.reason ?? `Automation "${run.ruleName}"`,
      customerMessage: config.customerMessage ?? null,
      meta: { automationRuleId: run.ruleId, automationExecutionId: run.executionId },
    });
    return done({ from: result.from, to: result.to });
  }

  /**
   * "Preparation is done, send it for review". The requests module decides what
   * that means: the workflow engine completes the preparation step and moves
   * the request on. If that does not end in a pending review (the workflow has
   * no review at this point, or a guard blocks it) everything is undone, so an
   * automation can never push a case past preparation without a review.
   */
  private async requestApproval(tx: Tx, config: AutomationActionConfig['request_approval'], c: EventContext): Promise<ActionOutcome> {
    if (!c.request) return skipped(NO_REQUEST);
    const tenantId = this.db.tenantId;
    const request = await this.machine.lock(tx, c.request.id);
    const pendingReview = () => tx.requestApproval.findFirst({ where: { tenantId, requestId: request.id, type: 'REVIEW', status: 'PENDING' }, select: { id: true } });
    if (request.status === 'PENDING_APPROVAL') {
      const pending = await pendingReview();
      if (pending) return done({ approvalId: pending.id, alreadyPending: true });
    }
    if (request.status !== 'IN_PREPARATION') {
      throw new ActionError('REQUEST_NOT_IN_PREPARATION', `A review can only be requested while the request is in preparation (it is ${REQUEST_STATUS_META[request.status].en.toLowerCase()}).`, false);
    }
    const name = `automation_${++this.savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
    let failure: ActionError | null = null;
    try {
      await this.engine.completeStaffTask(tx, request, { note: config.note ?? 'Sent for review by an automation' });
      const after = await tx.serviceRequest.findFirstOrThrow({ where: { id: request.id, tenantId }, select: { status: true } });
      const pending = after.status === 'PENDING_APPROVAL' ? await pendingReview() : null;
      if (pending) {
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
        return done({ approvalId: pending.id });
      }
      const blocked = await this.blockedReason(tx, request.id);
      failure = new ActionError(
        'REVIEW_NOT_REQUESTED',
        blocked ?? (after.status === 'IN_PREPARATION' ? 'The request could not be sent for review: a requirement of the next step is not met yet.' : 'The workflow of this service has no internal review after preparation, so the request was left as it is.'),
        false,
      );
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      if (e instanceof AppError && e.code === 'STEP_NOT_ACTIVE') throw new ActionError('STEP_NOT_ACTIVE', 'There is no preparation step waiting on this request, so a review cannot be requested for it.', false);
      throw e;
    }
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw failure;
  }
  /** Why the workflow is waiting, in the words of the guard that blocks it. */
  private async blockedReason(tx: Tx, requestId: string): Promise<string | null> {
    const execution = await tx.workflowExecution.findFirst({ where: { requestId, tenantId: this.db.tenantId }, select: { id: true, currentStepKey: true } });
    if (!execution?.currentStepKey) return null;
    const step = await tx.workflowStepExecution.findFirst({ where: { executionId: execution.id, stepKey: execution.currentStepKey }, orderBy: { createdAt: 'desc' }, select: { result: true } });
    const blocked = (step?.result as Record<string, any> | null)?.blocked;
    return typeof blocked?.message === 'string' ? `The request could not be sent for review: ${blocked.message}` : null;
  }

  // ------------------------------------------------------------------ escalation
  private async escalate(tx: Tx, config: AutomationActionConfig['escalate'], c: EventContext, run: ActionRun): Promise<ActionOutcome> {
    const roleName = await this.assertRole(tx, config.roleKey);
    const subject = c.request ? `${c.request.requestNo}` : eventWords(c.event.type);
    const title = (config.title ? this.text(config.title, c, 160) : '') || `Escalation: ${subject} needs attention`.slice(0, 160);
    const message = config.message ? this.text(config.message, c, 1000) : c.request ? `Request ${c.request.requestNo} was escalated to ${roleName} by the automation "${run.ruleName}".` : `Escalated to ${roleName} by the automation "${run.ruleName}".`;
    const taskId = await this.tasks.createSystemTask(tx, {
      title,
      description: message,
      type: 'ESCALATION',
      source: 'ESCALATION',
      priority: config.priority,
      roleKey: config.roleKey,
      branchId: c.branchId,
      requestId: c.request?.id ?? null,
      customerId: c.customerId,
      dueAt: config.dueInHours ? new Date(Date.now() + config.dueInHours * 3_600_000) : null,
    });
    const holders = await this.roleHolders(tx, config.roleKey, c.request ? c.branchId : null);
    let notified = 0;
    for (const userId of holders) {
      const created = await this.notifications.sendCustom({
        dedupeId: `automation:${run.executionId}:${run.index}`,
        recipient: { kind: 'USER', userId },
        channels: ['IN_APP'],
        subject: '{{title}}',
        body: '{{message}}\n\n[Open in TypEase]({{centreLink}})',
        data: { title, message, centreLink: c.variables.centreLink },
        related: this.related(c),
      });
      if (created.length) notified += 1;
    }
    return done({ taskId, roleKey: config.roleKey, notified });
  }

  // ------------------------------------------------------------------ webhook
  /** n8n connection of the centre (Integrations > n8n, switched on). The secret never leaves this function's caller. */
  async webhookConnection(tx: Tx): Promise<{ base: string | null; secret: string | null }> {
    const row = await tx.integration.findFirst({ where: { tenantId: this.db.tenantId, category: 'AUTOMATION', provider: 'n8n', status: 'ACTIVE' }, select: { config: true, secretsEnc: true } });
    if (!row) return { base: null, secret: null };
    const config = (row.config ?? {}) as Record<string, unknown>;
    const base = typeof config.webhookBaseUrl === 'string' && config.webhookBaseUrl.trim() ? config.webhookBaseUrl.trim() : null;
    let secret: string | null = null;
    if (row.secretsEnc) {
      try {
        const secrets = decryptJson<Record<string, unknown>>(row.secretsEnc) ?? {};
        if (typeof secrets.signingSecret === 'string' && secrets.signingSecret) secret = secrets.signingSecret;
      } catch {
        throw new ActionError('CREDENTIALS_UNREADABLE', 'The signing secret of your n8n connection could not be read. Enter it again under Integrations.', false);
      }
    }
    return { base, secret };
  }
  policy(tenantBase: string | null): DestinationPolicy {
    const e = env();
    return { allowedHosts: e.OUTBOUND_WEBHOOK_ALLOWED_HOSTS, tenantBase, platformBase: e.N8N_WEBHOOK_BASE_URL ?? null, production: e.NODE_ENV === 'production' };
  }

  /**
   * Sends the signed webhook. Runs OUTSIDE any database transaction (no
   * connection is held during network I/O); `connection` was read beforehand.
   */
  async callWebhook(config: AutomationActionConfig['call_webhook'], c: EventContext, run: ActionRun, connection: { base: string | null; secret: string | null }): Promise<ActionOutcome> {
    const policy = this.policy(connection.base);
    const checked = checkUrl(destinationOf(config, policy), policy);
    // The platform's own n8n is signed with the platform secret; everything else with the centre's secret when it has one.
    const secret = checked.trust === 'PLATFORM' ? env().N8N_WEBHOOK_SECRET : (connection.secret ?? env().N8N_WEBHOOK_SECRET);
    if (!secret) throw new WebhookRefused('NOT_CONFIGURED', 'No signing secret is configured for webhooks. Add your n8n connection (with its signing secret) under Integrations.');
    const pinned = await resolvePinned(checked, policy);
    const request = c.request ? { id: c.request.id, number: c.request.requestNo, status: c.request.status, priority: c.request.priority, serviceCode: (c.facts['service.code'] as string | null) ?? null, branchCode: (c.facts['branch.code'] as string | null) ?? null } : null;
    const body = JSON.stringify({
      event: c.event.type,
      tenantSlug: c.tenant.slug,
      occurredAt: c.event.createdAt.toISOString(),
      // Identifiers and non-sensitive values only: no names, no free text, no identity numbers, no document contents.
      data: { eventId: c.event.id, ...safeEventData(c.event.payload), ...(request ? { request } : {}) },
    });
    const response = await postSigned({ checked, pinned, body, secret, deliveryId: `${run.executionId}:${run.index}`, event: c.event.type });
    return done({ host: checked.hostname, path: checked.url.pathname, status: response.status });
  }
}

/** "request.step_overdue" -> "request step overdue": used in default titles of events without a request. */
function eventWords(type: string): string {
  return type.replace(/[._]/g, ' ');
}

export const actionLabel = (type: string) => (AUTOMATION_ACTIONS as Record<string, string>)[type] ?? type;
