import { z } from 'zod';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from '@typease/types';
import type { AutomationActionType } from '@typease/types';
import { isoDate, optionalText, rule, trimmed, uuid } from './common';

// ====================================================================== building blocks
export const automationTrigger = z.string().refine((v) => (AUTOMATION_TRIGGERS as string[]).includes(v), 'Choose one of the events that can start an automation');
export const AUTOMATION_ACTION_TYPES = Object.keys(AUTOMATION_ACTIONS) as [AutomationActionType, ...AutomationActionType[]];
export const automationActionType = z.enum(AUTOMATION_ACTION_TYPES);

const roleKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Use the key of one of your staff roles');
const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const requestStatus = z.enum([
  'DRAFT', 'SUBMITTED', 'AWAITING_CUSTOMER', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED',
  'REJECTED', 'FINAL_REVIEW', 'COMPLETED', 'CANCELLED',
]);
/** Text that may contain `{{variables}}` of the trigger (see GET /automations/meta). */
const template = (max: number, min = 1) => trimmed(max, min);
const documentTypeKey = z.string().trim().regex(/^[a-z0-9_]{2,60}$/, 'Use the key of a document type');
export const AUTOMATION_NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH'] as const;

// ====================================================================== per-type action configuration
const createTaskConfig = z
  .object({
    title: template(160, 2),
    description: template(1000).optional(),
    priority: priority.default('NORMAL'),
    type: z.enum(['GENERAL', 'DOCUMENT_REVIEW', 'APPROVAL']).default('GENERAL'),
    /** The task appears in the queue of this role; members of the role claim it. Empty = visible to everyone who manages tasks. */
    roleKey: roleKey.optional(),
    /** Due this many hours after the automation ran. */
    dueInHours: z.number().int().min(1).max(2160).optional(),
  })
  .strict();

const createFollowUpConfig = z
  .object({
    title: template(160, 2),
    description: template(1000).optional(),
    priority: priority.default('NORMAL'),
    roleKey: roleKey.optional(),
    /** A follow-up always has a due date: this many days after the automation ran (0 = the same day). */
    dueInDays: z.number().int().min(0).max(365).default(2),
  })
  .strict();

const assignStaffConfig = z.discriminatedUnion('mode', [
  /** The best available operator, chosen by the requests module (skills, shifts, workload). */
  z.object({ mode: z.literal('AUTO') }).strict(),
  /** One specific member of staff. */
  z.object({ mode: z.literal('MEMBER'), membershipId: uuid, role: z.enum(['OPERATOR', 'REVIEWER']).default('OPERATOR') }).strict(),
]);

const sendNotificationConfig = z
  .object({
    /** CUSTOMER: the customer of the request / event. ASSIGNEE: the operator of the request. ROLE: every active holder of `roleKey`. */
    to: z.enum(['CUSTOMER', 'ASSIGNEE', 'ROLE']),
    roleKey: roleKey.optional(),
    channels: z
      .array(z.enum(AUTOMATION_NOTIFICATION_CHANNELS))
      .min(1, 'Choose at least one channel')
      .max(5)
      .transform((list) => [...new Set(list)]),
    subject: template(200).optional(),
    body: template(2000, 2),
    /** MARKETING messages need the customer's marketing consent; they are suppressed without it. */
    purpose: z.enum(['SERVICE', 'MARKETING']).default('SERVICE'),
    /** Name of the template approved by Meta. Required for the WHATSAPP channel to send anything. */
    whatsappTemplateName: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.to === 'ROLE' && !v.roleKey) c.addIssue({ code: 'custom', path: ['roleKey'], message: 'Choose the role that should be notified' });
    if (v.to !== 'ROLE' && v.roleKey) c.addIssue({ code: 'custom', path: ['roleKey'], message: 'A role is only used when the message goes to a role' });
    if (!v.subject && v.channels.some((ch) => ch === 'EMAIL' || ch === 'IN_APP' || ch === 'PUSH')) c.addIssue({ code: 'custom', path: ['subject'], message: 'Email, in-app and push messages need a subject' });
    if (v.to !== 'CUSTOMER' && v.purpose === 'MARKETING') c.addIssue({ code: 'custom', path: ['purpose'], message: 'Only messages to customers can be marketing messages' });
  });

const scheduleReminderConfig = z
  .object({
    /** Default: the type of the document in the event. */
    documentTypeKey: documentTypeKey.optional(),
    /** Used when the event carries no expiry date: the document expires this many days from now. */
    expiryInDays: z.number().int().min(1).max(3650).optional(),
    /** Days before the expiry date at which to remind. Default: the centre's own offsets. */
    offsetsDays: z.array(z.number().int().min(0).max(730)).min(1).max(12).optional(),
    subjectLabel: trimmed(120, 1).optional(),
  })
  .strict();

const generateDocumentConfig = z
  .object({
    title: template(160).optional(),
    documentTypeKey: documentTypeKey.default('other'),
    customerVisible: z.boolean().default(false),
  })
  .strict();

const updateWorkflowStateConfig = z
  .object({
    /** Only the automatic steps of a request can be performed by an automation; every guard of the request still applies. */
    to: requestStatus,
    reason: trimmed(500, 3).optional(),
    customerMessage: trimmed(500, 1).optional(),
  })
  .strict();

const requestApprovalConfig = z.object({ note: trimmed(500, 1).optional() }).strict();

const escalateConfig = z
  .object({
    roleKey: roleKey.default('manager'),
    title: template(160, 2).optional(),
    message: template(1000).optional(),
    priority: z.enum(['HIGH', 'URGENT']).default('HIGH'),
    dueInHours: z.number().int().min(1).max(720).optional(),
  })
  .strict();

const callWebhookConfig = z
  .object({
    /** Path below the n8n webhook base address of the centre (or of the platform), e.g. "/typease/new-request". */
    path: z
      .string()
      .trim()
      .regex(/^\/[A-Za-z0-9\-._~/]{1,200}$/, 'Use a path such as /typease/new-request')
      .refine((v) => !v.includes('..') && !v.includes('//'), 'The path must not contain ".." or "//"')
      .optional(),
    /** A complete address on a host approved by the platform operator. */
    url: z.string().trim().url().max(500).optional(),
  })
  .strict()
  .refine((v) => (v.path ? 1 : 0) + (v.url ? 1 : 0) === 1, { message: 'Give either a path below your n8n address or a complete URL', path: ['path'] });

export const AUTOMATION_ACTION_CONFIG = {
  create_task: createTaskConfig,
  create_follow_up: createFollowUpConfig,
  assign_staff: assignStaffConfig,
  send_notification: sendNotificationConfig,
  schedule_reminder: scheduleReminderConfig,
  generate_document: generateDocumentConfig,
  update_workflow_state: updateWorkflowStateConfig,
  request_approval: requestApprovalConfig,
  escalate: escalateConfig,
  call_webhook: callWebhookConfig,
} satisfies Record<AutomationActionType, z.ZodTypeAny>;

export type AutomationActionConfig = {
  create_task: z.infer<typeof createTaskConfig>;
  create_follow_up: z.infer<typeof createFollowUpConfig>;
  assign_staff: z.infer<typeof assignStaffConfig>;
  send_notification: z.infer<typeof sendNotificationConfig>;
  schedule_reminder: z.infer<typeof scheduleReminderConfig>;
  generate_document: z.infer<typeof generateDocumentConfig>;
  update_workflow_state: z.infer<typeof updateWorkflowStateConfig>;
  request_approval: z.infer<typeof requestApprovalConfig>;
  escalate: z.infer<typeof escalateConfig>;
  call_webhook: z.infer<typeof callWebhookConfig>;
};
export type AutomationAction = { [K in AutomationActionType]: { type: K; config: AutomationActionConfig[K] } }[AutomationActionType];

/** `{ type, config }`: the config is validated against the schema of its type. */
export const automationAction = z
  .object({ type: automationActionType, config: z.record(z.unknown()).default({}) })
  .strict()
  .transform((value, c): AutomationAction => {
    const parsed = (AUTOMATION_ACTION_CONFIG[value.type] as z.ZodTypeAny).safeParse(value.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) c.addIssue({ ...issue, path: ['config', ...issue.path] });
      return z.NEVER;
    }
    return { type: value.type, config: parsed.data } as AutomationAction;
  });
export const automationActions = z.array(automationAction).min(1, 'Add at least one action').max(10);

// ====================================================================== rules
export const createAutomationRuleSchema = z
  .object({
    name: trimmed(120, 2),
    description: optionalText(500),
    triggerEvent: automationTrigger,
    conditions: rule.default({}),
    actions: automationActions,
    /** New rules are switched off unless asked otherwise; enabling validates that the rule can run. */
    isEnabled: z.boolean().default(false),
    /** How often a failed execution is tried again before it goes to the dead-letter list. */
    maxRetries: z.number().int().min(0).max(10).default(3),
  })
  .strict();
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;

export const updateAutomationRuleSchema = z
  .object({
    name: trimmed(120, 2).optional(),
    description: optionalText(500),
    triggerEvent: automationTrigger.optional(),
    conditions: rule.optional(),
    actions: automationActions.optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
  })
  .strict();
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;

export const automationFromTemplateSchema = z.object({ name: trimmed(120, 2).optional() }).strict();
export type AutomationFromTemplateInput = z.infer<typeof automationFromTemplateSchema>;

export const automationRuleListQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(120).optional(),
    triggerEvent: automationTrigger.optional(),
    enabled: z.enum(['true', 'false']).optional(),
  })
  .strict();
export type AutomationRuleListQuery = z.infer<typeof automationRuleListQuery>;

/** Dry run: against a named event, or against the most recent event of the rule's trigger. */
export const automationTestSchema = z.object({ eventId: uuid.optional() }).strict();
export type AutomationTestInput = z.infer<typeof automationTestSchema>;

export const automationExecutionStatus = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'DEAD_LETTER']);
export const automationExecutionListQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    ruleId: uuid.optional(),
    status: automationExecutionStatus.optional(),
    eventType: automationTrigger.optional(),
    /** Calendar days (UTC), both included. */
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .strict();
export type AutomationExecutionListQuery = z.infer<typeof automationExecutionListQuery>;
