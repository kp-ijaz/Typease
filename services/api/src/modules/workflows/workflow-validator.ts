import type { Rule, WorkflowStepType } from '@typease/types';
import { WORKFLOW_FACTS } from '@typease/types';
import { checkRule } from './rule-evaluator';

/** A workflow step as stored in workflow_steps (the array order is the step order). */
export interface WorkflowStepDef {
  key: string;
  name: string;
  nameAr?: string | null;
  type: WorkflowStepType;
  config?: Record<string, unknown> | null;
  conditions?: Rule | null;
  branches?: Array<{ when: Rule; goTo: string }> | null;
  nextStepKey?: string | null;
  onRejectStepKey?: string | null;
  assigneeRoleKey?: string | null;
  timeoutHours?: number | null;
  escalateToRoleKey?: string | null;
  customerVisible?: boolean;
}

export interface WorkflowProblem {
  code: string;
  stepKey?: string;
  message: string;
}
export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowProblem[];
}

export const TIMEOUT_MIN_HOURS = 1;
export const TIMEOUT_MAX_HOURS = 2160;
/** Steps a rejection or an explicit branch may send a case back to. */
const BACK_EDGE_TARGETS: WorkflowStepType[] = ['STAFF_TASK', 'QUOTATION'];
/** Which earlier step type a rejection of each approval type may return to. */
const REJECT_TARGET: Partial<Record<WorkflowStepType, WorkflowStepType>> = { INTERNAL_APPROVAL: 'STAFF_TASK', CUSTOMER_APPROVAL: 'QUOTATION' };

/** The step that follows `index` when nothing else is configured. */
export function defaultNextKey(steps: WorkflowStepDef[], index: number): string | null {
  const step = steps[index];
  if (!step) return null;
  if (step.nextStepKey) return step.nextStepKey;
  return steps[index + 1]?.key ?? null;
}

/**
 * Structural validation of a workflow, applied when a draft is saved and again
 * when it is published. Pure: no database, no clock.
 *
 * What this function deliberately does NOT try to do is guarantee compliance.
 * Whatever a centre configures here, the request state machine still enforces
 * review approval, payment policy and the submission-channel rules of the
 * service. A workflow can add steps and waiting points; it cannot remove a guard.
 */
export function validateWorkflow(steps: WorkflowStepDef[], context: { roleKeys: readonly string[]; facts?: readonly string[] }): WorkflowValidationResult {
  const errors: WorkflowProblem[] = [];
  const add = (code: string, message: string, stepKey?: string) => errors.push({ code, message, stepKey });
  const facts = context.facts ?? WORKFLOW_FACTS;

  if (!steps.length) {
    add('NO_STEPS', 'A workflow needs at least one step.');
    return { valid: false, errors };
  }

  // --- keys ---------------------------------------------------------------------------------
  const index = new Map<string, number>();
  steps.forEach((s, i) => {
    if (index.has(s.key)) add('DUPLICATE_KEY', `The step key "${s.key}" is used more than once. Every step needs its own key.`, s.key);
    else index.set(s.key, i);
  });
  const label = (s: WorkflowStepDef) => `"${s.name}"`;

  // --- completion ---------------------------------------------------------------------------
  const completions = steps.filter((s) => s.type === 'COMPLETION');
  if (completions.length !== 1) {
    add('COMPLETION_COUNT', completions.length ? 'A workflow can have only one Completion step.' : 'A workflow must end with a Completion step.');
  } else {
    const completion = completions[0];
    if (steps[steps.length - 1] !== completion) add('COMPLETION_NOT_LAST', 'The Completion step must be the last step.', completion.key);
    if (completion.nextStepKey) add('COMPLETION_NOT_LAST', 'Nothing can follow the Completion step.', completion.key);
    if (completion.conditions && ((completion.conditions.all?.length ?? 0) > 0 || (completion.conditions.any?.length ?? 0) > 0)) {
      add('COMPLETION_CONDITIONAL', 'The Completion step cannot have a condition: every case must be able to finish.', completion.key);
    }
  }

  // --- per-step checks ----------------------------------------------------------------------
  steps.forEach((s, i) => {
    const refs: Array<[string, string | null | undefined]> = [
      ['next step', s.nextStepKey],
      ['"on reject" step', s.onRejectStepKey],
      ...(s.branches ?? []).map((b, n): [string, string] => [`branch ${n + 1}`, b.goTo]),
    ];
    for (const [what, key] of refs) {
      if (key && !index.has(key)) add('UNKNOWN_STEP_REFERENCE', `${label(s)}: the ${what} "${key}" does not exist in this workflow.`, s.key);
    }

    for (const [field, roleKey] of [['assignee role', s.assigneeRoleKey], ['escalation role', s.escalateToRoleKey]] as const) {
      if (roleKey && !context.roleKeys.includes(roleKey)) add('UNKNOWN_ROLE', `${label(s)}: the ${field} "${roleKey}" is not a role of this centre.`, s.key);
    }

    if (s.timeoutHours !== null && s.timeoutHours !== undefined) {
      if (!Number.isInteger(s.timeoutHours) || s.timeoutHours < TIMEOUT_MIN_HOURS || s.timeoutHours > TIMEOUT_MAX_HOURS) {
        add('INVALID_TIMEOUT', `${label(s)}: the time limit must be between ${TIMEOUT_MIN_HOURS} and ${TIMEOUT_MAX_HOURS} hours.`, s.key);
      }
    }

    for (const p of checkRule(s.conditions, facts)) add(p.code, `${label(s)}: ${p.message}`, s.key);
    for (const b of s.branches ?? []) for (const p of checkRule(b.when, facts)) add(p.code, `${label(s)}: ${p.message}`, s.key);

    if (s.type === 'CONDITIONAL_BRANCH') {
      if (!s.branches?.length) add('BRANCHES_REQUIRED', `${label(s)}: a conditional branch needs at least one branch.`, s.key);
    } else if (s.branches?.length) {
      add('BRANCHES_NOT_ALLOWED', `${label(s)}: only Conditional branch steps can have branches.`, s.key);
    }

    // The default flow only moves forward.
    if (s.nextStepKey && index.has(s.nextStepKey) && index.get(s.nextStepKey)! <= i) {
      add('CYCLE', `${label(s)}: the next step must come later in the workflow. Use a branch or "on reject" to send a case back.`, s.key);
    }
    // Explicit back-edges may only return to preparation or quotation.
    for (const b of s.branches ?? []) {
      const target = index.get(b.goTo);
      if (target !== undefined && target <= i && !BACK_EDGE_TARGETS.includes(steps[target].type)) {
        add('CYCLE', `${label(s)}: a branch can only go back to an earlier Staff task or Quotation step.`, s.key);
      }
    }
    if (s.onRejectStepKey && index.has(s.onRejectStepKey)) {
      const expected = REJECT_TARGET[s.type];
      const target = index.get(s.onRejectStepKey)!;
      if (!expected) add('ON_REJECT_NOT_ALLOWED', `${label(s)}: only approval steps can have an "on reject" step.`, s.key);
      else if (target >= i || steps[target].type !== expected) {
        add('CYCLE', `${label(s)}: "on reject" must point to an earlier ${expected === 'STAFF_TASK' ? 'Staff task' : 'Quotation'} step.`, s.key);
      }
    }

    // --- ordering rules that protect the business process -----------------------------------
    const earlier = (type: WorkflowStepType) => steps.slice(0, i).some((x) => x.type === type);
    if (s.type === 'CUSTOMER_APPROVAL' && !earlier('QUOTATION')) add('QUOTATION_REQUIRED', `${label(s)}: a Quotation step must come before customer approval.`, s.key);
    if (s.type === 'PAYMENT' && !earlier('QUOTATION')) add('PAYMENT_REQUIRES_QUOTATION', `${label(s)}: a Quotation step must come before payment, so that an invoice exists.`, s.key);
    if (s.type === 'EXTERNAL_PROCESSING' && !earlier('STAFF_TASK')) add('EXTERNAL_REQUIRES_STAFF_TASK', `${label(s)}: the application must be prepared in a Staff task step before it can be submitted.`, s.key);
    if (s.type === 'INTERNAL_APPROVAL' && !earlier('STAFF_TASK')) add('APPROVAL_REQUIRES_STAFF_TASK', `${label(s)}: a Staff task step must come before review approval.`, s.key);
    if (s.type === 'COMPLETION' && !earlier('STAFF_TASK')) add('COMPLETION_REQUIRES_STAFF_TASK', `${label(s)}: the work must be prepared in a Staff task step before final review.`, s.key);
  });

  // --- reachability: every step is used and every path ends at Completion ---------------------
  if (!errors.some((e) => ['DUPLICATE_KEY', 'UNKNOWN_STEP_REFERENCE', 'COMPLETION_COUNT'].includes(e.code))) {
    const successors = (i: number): Array<string | null> => {
      const s = steps[i];
      if (s.type === 'COMPLETION') return [];
      const out: Array<string | null> = [defaultNextKey(steps, i)];
      for (const b of s.branches ?? []) out.push(b.goTo);
      return out;
    };
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      const i = queue.shift()!;
      for (const key of successors(i)) {
        if (key === null) {
          add('DEAD_END', `${label(steps[i])}: the workflow stops here without reaching the Completion step.`, steps[i].key);
          continue;
        }
        const next = index.get(key)!;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    steps.forEach((s, i) => {
      if (!seen.has(i)) add(s.type === 'COMPLETION' ? 'COMPLETION_UNREACHABLE' : 'UNREACHABLE_STEP', `${label(s)} can never be reached. Remove it or connect it to the flow.`, s.key);
    });
  }

  return { valid: errors.length === 0, errors };
}
