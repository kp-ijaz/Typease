import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AUTOMATION_TRIGGERS } from '@typease/types';
import type { AutomationActionType, Rule } from '@typease/types';
import type { AutomationAction, AutomationActionConfig } from '@typease/validation';
import type { AutomationExecution, AutomationRule } from '@typease/database';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvent, DomainEvents } from '../../common/events.service';
import { JobQueue } from '../../common/jobs/job-queue';
import { TenantDirectory } from '../../common/tenant-directory';
import { UsageService } from '../../common/usage.service';
import { NotificationService } from '../notifications/notification.service';
import { evaluateRule } from '../workflows/rule-evaluator';
import { ActionOutcome, ActionRun, actionLabel, AutomationActions, classify, isExternalAction } from './actions.service';
import { AutomationEvent, EventContext, EventContextService } from './event-context.service';

export const EXECUTE_JOB = 'automation.execute';
export const SWEEP_JOB = 'automation.sweep';
/** A run that has been RUNNING this long was interrupted (process stopped); the sweep picks it up again. */
const STALE_RUNNING_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;

/** Delay before run number `attempts + 1`: 30 s, 1 min, 2 min, ... capped at one hour. */
export const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

export type ActionStatus = 'PENDING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
/** One entry of `automation_executions.actionResults`: the action as it was when the event arrived, and what became of it. */
export interface ActionResult {
  index: number;
  type: AutomationActionType;
  config: Record<string, unknown>;
  status: ActionStatus;
  attempts: number;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
  finishedAt?: string;
}
const isDone = (r: ActionResult) => r.status === 'SUCCEEDED' || r.status === 'SKIPPED';
export const resultsOf = (row: Pick<AutomationExecution, 'actionResults'>): ActionResult[] => (Array.isArray(row.actionResults) ? (row.actionResults as unknown as ActionResult[]) : []);

interface Claimed {
  execution: AutomationExecution;
  rule: AutomationRule;
  event: AutomationEvent;
}
type RunStatus = 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'DEAD_LETTER' | 'IGNORED';

/**
 * Event-driven automation.
 *
 *   domain event --(outbox, after commit)--> onEvent: one execution row per enabled rule
 *   whose conditions hold (unique per rule + event)  -->  job automation.execute
 *
 * The job runs the actions in order as the AUTOMATION actor inside the tenant.
 * Every action commits together with its own result, so a retry continues at
 * the first action that is not finished and never repeats a finished one.
 * Failures that can go away are retried with exponential backoff up to the
 * rule's `maxRetries`; then (or at once, when retrying cannot help) the
 * execution goes to the dead-letter list, is audited, and the owners of the
 * centre are alerted in the application.
 *
 * Loop protection: events caused by the AUTOMATION actor never start a rule.
 */
@Injectable()
export class AutomationEngine implements OnModuleInit {
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    private readonly db: TenantDb,
    private readonly events: DomainEvents,
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly contexts: EventContextService,
    private readonly actions: AutomationActions,
  ) {}

  onModuleInit() {
    this.events.subscribe('automation', AUTOMATION_TRIGGERS, async (event) => void (await this.onEvent(event)));
    // Retries are scheduled by the engine itself (per-rule budget, resume at the failed action), not by the queue.
    this.jobs.register<{ tenantId: string; executionId: string }>(EXECUTE_JOB, async (payload) => void (await this.execute(payload.tenantId, payload.executionId)), { attempts: 1 });
    this.jobs.register(SWEEP_JOB, async () => void (await this.tenants.forEachTenant(SWEEP_JOB, async () => void (await this.sweep()))), { attempts: 1 });
    this.jobs.schedule({ name: SWEEP_JOB, everySeconds: 300, description: 'Re-queue automation executions whose job was lost or whose retry is due' });
  }

  // =====================================================================================
  // Events -> executions
  // =====================================================================================
  /** Events of the AUTOMATION actor (everything an automation or another event subscriber did) never start a rule. */
  static causedByAutomation(event: Pick<DomainEvent, 'payload'>): boolean {
    return (event.payload as Record<string, any> | null)?._actor?.type === 'AUTOMATION';
  }
  /** Files the centre generates for itself (e.g. scheduled reports) are not "a document was uploaded" for automations. */
  private static internalFile(event: Pick<DomainEvent, 'type' | 'payload'>): boolean {
    const p = (event.payload ?? {}) as Record<string, any>;
    return event.type === 'document.uploaded' && p.generated === true && !p.customerId && !p.corporateAccountId && !p.requestId;
  }

  /** Outbox subscriber. At-least-once: a redelivered event finds its execution rows and creates nothing new. */
  async onEvent(event: DomainEvent): Promise<{ matched: number; created: number }> {
    if (!event.tenantId || AutomationEngine.causedByAutomation(event) || AutomationEngine.internalFile(event)) return { matched: 0, created: 0 };
    const tenantId = event.tenantId;
    return this.db.tx(async (tx) => {
      const rules = await tx.automationRule.findMany({ where: { tenantId, triggerEvent: event.type, isEnabled: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (!rules.length) return { matched: 0, created: 0 };
      // A centre that lost the feature (downgrade) keeps its rules, but they stop running.
      if (!(await this.usage.hasFeature('automation', tx))) return { matched: 0, created: 0 };
      const context = await this.contexts.load(tx, event);
      let matched = 0;
      let created = 0;
      for (const rule of rules) {
        if (!evaluateRule(rule.conditions as Rule, context.facts)) continue;
        matched += 1;
        const id = randomUUID();
        const actions = (Array.isArray(rule.actions) ? rule.actions : []) as unknown as AutomationAction[];
        const snapshot: ActionResult[] = actions.map((a, index) => ({ index, type: a.type, config: (a.config ?? {}) as Record<string, unknown>, status: 'PENDING', attempts: 0 }));
        const inserted = await tx.automationExecution.createMany({
          data: [{ id, tenantId, ruleId: rule.id, eventId: event.id, eventType: event.type, status: 'PENDING', actionResults: snapshot as unknown as Prisma.InputJsonValue }],
          skipDuplicates: true,
        });
        let executionId: string = id;
        if (inserted.count) created += 1;
        else {
          const existing = await tx.automationExecution.findFirst({ where: { tenantId, ruleId: rule.id, eventId: event.id }, select: { id: true, status: true } });
          if (!existing || existing.status !== 'PENDING') continue;
          executionId = existing.id;
        }
        this.db.afterCommit(() => this.jobs.enqueue(EXECUTE_JOB, { tenantId, executionId }, { jobId: `automation-${executionId}-0` }));
      }
      return { matched, created };
    });
  }

  // =====================================================================================
  // Execution
  // =====================================================================================
  /** Job handler. Returns what became of the execution (for logs and tests). */
  async execute(tenantId: string, executionId: string): Promise<RunStatus> {
    // Whatever the queue ran us as, the work happens as the AUTOMATION actor: no permissions, system edges only.
    return runAsTenant(tenantId, () => this.runExecution(executionId), { actorType: 'AUTOMATION', actorLabel: 'automation' });
  }

  private async runExecution(executionId: string): Promise<RunStatus> {
    const claimed = await this.claim(executionId);
    if (typeof claimed === 'string') return claimed;
    const { rule, event } = claimed;
    let execution = claimed.execution;
    // Audit entries and history rows written by the actions name the rule that caused them.
    ctx().actorLabel = `automation:${rule.name}`.slice(0, 120);
    const run = (index: number): ActionRun => ({ executionId, index, ruleId: rule.id, ruleName: rule.name });

    for (const planned of resultsOf(execution)) {
      if (isDone(planned)) continue;
      const action = { type: planned.type, config: planned.config } as AutomationAction;
      let failure: unknown = null;
      try {
        if (isExternalAction(action.type)) {
          // Network I/O happens outside any transaction; the result is recorded afterwards under the same fence.
          const prepared = await this.db.tx(async (tx) => {
            await this.fence(tx, execution);
            return { context: await this.contexts.load(tx, event), connection: await this.actions.webhookConnection(tx) };
          });
          const outcome = await this.actions.callWebhook(action.config as AutomationActionConfig['call_webhook'], prepared.context, run(planned.index), prepared.connection);
          execution = await this.db.tx(async (tx) => {
            await this.fence(tx, execution);
            return this.record(tx, execution, planned.index, { status: outcome.status, output: outcome.output });
          });
        } else {
          execution = await this.db.tx(
            async (tx) => {
              await this.fence(tx, execution);
              const context: EventContext = await this.contexts.load(tx, event);
              const outcome: ActionOutcome = await this.actions.run(tx, action, context, run(planned.index));
              return this.record(tx, execution, planned.index, { status: outcome.status, output: outcome.output });
            },
            { timeoutMs: 45_000 },
          );
        }
      } catch (e) {
        if (e instanceof Superseded) return 'IGNORED';
        failure = e;
      }
      if (failure) return this.fail(execution, rule, planned, failure);
    }

    await this.db.tx(async (tx) => {
      await this.fence(tx, execution);
      await tx.automationExecution.update({ where: { id: executionId }, data: { status: 'SUCCEEDED', finishedAt: new Date(), error: null } });
    });
    return 'SUCCEEDED';
  }

  /** PENDING / FAILED (or an interrupted RUNNING) -> RUNNING, under a row lock. Anything else is somebody else's or already finished. */
  private async claim(executionId: string): Promise<Claimed | RunStatus> {
    const tenantId = this.db.tenantId;
    return this.db.tx(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "automation_executions" WHERE "id" = ${executionId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      if (!locked.length) return 'IGNORED';
      const row = await tx.automationExecution.findFirstOrThrow({ where: { id: executionId, tenantId } });
      const interrupted = row.status === 'RUNNING' && (!row.startedAt || row.startedAt.getTime() < Date.now() - STALE_RUNNING_MS);
      if (row.status !== 'PENDING' && row.status !== 'FAILED' && !interrupted) return 'IGNORED';

      const stop = async (status: 'SKIPPED' | 'DEAD_LETTER', error: string) => {
        await tx.automationExecution.update({ where: { id: executionId }, data: { status, error, finishedAt: new Date() } });
        return status;
      };
      const rule = await tx.automationRule.findFirst({ where: { id: row.ruleId, tenantId } });
      if (!rule) return stop('SKIPPED', 'The automation no longer exists.');
      if (!rule.isEnabled) return stop('SKIPPED', 'The automation was switched off before it ran.');
      if (!(await this.usage.hasFeature('automation', tx))) return stop('SKIPPED', 'Automations are not included in the current plan.');
      const outbox = await tx.outboxEvent.findFirst({ where: { id: row.eventId, tenantId }, select: { id: true, type: true, payload: true, createdAt: true } });
      if (!outbox) {
        const execution = await tx.automationExecution.update({ where: { id: executionId }, data: { attempts: { increment: 1 }, startedAt: new Date() } });
        await this.deadLetter(tx, execution, rule, null, { code: 'EVENT_NOT_FOUND', message: 'The event that started this automation is no longer available.', retryable: false });
        return 'DEAD_LETTER';
      }
      const execution = await tx.automationExecution.update({ where: { id: executionId }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), finishedAt: null, error: null } });
      return { execution, rule, event: { id: outbox.id, type: outbox.type, payload: (outbox.payload ?? {}) as Record<string, any>, createdAt: outbox.createdAt } };
    });
  }

  /**
   * Fencing: locks the execution row and makes sure this run still owns it
   * (same attempt, still RUNNING). A run that was presumed dead and replaced
   * stops here instead of doing an action a second time.
   */
  private async fence(tx: Tx, mine: AutomationExecution): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ status: string; attempts: number }>>`
      SELECT "status"::text AS "status", "attempts" FROM "automation_executions" WHERE "id" = ${mine.id}::uuid AND "tenantId" = ${this.db.tenantId}::uuid FOR UPDATE`;
    if (!rows.length || rows[0].status !== 'RUNNING' || Number(rows[0].attempts) !== mine.attempts) throw new Superseded();
  }

  private async record(tx: Tx, execution: AutomationExecution, index: number, patch: Partial<ActionResult>): Promise<AutomationExecution> {
    const fresh = await tx.automationExecution.findFirstOrThrow({ where: { id: execution.id, tenantId: this.db.tenantId } });
    const results = resultsOf(fresh).map((r) => {
      if (r.index !== index) return r;
      const next: ActionResult = { ...r, ...patch, attempts: r.attempts + 1, finishedAt: new Date().toISOString() };
      if (patch.status !== 'FAILED') delete next.error;
      return next;
    });
    return tx.automationExecution.update({ where: { id: execution.id }, data: { actionResults: results as unknown as Prisma.InputJsonValue } });
  }

  /** An action failed: record it, then either schedule the next run or give up. */
  private async fail(execution: AutomationExecution, rule: AutomationRule, planned: ActionResult, failure: unknown): Promise<RunStatus> {
    const error = classify(failure);
    if (error.code === 'UNEXPECTED_ERROR') this.logger.error(`automation ${rule.id} execution ${execution.id} action ${planned.index} (${planned.type}): ${(failure as any)?.stack ?? failure}`);
    const tenantId = this.db.tenantId;
    try {
      return await this.db.tx(async (tx) => {
        await this.fence(tx, execution);
        const recorded = await this.record(tx, execution, planned.index, { status: 'FAILED', error });
        const exhausted = recorded.attempts > rule.maxRetries;
        if (!error.retryable || exhausted) {
          await this.deadLetter(tx, recorded, rule, planned, error);
          return 'DEAD_LETTER' as const;
        }
        const delayMs = backoffMs(recorded.attempts);
        await tx.automationExecution.update({
          where: { id: execution.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: `Step ${planned.index + 1} (${actionLabel(planned.type)}): ${error.message}`.slice(0, 1000) },
        });
        this.db.afterCommit(() => this.jobs.enqueue(EXECUTE_JOB, { tenantId, executionId: execution.id }, { delayMs, jobId: `automation-${execution.id}-${recorded.startedAt?.getTime() ?? 0}-${recorded.attempts}` }));
        return 'FAILED' as const;
      });
    } catch (e) {
      if (e instanceof Superseded) return 'IGNORED';
      throw e;
    }
  }

  /** Gives up: DEAD_LETTER + audit entry + in-app alert to the owners of the centre, all in one transaction. */
  private async deadLetter(tx: Tx, execution: AutomationExecution, rule: AutomationRule, planned: ActionResult | null, error: { code: string; message: string; retryable: boolean }): Promise<void> {
    const tenantId = this.db.tenantId;
    const where = planned ? `Step ${planned.index + 1} (${actionLabel(planned.type)}): ` : '';
    const summary = `${where}${error.message}`.slice(0, 1000);
    const finishedAt = new Date();
    await tx.automationExecution.update({ where: { id: execution.id }, data: { status: 'DEAD_LETTER', finishedAt, error: summary } });
    await this.audit.log(
      {
        action: 'automation.dead_letter',
        resourceType: 'AutomationExecution',
        resourceId: execution.id,
        summary: `Automation "${rule.name}" failed for good: ${summary}`.slice(0, 500),
        after: { ruleId: rule.id, eventId: execution.eventId, eventType: execution.eventType, attempts: execution.attempts, step: planned ? planned.index + 1 : null, action: planned?.type ?? null, code: error.code, retryable: error.retryable },
      },
      tx,
    );
    const owners = await tx.tenantMembership.findMany({ where: { tenantId, kind: 'STAFF', status: 'ACTIVE', role: { key: 'owner', tenantId } }, select: { userId: true } });
    for (const owner of new Set(owners.map((o) => o.userId))) {
      await this.notifications.sendCustom({
        dedupeId: `automation-dead:${execution.id}:${finishedAt.getTime()}`,
        recipient: { kind: 'USER', userId: owner },
        channels: ['IN_APP'],
        subject: 'Automation failed: {{ruleName}}',
        body: 'The automation "{{ruleName}}" could not finish after {{attempts}} attempt(s).\n{{reason}}\n\n[Open the execution log]({{executionLink}})',
        data: { ruleName: rule.name, attempts: execution.attempts, reason: summary, executionLink: `${env().CENTRE_WEB_URL.replace(/\/+$/, '')}/automations/executions/${execution.id}` },
        related: { type: 'AutomationExecution', id: execution.id },
      });
    }
  }

  // =====================================================================================
  // Manual retry and sweep
  // =====================================================================================
  /** Puts a dead-lettered execution back in the queue with a fresh retry budget. Finished actions stay finished. */
  async requeue(tx: Tx, executionId: string): Promise<void> {
    const tenantId = this.db.tenantId;
    await tx.automationExecution.update({ where: { id: executionId }, data: { status: 'PENDING', attempts: 0, error: null, startedAt: null, finishedAt: null } });
    this.db.afterCommit(() => this.jobs.enqueue(EXECUTE_JOB, { tenantId, executionId }, { jobId: `automation-${executionId}-m${Date.now()}` }));
  }

  /** Per tenant: executions whose job was lost (never started, interrupted) or whose retry time has come. */
  async sweep(now = new Date()): Promise<number> {
    const tenantId = this.db.tenantId;
    const rows = await this.db.tx((tx) =>
      tx.automationExecution.findMany({
        where: {
          tenantId,
          OR: [
            { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
            { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
            { status: 'FAILED' },
          ],
        },
        select: { id: true, status: true, attempts: true, finishedAt: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    );
    let queued = 0;
    // One id per sweep window: a sweep that runs twice does not queue the same execution twice.
    const window = Math.floor(now.getTime() / 300_000);
    for (const row of rows) {
      if (row.status === 'FAILED' && (row.finishedAt?.getTime() ?? 0) + backoffMs(row.attempts) + 60_000 > now.getTime()) continue;
      await this.jobs.enqueue(EXECUTE_JOB, { tenantId, executionId: row.id }, { jobId: `automation-${row.id}-s${window}` });
      queued += 1;
    }
    return queued;
  }
}

/** This run no longer owns the execution (it was taken over or finished elsewhere). */
class Superseded extends Error {}
