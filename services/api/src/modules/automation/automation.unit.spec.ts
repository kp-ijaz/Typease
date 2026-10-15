import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, REQUEST_TRANSITIONS } from '@typease/types';
import { automationAction, createAutomationRuleSchema, updateAutomationRuleSchema } from '@typease/validation';
import { AppError, Errors } from '../../common/errors';
import { variablesIn } from '../notifications/render';
import { checkRule } from '../workflows/rule-evaluator';
import { ActionError, classify } from './actions.service';
import { AutomationEngine, backoffMs } from './engine.service';
import { automaticTargets, FACTS, NEEDS_CUSTOMER, NEEDS_REQUEST, TRIGGERS, VARIABLES } from './facts';
import { AUTOMATION_TEMPLATES } from './templates';
import { WebhookFailed, WebhookRefused } from './webhook';

const TEXT_KEYS = ['title', 'description', 'subject', 'body', 'message'];

describe('automation facts and variables', () => {
  it('documents every trigger, fact and variable', () => {
    expect(Object.keys(TRIGGERS).sort()).toEqual([...AUTOMATION_TRIGGERS].sort());
    for (const [trigger, info] of Object.entries(TRIGGERS)) {
      for (const fact of info.facts) expect(FACTS[fact] ? fact : `${trigger}: ${fact} undocumented`).toBe(fact);
      for (const variable of info.variables) expect(VARIABLES[variable] ? variable : `${trigger}: ${variable} undocumented`).toBe(variable);
      expect(new Set(info.facts).size).toBe(info.facts.length);
      expect(new Set(info.variables).size).toBe(info.variables.length);
      expect(info.facts).toEqual(expect.arrayContaining(['event.type', 'event.actorType']));
    }
  });

  it('knows which events have a request and a customer', () => {
    expect(TRIGGERS['request.submitted']).toMatchObject({ request: 'ALWAYS', customer: 'ALWAYS' });
    expect(TRIGGERS['customer.created']).toMatchObject({ request: 'NEVER', customer: 'ALWAYS' });
    expect(TRIGGERS['document.uploaded']).toMatchObject({ request: 'SOMETIMES', customer: 'SOMETIMES' });
    expect(TRIGGERS['subscription.renewal_due']).toMatchObject({ request: 'NEVER', customer: 'NEVER' });
    expect(TRIGGERS['subscription.renewal_due'].variables).not.toContain('customerName');
    expect(TRIGGERS['request.status_changed'].facts).toEqual(expect.arrayContaining(['status.from', 'status.to']));
    expect(TRIGGERS['request.submitted'].facts).not.toContain('status.to');
  });

  it('lets automations set only the statuses of the automatic edges of the state machine', () => {
    const targets = automaticTargets(REQUEST_TRANSITIONS).sort();
    expect(targets).toEqual(['AWAITING_PAYMENT', 'IN_PREPARATION', 'QUOTED', 'READY_FOR_PROCESSING', 'UNDER_REVIEW']);
    // Decisions of people are never automatic.
    for (const status of ['PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'FINAL_REVIEW', 'COMPLETED', 'CANCELLED', 'REJECTED', 'SUBMITTED']) expect(targets).not.toContain(status);
  });
});

describe('automation templates', () => {
  it('offers at least eight templates with unique keys', () => {
    expect(AUTOMATION_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.key)).size).toBe(AUTOMATION_TEMPLATES.length);
    expect(AUTOMATION_TEMPLATES.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'Assign automatically when a request is submitted', 'Create a follow-up task 2 days after a quotation is approved', 'Notify the manager when a request becomes overdue',
        'Escalate a workflow step that passed its time limit', 'Thank the customer when a request is completed', 'Schedule an expiry reminder when a document is verified',
        'Notify the accountant when a payment is received', 'Send new requests to n8n',
      ]),
    );
  });

  it.each(AUTOMATION_TEMPLATES.map((t) => [t.key, t] as const))('%s is a valid rule for its trigger', (_key, template) => {
    const parsed = createAutomationRuleSchema.parse({ name: template.name, description: template.description, triggerEvent: template.triggerEvent, conditions: template.conditions, actions: template.actions, maxRetries: template.maxRetries });
    expect(parsed.isEnabled).toBe(false);
    const info = TRIGGERS[template.triggerEvent];
    expect(checkRule(parsed.conditions, info.facts)).toEqual([]);
    for (const action of parsed.actions) {
      if (NEEDS_REQUEST.includes(action.type)) expect(info.request).not.toBe('NEVER');
      if (NEEDS_CUSTOMER.includes(action.type)) expect(info.customer).not.toBe('NEVER');
      for (const key of TEXT_KEYS) {
        const text = (action.config as Record<string, unknown>)[key];
        if (typeof text === 'string') expect(variablesIn(text).filter((v) => !info.variables.includes(v))).toEqual([]);
      }
      if (action.type === 'update_workflow_state') expect(automaticTargets(REQUEST_TRANSITIONS)).toContain(action.config.to);
    }
  });
});

describe('automation rule validation (shape)', () => {
  const base = { name: 'Rule', triggerEvent: 'request.submitted' };
  const parse = (actions: unknown[], extra: Record<string, unknown> = {}) => createAutomationRuleSchema.safeParse({ ...base, actions, ...extra });
  const paths = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.path.join('.')));

  it('has a config schema for every action type and applies defaults', () => {
    for (const type of Object.keys(AUTOMATION_ACTIONS)) expect(automationAction.safeParse({ type, config: { __nope: 1 } }).success).toBe(false);
    const ok = parse([
      { type: 'create_task', config: { title: 'Call {{customerName}}' } },
      { type: 'create_follow_up', config: { title: 'Follow up' } },
      { type: 'assign_staff', config: { mode: 'AUTO' } },
      { type: 'send_notification', config: { to: 'CUSTOMER', channels: ['EMAIL', 'EMAIL', 'SMS'], subject: 'Hi', body: 'Hello {{customerName}}' } },
      { type: 'schedule_reminder' },
      { type: 'generate_document', config: {} },
      { type: 'update_workflow_state', config: { to: 'UNDER_REVIEW' } },
      { type: 'request_approval', config: {} },
      { type: 'escalate', config: {} },
      { type: 'call_webhook', config: { path: '/typease/new' } },
    ]);
    expect(ok.success).toBe(true);
    if (!ok.success) return;
    expect(ok.data).toMatchObject({ isEnabled: false, maxRetries: 3, conditions: {} });
    expect(ok.data.actions[0].config).toMatchObject({ priority: 'NORMAL', type: 'GENERAL' });
    expect(ok.data.actions[1].config).toMatchObject({ dueInDays: 2 });
    expect(ok.data.actions[3].config).toMatchObject({ channels: ['EMAIL', 'SMS'], purpose: 'SERVICE' });
    expect(ok.data.actions[5].config).toEqual({ documentTypeKey: 'other', customerVisible: false });
    expect(ok.data.actions[8].config).toMatchObject({ roleKey: 'manager', priority: 'HIGH' });
  });

  it('rejects unknown triggers, unknown actions, no actions and too many actions', () => {
    expect(paths(createAutomationRuleSchema.safeParse({ ...base, triggerEvent: 'invoice.issued', actions: [{ type: 'request_approval' }] }))).toContain('triggerEvent');
    expect(paths(parse([{ type: 'delete_everything', config: {} }]))).toContain('actions.0.type');
    expect(paths(parse([]))).toContain('actions');
    expect(parse(Array.from({ length: 11 }, () => ({ type: 'request_approval' }))).success).toBe(false);
    expect(parse([{ type: 'request_approval' }], { maxRetries: 11 }).success).toBe(false);
    expect(parse([{ type: 'request_approval' }], { tenantId: 'x' }).success).toBe(false);
  });

  it('points at the config field that is wrong', () => {
    expect(paths(parse([{ type: 'send_notification', config: { to: 'ROLE', channels: ['IN_APP'], subject: 's', body: 'hello' } }]))).toContain('actions.0.config.roleKey');
    expect(paths(parse([{ type: 'send_notification', config: { to: 'CUSTOMER', channels: ['EMAIL'], body: 'hello' } }]))).toContain('actions.0.config.subject');
    expect(paths(parse([{ type: 'send_notification', config: { to: 'ASSIGNEE', channels: ['SMS'], body: 'hello', purpose: 'MARKETING' } }]))).toContain('actions.0.config.purpose');
    expect(parse([{ type: 'send_notification', config: { to: 'CUSTOMER', channels: ['SMS'], body: 'hello', purpose: 'MARKETING' } }]).success).toBe(true);
    expect(paths(parse([{ type: 'assign_staff', config: { mode: 'MEMBER' } }]))).toContain('actions.0.config.membershipId');
    expect(paths(parse([{ type: 'update_workflow_state', config: { to: 'DONE' } }]))).toContain('actions.0.config.to');
    expect(paths(parse([{ type: 'escalate', config: { priority: 'LOW' } }]))).toContain('actions.0.config.priority');
  });

  it('accepts a webhook path or a complete URL, never both, and no path tricks', () => {
    const hook = (config: Record<string, unknown>) => parse([{ type: 'call_webhook', config }]).success;
    expect(hook({ path: '/typease/request-submitted' })).toBe(true);
    expect(hook({ url: 'https://hooks.partner.example/a?b=1' })).toBe(true);
    expect(hook({})).toBe(false);
    expect(hook({ path: '/a', url: 'https://hooks.partner.example/a' })).toBe(false);
    for (const path of ['typease', '/a/../../admin', '//evil.example/x', '/a?x=1', '/a#b', '/a b', '/@evil.example', '/a\\b', '/%2e%2e/admin']) expect(hook({ path })).toBe(false);
    expect(hook({ url: 'not a url' })).toBe(false);
    expect(hook({ path: '/a', headers: { Authorization: 'x' } })).toBe(false);
  });

  it('an update cannot switch a rule on or move it to another centre', () => {
    expect(updateAutomationRuleSchema.safeParse({ name: 'New name' }).success).toBe(true);
    expect(updateAutomationRuleSchema.safeParse({ isEnabled: true }).success).toBe(false);
    expect(updateAutomationRuleSchema.safeParse({ tenantId: '5b1d7c2e-1111-4222-8333-444455556666' }).success).toBe(false);
  });
});

describe('automation retry policy', () => {
  it('backs off exponentially from 30 seconds up to one hour', () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(8)).toBe(3_600_000);
    expect(backoffMs(50)).toBe(3_600_000);
    expect(backoffMs(0)).toBe(30_000);
  });

  it('retries what can go away and gives up at once on what cannot', () => {
    // Refusals of a module: trying again will not change the answer.
    expect(classify(Errors.conflict('INVALID_TRANSITION', 'no'))).toMatchObject({ code: 'INVALID_TRANSITION', retryable: false });
    expect(classify(Errors.forbidden('TRANSITION_NOT_ALLOWED', 'no'))).toMatchObject({ retryable: false });
    expect(classify(Errors.unprocessable('DOCUMENTS_NOT_VERIFIED', 'no'))).toMatchObject({ retryable: false });
    expect(classify(Errors.notFound('Request'))).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(classify(Errors.planLimit('automation', 'no'))).toMatchObject({ retryable: false });
    expect(classify(new WebhookRefused('PRIVATE_ADDRESS', 'no'))).toMatchObject({ code: 'PRIVATE_ADDRESS', retryable: false });
    expect(classify(new WebhookFailed('no', false, 404))).toMatchObject({ code: 'WEBHOOK_HTTP_404', retryable: false });
    expect(classify(new ActionError('UNKNOWN_ROLE', 'no', false))).toMatchObject({ code: 'UNKNOWN_ROLE', retryable: false });
    // Things that may be different in a minute.
    expect(classify(Errors.conflict('CONCURRENT_UPDATE', 'busy'))).toMatchObject({ retryable: true });
    expect(classify(Errors.unprocessable('NO_ASSIGNEE_AVAILABLE', 'nobody'))).toMatchObject({ retryable: true });
    expect(classify(Errors.tooMany())).toMatchObject({ retryable: true });
    expect(classify(new AppError(503, 'DOWN', 'down'))).toMatchObject({ retryable: true });
    expect(classify(new WebhookFailed('boom', true, 502))).toMatchObject({ code: 'WEBHOOK_HTTP_502', retryable: true });
    expect(classify(new WebhookFailed('timeout', true))).toMatchObject({ code: 'WEBHOOK_UNREACHABLE', retryable: true });
    expect(classify(new Error('connection terminated unexpectedly'))).toMatchObject({ code: 'UNEXPECTED_ERROR', retryable: true });
  });

  it('recognises events caused by an automation (loop protection)', () => {
    expect(AutomationEngine.causedByAutomation({ payload: { requestId: 'r', _actor: { userId: null, type: 'AUTOMATION' } } })).toBe(true);
    expect(AutomationEngine.causedByAutomation({ payload: { requestId: 'r', _actor: { userId: 'u', type: 'STAFF' } } })).toBe(false);
    expect(AutomationEngine.causedByAutomation({ payload: { requestId: 'r', _actor: { userId: null, type: 'SYSTEM' } } })).toBe(false);
    expect(AutomationEngine.causedByAutomation({ payload: { requestId: 'r' } })).toBe(false);
  });
});
