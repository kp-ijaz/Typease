import { z } from 'zod';
import { optionalText, rule, trimmed } from './common';

/** Step types of the workflow engine (mirror of the WorkflowStepType database enum). */
export const WORKFLOW_STEP_TYPES = [
  'CUSTOMER_FORM',
  'DOCUMENT_UPLOAD',
  'STAFF_VERIFICATION',
  'INTERNAL_APPROVAL',
  'CUSTOMER_APPROVAL',
  'QUOTATION',
  'PAYMENT',
  'STAFF_TASK',
  'EXTERNAL_PROCESSING',
  'NOTIFICATION',
  'DOCUMENT_GENERATION',
  'COMPLETION',
  'CONDITIONAL_BRANCH',
] as const;

/** Keys of the code-defined templates every centre starts with. */
export const WORKFLOW_TEMPLATE_KEYS = ['standard', 'walk-in-express', 'pay-on-completion'] as const;

export const WORKFLOW_LIMITS = { maxSteps: 40, maxBranches: 10, minTimeoutHours: 1, maxTimeoutHours: 2160, maxConfigBytes: 4000 } as const;

const workflowKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use 2-40 lowercase letters, numbers or hyphens, starting with a letter');
const workflowStepKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,39}$/, 'Use 2-40 lowercase letters, numbers, hyphens or underscores, starting with a letter');
const roleKey = z.string().trim().min(1).max(60);

/**
 * One step as edited in the builder. Shape checks only: the cross-step rules
 * (reachability, ordering, roles, facts, timeouts) are enforced by the workflow
 * validator on the server so that all problems are reported together.
 */
export const workflowStepSchema = z.object({
  key: workflowStepKey,
  name: trimmed(120, 2),
  nameAr: optionalText(120),
  type: z.enum(WORKFLOW_STEP_TYPES),
  /** Type-specific settings, e.g. { message } for NOTIFICATION or { optional: true } for DOCUMENT_GENERATION. */
  config: z
    .record(z.unknown())
    .default({})
    .refine((v) => JSON.stringify(v).length <= WORKFLOW_LIMITS.maxConfigBytes, 'Step settings are too large'),
  /** The step is skipped when this rule is false. */
  conditions: rule.nullish(),
  /** CONDITIONAL_BRANCH only: first matching rule wins, otherwise nextStepKey. */
  branches: z
    .array(z.object({ when: rule, goTo: workflowStepKey }))
    .max(WORKFLOW_LIMITS.maxBranches)
    .nullish(),
  /** Default: the next step in order. */
  nextStepKey: workflowStepKey.nullish(),
  onRejectStepKey: workflowStepKey.nullish(),
  assigneeRoleKey: roleKey.nullish(),
  timeoutHours: z.number().int().nullish(),
  escalateToRoleKey: roleKey.nullish(),
  customerVisible: z.boolean().default(true),
});
export type WorkflowStepBody = z.infer<typeof workflowStepSchema>;

const workflowSteps = z.array(workflowStepSchema).max(WORKFLOW_LIMITS.maxSteps);

/** Create a workflow from a code template or from scratch (always starts as a draft unless `publish` is set). */
export const createWorkflowSchema = z
  .object({
    key: workflowKey,
    name: trimmed(120, 2),
    description: optionalText(500),
    templateKey: z.enum(WORKFLOW_TEMPLATE_KEYS).optional(),
    steps: workflowSteps.optional(),
    publish: z.boolean().default(false),
  })
  .refine((v) => !(v.templateKey && v.steps), { message: 'Send either templateKey or steps, not both', path: ['steps'] })
  .refine((v) => !!v.templateKey || (v.steps?.length ?? 0) > 0, { message: 'Choose a template or add at least one step', path: ['steps'] });
export type CreateWorkflowBody = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z.object({
  name: trimmed(120, 2).optional(),
  description: optionalText(500),
});
export type UpdateWorkflowBody = z.infer<typeof updateWorkflowSchema>;

/** Replace all steps of a DRAFT version (the array order is the step order). */
export const replaceWorkflowStepsSchema = z.object({
  steps: workflowSteps.min(1, 'A workflow needs at least one step'),
  notes: optionalText(500),
});
export type ReplaceWorkflowStepsBody = z.infer<typeof replaceWorkflowStepsSchema>;

export const workflowVersionNotesSchema = z.object({ notes: optionalText(500) });
export type WorkflowVersionNotesBody = z.infer<typeof workflowVersionNotesSchema>;

/** Dry-run validation of a step list (no changes are saved). */
export const validateWorkflowStepsSchema = z.object({ steps: workflowSteps });
export type ValidateWorkflowStepsBody = z.infer<typeof validateWorkflowStepsSchema>;

export const workflowListQuery = z.object({
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});
export type WorkflowListQuery = z.infer<typeof workflowListQuery>;
