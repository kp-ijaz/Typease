import { Injectable } from '@nestjs/common';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, DOMAIN_EVENTS, REQUEST_STATUS_META, REQUEST_TRANSITIONS } from '@typease/types';
import type { AutomationActionType, Rule, RuleCondition } from '@typease/types';
import { AUTOMATION_NOTIFICATION_CHANNELS, createAutomationRuleSchema } from '@typease/validation';
import type {
  AutomationAction, AutomationExecutionListQuery, AutomationFromTemplateInput, AutomationRuleListQuery, AutomationTestInput, CreateAutomationRuleInput, UpdateAutomationRuleInput,
} from '@typease/validation';
import type { AutomationExecution, AutomationRule } from '@typease/database';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageResult } from '../../common/pagination';
import { UsageService } from '../../common/usage.service';
import { renderText, variablesIn } from '../notifications/render';
import { checkRule, evaluateCondition, evaluateRule, RULE_OPS } from '../workflows/rule-evaluator';
import { actionLabel, AutomationActions } from './actions.service';
import { ActionResult, AutomationEngine, resultsOf } from './engine.service';
import { AutomationEvent, EventContext, EventContextService } from './event-context.service';
import { automaticTargets, FACTS, NEEDS_CUSTOMER, NEEDS_REQUEST, TRIGGERS, triggerInfo, VARIABLES } from './facts';
import { AUTOMATION_TEMPLATES, findTemplate } from './templates';
import { baseOf, checkUrl, destinationOf, safeEventData, WebhookRefused } from './webhook';

export interface RuleProblem {
  /** Where in the rule: "conditions.all.0", "actions.1.config.roleKey", ... */
  path: string;
  code: string;
  message: string;
}

const AUTOMATIC_STATUSES = automaticTargets(REQUEST_TRANSITIONS);
const ASSIGNMENT_PERMISSION = { OPERATOR: 'request.process', REVIEWER: 'request.review' } as const;
const triggerLabel = (type: string) => (DOMAIN_EVENTS as Record<string, string>)[type] ?? type;
const actionsOf = (rule: Pick<AutomationRule, 'actions'>): AutomationAction[] => (Array.isArray(rule.actions) ? (rule.actions as unknown as AutomationAction[]) : []);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** The texts of an action that may contain `{{variables}}`, by config key. */
function textsOf(action: AutomationAction): Array<[string, string]> {
  const c = action.config as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    create_task: ['title', 'description'],
    create_follow_up: ['title', 'description'],
    send_notification: ['subject', 'body'],
    generate_document: ['title'],
    escalate: ['title', 'message'],
  };
  return (keys[action.type] ?? []).filter((k) => typeof c[k] === 'string').map((k) => [k, c[k] as string]);
}

/**
 * Management of automation rules: the rules themselves, the template gallery,
 * the dry run and the execution log. Everything a rule refers to (roles,
 * staff, services, branches, document types, webhook hosts) is checked against
 * the caller's own centre when the rule is saved and again when it is enabled.
 */
@Injectable()
export class AutomationRulesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly engine: AutomationEngine,
    private readonly contexts: EventContextService,
    private readonly actions: AutomationActions,
  ) {}

  // =====================================================================================
  // Validation
  // =====================================================================================
  /** Everything that is wrong with a rule definition. An empty list means the rule can be saved. */
  async problems(tx: Tx, input: { triggerEvent: string; conditions: Rule; actions: AutomationAction[] }): Promise<RuleProblem[]> {
    const tenantId = this.db.tenantId;
    const out: RuleProblem[] = [];
    const info = triggerInfo(input.triggerEvent);
    if (!info) return [{ path: 'triggerEvent', code: 'UNKNOWN_TRIGGER', message: 'Choose one of the events that can start an automation.' }];

    // ---- conditions: known facts, sound comparisons, and values that exist in this centre
    for (const p of checkRule(input.conditions, info.facts)) {
      out.push({ path: 'conditions', code: p.code, message: p.code === 'UNKNOWN_FACT' ? `${p.message.match(/^"[^"]+"/)?.[0] ?? 'That fact'} is not available for the event "${triggerLabel(input.triggerEvent)}".` : p.message });
    }
    const exists = {
      'service.code': async (v: string) => !!(await tx.service.findFirst({ where: { tenantId, code: v }, select: { id: true } })),
      'service.categoryKey': async (v: string) => !!(await tx.serviceCategory.findFirst({ where: { tenantId, key: v }, select: { id: true } })),
      'branch.code': async (v: string) => !!(await tx.branch.findFirst({ where: { tenantId, code: v }, select: { id: true } })),
      'assignee.roleKey': (v: string) => this.roleExists(tx, v),
      'step.escalateToRoleKey': (v: string) => this.roleExists(tx, v),
      'document.typeKey': (v: string) => this.documentTypeExists(tx, v),
    } as Record<string, (v: string) => Promise<boolean>>;
    const noun: Record<string, string> = { 'service.code': 'service', 'service.categoryKey': 'service category', 'branch.code': 'branch', 'assignee.roleKey': 'role', 'step.escalateToRoleKey': 'role', 'document.typeKey': 'document type' };
    for (const group of ['all', 'any'] as const) {
      for (const [i, condition] of (input.conditions[group] ?? []).entries()) {
        const check = exists[condition.fact];
        const doc = FACTS[condition.fact];
        if (!['eq', 'neq', 'in', 'nin'].includes(condition.op)) continue;
        for (const value of listOf(condition.value)) {
          if (doc?.values && typeof value === 'string' && !doc.values.includes(value)) {
            out.push({ path: `conditions.${group}.${i}`, code: 'UNKNOWN_VALUE', message: `"${value}" is not a possible value of "${doc.label}".` });
          } else if (check && typeof value === 'string' && !(await check(value))) {
            out.push({ path: `conditions.${group}.${i}`, code: 'UNKNOWN_REFERENCE', message: `There is no ${noun[condition.fact]} "${value}" in your centre.` });
          }
        }
      }
    }

    // ---- actions
    for (const [i, action] of input.actions.entries()) {
      const at = `actions.${i}`;
      const label = actionLabel(action.type);
      if (NEEDS_REQUEST.includes(action.type) && info.request === 'NEVER') {
        out.push({ path: at, code: 'ACTION_NOT_APPLICABLE', message: `"${label}" works on a request, and the event "${triggerLabel(input.triggerEvent)}" never has one.` });
        continue;
      }
      if (NEEDS_CUSTOMER.includes(action.type) && info.customer === 'NEVER') {
        out.push({ path: at, code: 'ACTION_NOT_APPLICABLE', message: `"${label}" works on a customer, and the event "${triggerLabel(input.triggerEvent)}" never has one.` });
        continue;
      }
      for (const [key, value] of textsOf(action)) {
        const unknown = variablesIn(value).filter((v) => !info.variables.includes(v));
        if (unknown.length) out.push({ path: `${at}.config.${key}`, code: 'UNKNOWN_VARIABLE', message: `${unknown.map((v) => `{{${v}}}`).join(', ')} cannot be used with the event "${triggerLabel(input.triggerEvent)}".` });
      }
      const role = async (key: string | undefined) => {
        if (key && !(await this.roleExists(tx, key))) out.push({ path: `${at}.config.roleKey`, code: 'UNKNOWN_ROLE', message: `There is no staff role "${key}" in your centre.` });
      };
      switch (action.type) {
        case 'create_task':
        case 'create_follow_up':
        case 'escalate':
          await role(action.config.roleKey);
          break;
        case 'assign_staff':
          if (action.config.mode === 'MEMBER') {
            const member = await tx.tenantMembership.findFirst({
              where: { id: action.config.membershipId, tenantId, kind: 'STAFF' },
              select: { status: true, user: { select: { fullName: true } }, role: { select: { name: true, rolePermissions: { select: { permissionKey: true } } } } },
            });
            if (!member) out.push({ path: `${at}.config.membershipId`, code: 'UNKNOWN_STAFF', message: 'That staff member does not exist in your centre.' });
            else if (member.status !== 'ACTIVE') out.push({ path: `${at}.config.membershipId`, code: 'STAFF_NOT_ACTIVE', message: `${member.user.fullName} is not an active staff member.` });
            else if (!member.role.rolePermissions.some((p) => p.permissionKey === ASSIGNMENT_PERMISSION[action.config.mode === 'MEMBER' ? action.config.role : 'OPERATOR'])) {
              out.push({ path: `${at}.config.membershipId`, code: 'STAFF_ROLE_NOT_SUITABLE', message: `${member.user.fullName} (${member.role.name}) cannot ${action.config.role === 'REVIEWER' ? 'review' : 'prepare'} applications.` });
            }
          }
          break;
        case 'send_notification':
          await role(action.config.roleKey);
          if (action.config.to === 'CUSTOMER' && info.customer === 'NEVER') out.push({ path: `${at}.config.to`, code: 'ACTION_NOT_APPLICABLE', message: `The event "${triggerLabel(input.triggerEvent)}" has no customer to notify.` });
          if (action.config.to === 'ASSIGNEE' && info.request === 'NEVER') out.push({ path: `${at}.config.to`, code: 'ACTION_NOT_APPLICABLE', message: `The event "${triggerLabel(input.triggerEvent)}" has no request, so there is no operator to notify.` });
          if (action.config.channels.includes('WHATSAPP') && !action.config.whatsappTemplateName) {
            out.push({ path: `${at}.config.whatsappTemplateName`, code: 'WHATSAPP_TEMPLATE_REQUIRED', message: 'WhatsApp messages need the name of a message template approved by Meta.' });
          }
          break;
        case 'schedule_reminder':
          if (action.config.documentTypeKey && !(await this.documentTypeExists(tx, action.config.documentTypeKey))) {
            out.push({ path: `${at}.config.documentTypeKey`, code: 'UNKNOWN_DOCUMENT_TYPE', message: `There is no document type "${action.config.documentTypeKey}" in your centre.` });
          }
          if (!action.config.documentTypeKey && !info.variables.includes('documentName')) {
            out.push({ path: `${at}.config.documentTypeKey`, code: 'DOCUMENT_TYPE_REQUIRED', message: `The event "${triggerLabel(input.triggerEvent)}" has no document: say which document the reminder is for and when it expires.` });
          }
          if (!info.variables.includes('expiryDate') && !action.config.expiryInDays) {
            out.push({ path: `${at}.config.expiryInDays`, code: 'EXPIRY_REQUIRED', message: `The event "${triggerLabel(input.triggerEvent)}" has no expiry date: say in how many days the document expires.` });
          }
          break;
        case 'generate_document':
          if (!(await this.documentTypeExists(tx, action.config.documentTypeKey))) {
            out.push({ path: `${at}.config.documentTypeKey`, code: 'UNKNOWN_DOCUMENT_TYPE', message: `There is no document type "${action.config.documentTypeKey}" in your centre.` });
          }
          break;
        case 'update_workflow_state':
          if (!AUTOMATIC_STATUSES.includes(action.config.to)) {
            out.push({
              path: `${at}.config.to`,
              code: 'STATUS_NOT_AUTOMATABLE',
              message: `An automation cannot move a request to "${REQUEST_STATUS_META[action.config.to].en}". Only the automatic steps of a request can be automated: ${AUTOMATIC_STATUSES.map((s) => REQUEST_STATUS_META[s as keyof typeof REQUEST_STATUS_META].en).join(', ')}. Steps that need a person's decision stay with staff.`,
            });
          }
          break;
        case 'call_webhook':
          if (action.config.url) {
            try {
              checkUrl(action.config.url, this.actions.policy((await this.actions.webhookConnection(tx).catch(() => ({ base: null }))).base));
            } catch (e) {
              if (!(e instanceof WebhookRefused)) throw e;
              out.push({ path: `${at}.config.url`, code: e.code, message: e.message });
            }
          }
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** What stops an otherwise valid rule from running right now (checked when it is switched on). */
  private async runProblems(tx: Tx, actions: AutomationAction[]): Promise<RuleProblem[]> {
    const out: RuleProblem[] = [];
    if (!actions.some((a) => a.type === 'call_webhook')) return out;
    let connection: { base: string | null; secret: string | null };
    try {
      connection = await this.actions.webhookConnection(tx);
    } catch (e: any) {
      return [{ path: 'actions', code: e?.code ?? 'CREDENTIALS_UNREADABLE', message: e?.message ?? 'The n8n connection could not be read.' }];
    }
    const policy = this.actions.policy(connection.base);
    for (const [i, action] of actions.entries()) {
      if (action.type !== 'call_webhook') continue;
      try {
        const checked = checkUrl(destinationOf(action.config, policy), policy);
        const secret = checked.trust === 'PLATFORM' ? env().N8N_WEBHOOK_SECRET : (connection.secret ?? env().N8N_WEBHOOK_SECRET);
        if (!secret) out.push({ path: `actions.${i}`, code: 'NOT_CONFIGURED', message: 'No signing secret is configured for webhooks. Add your n8n connection (with its signing secret) under Integrations.' });
      } catch (e) {
        if (!(e instanceof WebhookRefused)) throw e;
        out.push({ path: `actions.${i}.config.${action.config.url ? 'url' : 'path'}`, code: e.code, message: e.message });
      }
    }
    return out;
  }

  /**
   * What the owner of a saved rule has to know, on every answer that carries one rule: what is wrong with the
   * definition (a reference that has gone stale) and - when the definition is sound - what stops it from running
   * right now (no n8n connection, no signing secret). An empty list means the rule can be switched on.
   */
  private async findings(tx: Tx, rule: AutomationRule): Promise<RuleProblem[]> {
    const actions = actionsOf(rule);
    const problems = await this.problems(tx, { triggerEvent: rule.triggerEvent, conditions: (rule.conditions ?? {}) as Rule, actions });
    if (!problems.length) problems.push(...(await this.runProblems(tx, actions)));
    return problems;
  }

  private async roleExists(tx: Tx, key: string): Promise<boolean> {
    return !!(await tx.role.findFirst({ where: { tenantId: this.db.tenantId, key, kind: 'STAFF' }, select: { id: true } }));
  }
  private async documentTypeExists(tx: Tx, key: string): Promise<boolean> {
    return !!(await tx.documentType.findFirst({ where: { key, isActive: true, OR: [{ tenantId: this.db.tenantId }, { tenantId: null }] }, select: { id: true } }));
  }
  private reject(problems: RuleProblem[], message = 'Please correct the automation before saving it.'): never {
    throw Errors.unprocessable('INVALID_AUTOMATION', message, { problems });
  }

  // =====================================================================================
  // Rules
  // =====================================================================================
  private view(rule: AutomationRule) {
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      templateKey: rule.templateKey,
      triggerEvent: rule.triggerEvent,
      triggerLabel: triggerLabel(rule.triggerEvent),
      conditions: (rule.conditions ?? {}) as Rule,
      actions: actionsOf(rule).map((a) => ({ type: a.type, label: actionLabel(a.type), config: a.config })),
      isEnabled: rule.isEnabled,
      maxRetries: rule.maxRetries,
      createdById: rule.createdById,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }
  private async stats(tx: Tx, ruleIds: string[]) {
    const tenantId = this.db.tenantId;
    const map = new Map<string, { total: number; succeeded: number; failed: number; deadLetter: number; lastExecutionAt: Date | null }>();
    for (const id of ruleIds) map.set(id, { total: 0, succeeded: 0, failed: 0, deadLetter: 0, lastExecutionAt: null });
    if (!ruleIds.length) return map;
    const groups = await tx.automationExecution.groupBy({ by: ['ruleId', 'status'], where: { tenantId, ruleId: { in: ruleIds } }, _count: { _all: true }, _max: { createdAt: true } });
    for (const g of groups) {
      const s = map.get(g.ruleId)!;
      s.total += g._count._all;
      if (g.status === 'SUCCEEDED') s.succeeded += g._count._all;
      if (g.status === 'FAILED') s.failed += g._count._all;
      if (g.status === 'DEAD_LETTER') s.deadLetter += g._count._all;
      if (g._max.createdAt && (!s.lastExecutionAt || g._max.createdAt > s.lastExecutionAt)) s.lastExecutionAt = g._max.createdAt;
    }
    return map;
  }
  private async load(tx: Tx, id: string): Promise<AutomationRule> {
    return found(await tx.automationRule.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Automation');
  }

  async list(query: AutomationRuleListQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.AutomationRuleWhereInput = {
        tenantId: this.db.tenantId,
        ...(query.triggerEvent ? { triggerEvent: query.triggerEvent } : {}),
        ...(query.enabled ? { isEnabled: query.enabled === 'true' } : {}),
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.automationRule.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
        tx.automationRule.count({ where }),
      ]);
      const stats = await this.stats(tx, rows.map((r) => r.id));
      return pageResult(rows.map((r) => ({ ...this.view(r), stats: stats.get(r.id)! })), total, query);
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const rule = await this.load(tx, id);
      const stats = await this.stats(tx, [id]);
      // References can go stale after a rule was saved (a role deleted, a staff member left, the n8n connection removed): show it.
      return { ...this.view(rule), stats: stats.get(id)!, problems: await this.findings(tx, rule) };
    });
  }

  async create(input: CreateAutomationRuleInput) {
    return this.db.tx(async (tx) => {
      await this.usage.assertFeature('automation', tx);
      const problems = await this.problems(tx, input);
      if (problems.length) this.reject(problems);
      // What would stop the rule from running: refused for a rule that is switched on, reported for one that is not.
      const pending = await this.runProblems(tx, input.actions);
      if (pending.length && input.isEnabled) this.reject(pending);
      const rule = await tx.automationRule.create({
        data: {
          tenantId: this.db.tenantId, name: input.name, description: input.description ?? null, triggerEvent: input.triggerEvent,
          conditions: input.conditions as Prisma.InputJsonValue, actions: input.actions as unknown as Prisma.InputJsonValue, isEnabled: input.isEnabled, maxRetries: input.maxRetries, createdById: ctx().userId ?? null,
        },
      });
      await this.audit.log({ action: 'automation.created', resourceType: 'AutomationRule', resourceId: rule.id, summary: `Automation "${rule.name}" created${rule.isEnabled ? ' and switched on' : ''}`, after: this.auditShape(rule) }, tx);
      return { ...this.view(rule), problems: pending };
    });
  }

  async update(id: string, input: UpdateAutomationRuleInput) {
    return this.db.tx(async (tx) => {
      const before = await this.lock(tx, id);
      const next = {
        triggerEvent: input.triggerEvent ?? before.triggerEvent,
        conditions: (input.conditions ?? before.conditions ?? {}) as Rule,
        actions: input.actions ?? actionsOf(before),
      };
      const problems = await this.problems(tx, next);
      if (problems.length) this.reject(problems);
      const pending = await this.runProblems(tx, next.actions);
      if (pending.length && before.isEnabled) this.reject(pending);
      const rule = await tx.automationRule.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.triggerEvent !== undefined ? { triggerEvent: input.triggerEvent } : {}),
          ...(input.conditions !== undefined ? { conditions: input.conditions as Prisma.InputJsonValue } : {}),
          ...(input.actions !== undefined ? { actions: input.actions as unknown as Prisma.InputJsonValue } : {}),
          ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
        },
      });
      await this.audit.log({ action: 'automation.updated', resourceType: 'AutomationRule', resourceId: id, summary: `Automation "${rule.name}" changed`, before: this.auditShape(before), after: this.auditShape(rule) }, tx);
      return { ...this.view(rule), problems: pending };
    });
  }

  async remove(id: string) {
    return this.db.tx(async (tx) => {
      const rule = await this.lock(tx, id);
      const executions = await tx.automationExecution.count({ where: { tenantId: this.db.tenantId, ruleId: id } });
      // The execution log of the rule goes with it (database cascade); the audit trail keeps what the rule was.
      await tx.automationRule.delete({ where: { id } });
      await this.audit.log({ action: 'automation.deleted', resourceType: 'AutomationRule', resourceId: id, summary: `Automation "${rule.name}" deleted together with ${executions} execution record(s)`, before: this.auditShape(rule) }, tx);
      return { status: 'DELETED' as const };
    });
  }

  async enable(id: string) {
    return this.db.tx(async (tx) => {
      await this.usage.assertFeature('automation', tx);
      const rule = await this.lock(tx, id);
      const actions = actionsOf(rule);
      const problems = await this.problems(tx, { triggerEvent: rule.triggerEvent, conditions: (rule.conditions ?? {}) as Rule, actions });
      if (!problems.length) problems.push(...(await this.runProblems(tx, actions)));
      if (problems.length) this.reject(problems, 'This automation cannot be switched on yet.');
      if (rule.isEnabled) return { ...this.view(rule), problems: [] as RuleProblem[] };
      const updated = await tx.automationRule.update({ where: { id }, data: { isEnabled: true } });
      await this.audit.log({ action: 'automation.enabled', resourceType: 'AutomationRule', resourceId: id, summary: `Automation "${rule.name}" switched on`, before: { isEnabled: false }, after: { isEnabled: true } }, tx);
      return { ...this.view(updated), problems: [] as RuleProblem[] };
    });
  }

  async disable(id: string) {
    return this.db.tx(async (tx) => {
      const rule = await this.lock(tx, id);
      if (!rule.isEnabled) return { ...this.view(rule), problems: await this.findings(tx, rule) };
      const updated = await tx.automationRule.update({ where: { id }, data: { isEnabled: false } });
      await this.audit.log({ action: 'automation.disabled', resourceType: 'AutomationRule', resourceId: id, summary: `Automation "${rule.name}" switched off`, before: { isEnabled: true }, after: { isEnabled: false } }, tx);
      return { ...this.view(updated), problems: await this.findings(tx, updated) };
    });
  }

  private async lock(tx: Tx, id: string): Promise<AutomationRule> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "automation_rules" WHERE "id" = ${id}::uuid AND "tenantId" = ${this.db.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Automation');
    return this.load(tx, id);
  }
  private auditShape(rule: AutomationRule) {
    return { name: rule.name, triggerEvent: rule.triggerEvent, conditions: rule.conditions, actions: actionsOf(rule).map((a) => ({ type: a.type, config: a.config })), isEnabled: rule.isEnabled, maxRetries: rule.maxRetries, templateKey: rule.templateKey };
  }

  // =====================================================================================
  // Templates
  // =====================================================================================
  async templates() {
    const available = await this.usage.hasFeature('automation');
    return {
      available,
      templates: AUTOMATION_TEMPLATES.map((t) => ({
        key: t.key, name: t.name, description: t.description, category: t.category, triggerEvent: t.triggerEvent, triggerLabel: triggerLabel(t.triggerEvent), conditions: t.conditions,
        actions: t.actions.map((a) => ({ type: a.type, label: actionLabel(a.type), config: a.config })), maxRetries: t.maxRetries, requires: t.requires ?? null,
      })),
    };
  }

  /** Copies a template into the centre as a DISABLED rule. Things the owner still has to fix come back as `problems`. */
  async fromTemplate(key: string, input: AutomationFromTemplateInput) {
    const template = findTemplate(key);
    if (!template) throw Errors.notFound('Automation template');
    const parsed = createAutomationRuleSchema.parse({ name: input.name ?? template.name, description: template.description, triggerEvent: template.triggerEvent, conditions: template.conditions, actions: template.actions, isEnabled: false, maxRetries: template.maxRetries });
    return this.db.tx(async (tx) => {
      await this.usage.assertFeature('automation', tx);
      const rule = await tx.automationRule.create({
        data: {
          tenantId: this.db.tenantId, name: parsed.name, description: parsed.description ?? null, templateKey: template.key, triggerEvent: parsed.triggerEvent,
          conditions: parsed.conditions as Prisma.InputJsonValue, actions: parsed.actions as unknown as Prisma.InputJsonValue, isEnabled: false, maxRetries: parsed.maxRetries, createdById: ctx().userId ?? null,
        },
      });
      await this.audit.log({ action: 'automation.created', resourceType: 'AutomationRule', resourceId: rule.id, summary: `Automation "${rule.name}" created from the template "${template.name}"`, after: this.auditShape(rule) }, tx);
      return { ...this.view(rule), problems: await this.findings(tx, rule) };
    });
  }

  // =====================================================================================
  // Dry run
  // =====================================================================================
  /**
   * Evaluates the rule against a real, recent event and says what would
   * happen. Nothing is executed, nothing is written, no execution row is
   * created.
   */
  async test(id: string, input: AutomationTestInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const rule = await this.load(tx, id);
      let row: { id: string; type: string; payload: unknown; createdAt: Date } | null;
      if (input.eventId) {
        row = found(await tx.outboxEvent.findFirst({ where: { id: input.eventId, tenantId }, select: { id: true, type: true, payload: true, createdAt: true } }), 'Event');
        if (row.type !== rule.triggerEvent) throw Errors.unprocessable('EVENT_TYPE_MISMATCH', `That event is "${triggerLabel(row.type)}", but this automation starts on "${triggerLabel(rule.triggerEvent)}".`);
      } else {
        const recent = await tx.outboxEvent.findMany({ where: { tenantId, type: rule.triggerEvent }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25, select: { id: true, type: true, payload: true, createdAt: true } });
        // Prefer an event a rule would actually see (not one caused by an automation).
        row = recent.find((r) => !AutomationEngine.causedByAutomation({ payload: (r.payload ?? {}) as Record<string, any> })) ?? recent[0] ?? null;
        if (!row) throw Errors.unprocessable('NO_RECENT_EVENT', `There is no "${triggerLabel(rule.triggerEvent)}" event in your centre yet to test with. Try again after one has happened.`);
      }
      const event: AutomationEvent = { id: row.id, type: row.type, payload: (row.payload ?? {}) as Record<string, any>, createdAt: row.createdAt };
      const context = await this.contexts.load(tx, event);
      const conditions = (rule.conditions ?? {}) as Rule;
      const explain = (group: 'all' | 'any') => (conditions[group] ?? []).map((c: RuleCondition) => ({ group, fact: c.fact, label: FACTS[c.fact]?.label ?? c.fact, op: c.op, value: c.value ?? null, actual: context.facts[c.fact] ?? null, passed: evaluateCondition(c, context.facts) }));
      const conditionsMet = evaluateRule(conditions, context.facts);
      const causedByAutomation = AutomationEngine.causedByAutomation(event);
      const featureAvailable = await this.usage.hasFeature('automation', tx);
      const connection = await this.actions.webhookConnection(tx).catch(() => ({ base: null as string | null, secret: null as string | null }));
      const alreadyRan = await tx.automationExecution.findFirst({ where: { tenantId, ruleId: rule.id, eventId: event.id }, select: { id: true, status: true } });

      const facts = Object.fromEntries(Object.entries(context.facts).filter(([key]) => TRIGGERS[rule.triggerEvent]?.facts.includes(key)));
      return {
        dryRun: true as const,
        rule: { id: rule.id, name: rule.name, isEnabled: rule.isEnabled },
        event: { id: event.id, type: event.type, label: triggerLabel(event.type), occurredAt: event.createdAt, causedByAutomation, data: safeEventData(event.payload) },
        facts,
        conditions: [...explain('all'), ...explain('any')],
        conditionsMet,
        /** Would a live event like this one start the rule right now? */
        wouldRun: conditionsMet && rule.isEnabled && featureAvailable && !causedByAutomation,
        notes: [
          ...(rule.isEnabled ? [] : ['The automation is switched off.']),
          ...(featureAvailable ? [] : ['Automations are not included in your current plan.']),
          ...(causedByAutomation ? ['This event was caused by an automation; such events never start a rule.'] : []),
          ...(alreadyRan ? [`The automation already handled this event (execution ${alreadyRan.status.toLowerCase().replace('_', ' ')}).`] : []),
        ],
        actions: conditionsMet ? actionsOf(rule).map((a, index) => ({ index, type: a.type, label: actionLabel(a.type), config: a.config, ...this.preview(a, context, connection.base) })) : [],
      };
    });
  }

  /** What an action would do for this event, in words; no side effects. */
  private preview(action: AutomationAction, c: EventContext, tenantBase: string | null): { applicable: boolean; note?: string; preview?: Record<string, unknown> } {
    const render = (t: string | undefined | null) => (t ? renderText(t, c.variables) : null);
    const noRequest = { applicable: false, note: 'The event does not belong to a request: this action would be skipped.' };
    switch (action.type) {
      case 'create_task':
        return { applicable: true, preview: { title: render(action.config.title), description: render(action.config.description), queue: action.config.roleKey ?? null, requestNumber: c.request?.requestNo ?? null } };
      case 'create_follow_up':
        return { applicable: true, preview: { title: render(action.config.title), description: render(action.config.description), queue: action.config.roleKey ?? null, dueInDays: action.config.dueInDays } };
      case 'assign_staff':
        if (!c.request) return noRequest;
        if (action.config.mode === 'AUTO' ? c.request.assignedToId : action.config.role === 'REVIEWER' ? c.request.reviewerId : c.request.assignedToId) return { applicable: false, note: 'The request is already assigned: this action would be skipped.' };
        return { applicable: true, preview: { requestNumber: c.request.requestNo, mode: action.config.mode } };
      case 'send_notification':
        if (action.config.to === 'CUSTOMER' && !c.customerId) return { applicable: false, note: 'The event has no customer: this action would be skipped.' };
        if (action.config.to === 'ASSIGNEE' && !c.assignee) return { applicable: false, note: 'The request has no operator: this action would be skipped.' };
        return {
          applicable: true,
          note: 'Whether each channel is actually used is decided when the message is sent: consent, opt-outs, rate limits and your plan apply.',
          preview: { to: action.config.to === 'ROLE' ? `Everyone with the role "${action.config.roleKey}"` : action.config.to === 'ASSIGNEE' ? c.assignee!.name : 'The customer', channels: action.config.channels, subject: render(action.config.subject), body: render(action.config.body) },
        };
      case 'schedule_reminder': {
        if (!c.customerId && !c.corporateAccountId) return { applicable: false, note: 'The event has no customer or company: this action would be skipped.' };
        const key = action.config.documentTypeKey ?? c.document?.typeKey ?? null;
        const expiry = (c.document && c.document.typeKey === key ? c.document.expiryDate : null) ?? (action.config.expiryInDays ? `in ${action.config.expiryInDays} days` : null);
        if (!expiry) return { applicable: false, note: 'No expiry date is known for the document: this action would be skipped.' };
        return { applicable: true, preview: { documentTypeKey: key, expiryDate: expiry } };
      }
      case 'generate_document':
        if (!c.request) return noRequest;
        return { applicable: true, preview: { title: render(action.config.title) ?? `Request summary ${c.request.requestNo}`, customerVisible: action.config.customerVisible } };
      case 'update_workflow_state': {
        if (!c.request) return noRequest;
        if (c.request.status === action.config.to) return { applicable: false, note: 'The request is already in that status.' };
        const edge = REQUEST_TRANSITIONS[c.request.status]?.find((r) => r.to === action.config.to);
        if (!edge?.system) {
          return { applicable: false, note: `A request that is "${REQUEST_STATUS_META[c.request.status].en}" cannot be moved to "${REQUEST_STATUS_META[action.config.to].en}" by an automation: this action would fail.` };
        }
        return { applicable: true, note: 'The checks of this step (documents, payment, approvals) are applied when the automation runs.', preview: { from: c.request.status, to: action.config.to } };
      }
      case 'request_approval':
        if (!c.request) return noRequest;
        if (c.request.status !== 'IN_PREPARATION') return { applicable: false, note: `A review can only be requested while the request is in preparation (it is ${REQUEST_STATUS_META[c.request.status].en.toLowerCase()}): this action would fail.` };
        return { applicable: true, preview: { requestNumber: c.request.requestNo } };
      case 'escalate':
        return { applicable: true, preview: { roleKey: action.config.roleKey, title: render(action.config.title), message: render(action.config.message), priority: action.config.priority } };
      case 'call_webhook': {
        const policy = this.actions.policy(tenantBase);
        try {
          const checked = checkUrl(destinationOf(action.config, policy), policy);
          return {
            applicable: true,
            preview: { host: checked.hostname, path: checked.url.pathname, payload: { event: c.event.type, tenantSlug: c.tenant.slug, occurredAt: c.event.createdAt.toISOString(), data: { eventId: c.event.id, ...safeEventData(c.event.payload) } } },
          };
        } catch (e) {
          if (e instanceof WebhookRefused) return { applicable: false, note: `${e.message} This action would fail.` };
          throw e;
        }
      }
      default:
        return { applicable: false, note: 'Unknown action.' };
    }
  }

  // =====================================================================================
  // Execution log
  // =====================================================================================
  private executionRow(e: AutomationExecution, ruleName: string | null) {
    return {
      id: e.id,
      ruleId: e.ruleId,
      ruleName,
      eventId: e.eventId,
      eventType: e.eventType,
      eventLabel: triggerLabel(e.eventType),
      status: e.status,
      attempts: e.attempts,
      error: e.error,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      createdAt: e.createdAt,
    };
  }
  private actionRows(results: ActionResult[], detailed: boolean) {
    return results.map((r) => ({
      index: r.index,
      type: r.type,
      label: actionLabel(r.type),
      status: r.status,
      attempts: r.attempts,
      finishedAt: r.finishedAt ?? null,
      ...(detailed ? { config: r.config, output: r.output ?? null, error: r.error ?? null } : {}),
    }));
  }

  async executions(query: AutomationExecutionListQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (query.from && query.to && query.from > query.to) throw Errors.badRequest('INVALID_RANGE', 'The start date must not be after the end date.');
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.from) createdAt.gte = new Date(`${query.from}T00:00:00.000Z`);
      if (query.to) createdAt.lt = new Date(Date.parse(`${query.to}T00:00:00.000Z`) + 86_400_000);
      const where: Prisma.AutomationExecutionWhereInput = {
        tenantId,
        ...(query.ruleId ? { ruleId: query.ruleId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
        ...(query.from || query.to ? { createdAt } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.automationExecution.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { rule: { select: { name: true } } } }),
        tx.automationExecution.count({ where }),
      ]);
      return pageResult(rows.map((e) => ({ ...this.executionRow(e, e.rule.name), actions: this.actionRows(resultsOf(e), false) })), total, query);
    });
  }

  async execution(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const e = found(await tx.automationExecution.findFirst({ where: { id, tenantId }, include: { rule: { select: { name: true, isEnabled: true, maxRetries: true } } } }), 'Execution');
      const event = await tx.outboxEvent.findFirst({ where: { id: e.eventId, tenantId }, select: { createdAt: true, payload: true } });
      return {
        ...this.executionRow(e, e.rule.name),
        maxRetries: e.rule.maxRetries,
        canRetry: e.status === 'DEAD_LETTER' && e.rule.isEnabled,
        // Identifiers and status values only: the same view of the event a webhook would get.
        event: event ? { occurredAt: event.createdAt, data: safeEventData((event.payload ?? {}) as Record<string, unknown>) } : null,
        actions: this.actionRows(resultsOf(e), true),
      };
    });
  }

  /** Puts a dead-lettered execution back in the queue. Actions that already succeeded are not repeated. */
  async retry(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "automation_executions" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      if (!rows.length) throw Errors.notFound('Execution');
      const e = await tx.automationExecution.findFirstOrThrow({ where: { id, tenantId }, include: { rule: { select: { name: true, isEnabled: true } } } });
      if (e.status !== 'DEAD_LETTER') throw Errors.conflict('NOT_DEAD_LETTERED', 'Only executions on the dead-letter list can be retried.');
      if (!e.rule.isEnabled) throw Errors.conflict('AUTOMATION_DISABLED', 'Switch the automation on before retrying one of its executions.');
      await this.usage.assertFeature('automation', tx);
      await this.engine.requeue(tx, id);
      await this.audit.log({ action: 'automation.execution_retried', resourceType: 'AutomationExecution', resourceId: id, summary: `Dead-lettered execution of "${e.rule.name}" queued again`, before: { status: 'DEAD_LETTER', attempts: e.attempts, error: e.error }, after: { status: 'PENDING' } }, tx);
      const after = await tx.automationExecution.findFirstOrThrow({ where: { id, tenantId } });
      return { ...this.executionRow(after, e.rule.name), actions: this.actionRows(resultsOf(after), true) };
    });
  }

  // =====================================================================================
  // Summary and meta
  // =====================================================================================
  async summary() {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const now = Date.now();
      const count = async (since: Date | null) => {
        const groups = await tx.automationExecution.groupBy({ by: ['status'], where: { tenantId, ...(since ? { createdAt: { gte: since } } : {}) }, _count: { _all: true } });
        const out = { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, deadLetter: 0 };
        for (const g of groups) {
          out.total += g._count._all;
          if (g.status === 'PENDING') out.pending = g._count._all;
          if (g.status === 'RUNNING') out.running = g._count._all;
          if (g.status === 'SUCCEEDED') out.succeeded = g._count._all;
          if (g.status === 'FAILED') out.failed = g._count._all;
          if (g.status === 'SKIPPED') out.skipped = g._count._all;
          if (g.status === 'DEAD_LETTER') out.deadLetter = g._count._all;
        }
        return out;
      };
      const [total, enabled, last24h, last7d, allTime, recent] = await Promise.all([
        tx.automationRule.count({ where: { tenantId } }),
        tx.automationRule.count({ where: { tenantId, isEnabled: true } }),
        count(new Date(now - 86_400_000)),
        count(new Date(now - 7 * 86_400_000)),
        count(null),
        tx.automationExecution.findMany({ where: { tenantId, status: 'DEAD_LETTER' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], take: 5, include: { rule: { select: { name: true } } } }),
      ]);
      return {
        available: await this.usage.hasFeature('automation', tx),
        rules: { total, enabled, disabled: total - enabled },
        executions: { last24h, last7d, allTime },
        /** Executions waiting for someone to look at them. */
        deadLetters: { open: allTime.deadLetter, recent: recent.map((e) => this.executionRow(e, e.rule.name)) },
      };
    });
  }

  /** Everything the rule builder needs to offer only what can work. */
  async meta() {
    return this.db.tx(async (tx) => {
      const connection = await this.actions.webhookConnection(tx).catch(() => ({ base: null as string | null, secret: null as string | null }));
      const policy = this.actions.policy(connection.base);
      const base = baseOf(policy);
      return {
        available: await this.usage.hasFeature('automation', tx),
        triggers: AUTOMATION_TRIGGERS.map((key) => {
          const info = TRIGGERS[key];
          return {
            key,
            label: triggerLabel(key),
            hasRequest: info.request,
            hasCustomer: info.customer,
            facts: info.facts.map((f) => ({ key: f, label: FACTS[f]?.label ?? f, type: FACTS[f]?.type ?? 'string', values: FACTS[f]?.values ?? null })),
            variables: info.variables.map((v) => ({ key: v, description: VARIABLES[v] ?? v })),
          };
        }),
        actions: (Object.keys(AUTOMATION_ACTIONS) as AutomationActionType[]).map((type) => ({ type, label: actionLabel(type), needsRequest: NEEDS_REQUEST.includes(type), needsCustomer: NEEDS_CUSTOMER.includes(type) })),
        operators: RULE_OPS,
        channels: AUTOMATION_NOTIFICATION_CHANNELS,
        /** The only statuses an automation may move a request to (the automatic steps of the state machine). */
        automaticStatuses: AUTOMATIC_STATUSES.map((s) => ({ status: s, label: REQUEST_STATUS_META[s as keyof typeof REQUEST_STATUS_META].en })),
        webhook: {
          configured: !!base && !!(connection.base ? (connection.secret ?? env().N8N_WEBHOOK_SECRET) : env().N8N_WEBHOOK_SECRET),
          source: connection.base ? ('CENTRE' as const) : base ? ('PLATFORM' as const) : null,
          approvedHosts: [...policy.allowedHosts],
          signature: 'X-TypEase-Signature: sha256=HMAC-SHA256(secret, "<X-TypEase-Timestamp>.<raw body>")',
        },
        limits: { maxActions: 10, maxRetries: 10, maxConditionsPerGroup: 20 },
      };
    });
  }
}
