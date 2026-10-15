import { SYSTEM_ROLES } from '@typease/permissions';
import { WORKFLOW_TEMPLATES } from './workflow-templates';
import { defaultNextKey, validateWorkflow, WorkflowStepDef } from './workflow-validator';

const roleKeys = Object.values(SYSTEM_ROLES).filter((r) => r.kind === 'STAFF').map((r) => r.key);
const check = (steps: WorkflowStepDef[]) => validateWorkflow(steps, { roleKeys });
const codes = (steps: WorkflowStepDef[]) => check(steps).errors.map((e) => e.code);
const s = (key: string, type: WorkflowStepDef['type'], extra: Partial<WorkflowStepDef> = {}): WorkflowStepDef => ({ key, name: key, type, ...extra });

/** The smallest valid workflow. */
const minimal = () => [s('task', 'STAFF_TASK'), s('done', 'COMPLETION')];
const full = () => [
  s('docs', 'DOCUMENT_UPLOAD'),
  s('verify', 'STAFF_VERIFICATION'),
  s('quote', 'QUOTATION'),
  s('approve', 'CUSTOMER_APPROVAL'),
  s('pay', 'PAYMENT'),
  s('task', 'STAFF_TASK'),
  s('review', 'INTERNAL_APPROVAL'),
  s('submit', 'EXTERNAL_PROCESSING'),
  s('done', 'COMPLETION'),
];

describe('workflow validator', () => {
  it('accepts every built-in template', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const result = check(template.steps);
      expect({ template: template.key, errors: result.errors }).toEqual({ template: template.key, errors: [] });
    }
  });

  it('the templates have the documented shape', () => {
    const types = (key: string) => WORKFLOW_TEMPLATES.find((t) => t.key === key)!.steps.map((x) => x.type);
    expect(types('standard')).toEqual(['CUSTOMER_FORM', 'DOCUMENT_UPLOAD', 'STAFF_VERIFICATION', 'QUOTATION', 'CUSTOMER_APPROVAL', 'PAYMENT', 'STAFF_TASK', 'INTERNAL_APPROVAL', 'EXTERNAL_PROCESSING', 'COMPLETION']);
    expect(types('walk-in-express')).toEqual(['DOCUMENT_UPLOAD', 'STAFF_VERIFICATION', 'QUOTATION', 'CUSTOMER_APPROVAL', 'PAYMENT', 'STAFF_TASK', 'COMPLETION']);
    const late = types('pay-on-completion');
    expect(late.indexOf('PAYMENT')).toBe(late.indexOf('COMPLETION') - 1);
    const standard = WORKFLOW_TEMPLATES.find((t) => t.key === 'standard')!.steps;
    expect(standard.find((x) => x.type === 'INTERNAL_APPROVAL')!.conditions).toEqual({ all: [{ fact: 'service.requiresApproval', op: 'truthy' }] });
    expect(standard.find((x) => x.type === 'EXTERNAL_PROCESSING')!.conditions).toEqual({ all: [{ fact: 'service.complianceCapability', op: 'in', value: ['PARTNER_COORDINATION', 'DIRECT_AUTHORISED'] }] });
  });

  it('accepts a minimal and a full workflow', () => {
    expect(check(minimal())).toEqual({ valid: true, errors: [] });
    expect(check(full())).toEqual({ valid: true, errors: [] });
  });

  it('needs at least one step', () => {
    expect(codes([])).toEqual(['NO_STEPS']);
  });

  it('needs exactly one Completion step, at the end, without a condition', () => {
    expect(codes([s('task', 'STAFF_TASK')])).toContain('COMPLETION_COUNT');
    expect(codes([s('task', 'STAFF_TASK'), s('a', 'COMPLETION'), s('b', 'COMPLETION')])).toContain('COMPLETION_COUNT');
    expect(codes([s('task', 'STAFF_TASK'), s('done', 'COMPLETION'), s('note', 'NOTIFICATION')])).toContain('COMPLETION_NOT_LAST');
    expect(codes([s('task', 'STAFF_TASK'), s('done', 'COMPLETION', { conditions: { all: [{ fact: 'customer.isCorporate', op: 'truthy' }] } })])).toContain('COMPLETION_CONDITIONAL');
  });

  it('rejects duplicate keys and references to steps that do not exist', () => {
    expect(codes([s('task', 'STAFF_TASK'), s('task', 'NOTIFICATION'), s('done', 'COMPLETION')])).toContain('DUPLICATE_KEY');
    expect(codes([s('task', 'STAFF_TASK', { nextStepKey: 'nowhere' }), s('done', 'COMPLETION')])).toContain('UNKNOWN_STEP_REFERENCE');
    expect(codes([s('task', 'STAFF_TASK'), s('review', 'INTERNAL_APPROVAL', { onRejectStepKey: 'ghost' }), s('done', 'COMPLETION')])).toContain('UNKNOWN_STEP_REFERENCE');
    expect(codes([s('task', 'STAFF_TASK'), s('branch', 'CONDITIONAL_BRANCH', { branches: [{ when: { all: [{ fact: 'customer.isCorporate', op: 'truthy' }] }, goTo: 'ghost' }] }), s('done', 'COMPLETION')])).toContain('UNKNOWN_STEP_REFERENCE');
  });

  it('only allows cycles through "on reject" or a branch back to an earlier Staff task / Quotation', () => {
    // The default flow may not point backwards.
    expect(codes([s('task', 'STAFF_TASK'), s('note', 'NOTIFICATION', { nextStepKey: 'task' }), s('done', 'COMPLETION')])).toContain('CYCLE');
    expect(codes([s('task', 'STAFF_TASK', { nextStepKey: 'task' }), s('done', 'COMPLETION')])).toContain('CYCLE');
    // Allowed back-edges.
    expect(check([s('task', 'STAFF_TASK'), s('review', 'INTERNAL_APPROVAL', { onRejectStepKey: 'task' }), s('done', 'COMPLETION')]).valid).toBe(true);
    expect(check([s('quote', 'QUOTATION'), s('approve', 'CUSTOMER_APPROVAL', { onRejectStepKey: 'quote' }), s('task', 'STAFF_TASK'), s('done', 'COMPLETION')]).valid).toBe(true);
    const branchBack = (target: string) => [
      s('docs', 'DOCUMENT_UPLOAD'),
      s('quote', 'QUOTATION'),
      s('task', 'STAFF_TASK'),
      s('branch', 'CONDITIONAL_BRANCH', { branches: [{ when: { all: [{ fact: 'approval.result', op: 'eq', value: 'REJECTED' }] }, goTo: target }] }),
      s('done', 'COMPLETION'),
    ];
    expect(check(branchBack('task')).valid).toBe(true);
    expect(check(branchBack('quote')).valid).toBe(true);
    expect(codes(branchBack('docs'))).toContain('CYCLE');
    expect(codes(branchBack('branch'))).toContain('CYCLE');
    // "On reject" must go back, to the right kind of step, and only from an approval.
    expect(codes([s('task', 'STAFF_TASK'), s('review', 'INTERNAL_APPROVAL', { onRejectStepKey: 'done' }), s('done', 'COMPLETION')])).toContain('CYCLE');
    expect(codes([s('docs', 'DOCUMENT_UPLOAD'), s('task', 'STAFF_TASK'), s('review', 'INTERNAL_APPROVAL', { onRejectStepKey: 'docs' }), s('done', 'COMPLETION')])).toContain('CYCLE');
    expect(codes([s('task', 'STAFF_TASK'), s('note', 'NOTIFICATION', { onRejectStepKey: 'task' }), s('done', 'COMPLETION')])).toContain('ON_REJECT_NOT_ALLOWED');
  });

  it('enforces the order of quotation, approval, payment, preparation and submission', () => {
    expect(codes([s('approve', 'CUSTOMER_APPROVAL'), s('quote', 'QUOTATION'), s('task', 'STAFF_TASK'), s('done', 'COMPLETION')])).toContain('QUOTATION_REQUIRED');
    expect(codes([s('pay', 'PAYMENT'), s('task', 'STAFF_TASK'), s('done', 'COMPLETION')])).toContain('PAYMENT_REQUIRES_QUOTATION');
    expect(codes([s('pay', 'PAYMENT'), s('quote', 'QUOTATION'), s('task', 'STAFF_TASK'), s('done', 'COMPLETION')])).toContain('PAYMENT_REQUIRES_QUOTATION');
    expect(codes([s('submit', 'EXTERNAL_PROCESSING'), s('task', 'STAFF_TASK'), s('done', 'COMPLETION')])).toContain('EXTERNAL_REQUIRES_STAFF_TASK');
    expect(codes([s('review', 'INTERNAL_APPROVAL'), s('task', 'STAFF_TASK'), s('done', 'COMPLETION')])).toContain('APPROVAL_REQUIRES_STAFF_TASK');
    expect(codes([s('docs', 'DOCUMENT_UPLOAD'), s('done', 'COMPLETION')])).toContain('COMPLETION_REQUIRES_STAFF_TASK');
  });

  it('only accepts roles of the centre', () => {
    expect(codes([s('task', 'STAFF_TASK', { assigneeRoleKey: 'wizard' }), s('done', 'COMPLETION')])).toEqual(['UNKNOWN_ROLE']);
    expect(codes([s('task', 'STAFF_TASK', { escalateToRoleKey: 'customer' }), s('done', 'COMPLETION')])).toEqual(['UNKNOWN_ROLE']);
    expect(check([s('task', 'STAFF_TASK', { assigneeRoleKey: 'operator', escalateToRoleKey: 'manager' }), s('done', 'COMPLETION')]).valid).toBe(true);
    expect(validateWorkflow([s('task', 'STAFF_TASK', { assigneeRoleKey: 'senior-typist' }), s('done', 'COMPLETION')], { roleKeys: [...roleKeys, 'senior-typist'] }).valid).toBe(true);
  });

  it('only accepts known facts and well-formed rules in conditions and branches', () => {
    expect(codes([s('task', 'STAFF_TASK', { conditions: { all: [{ fact: 'customer.salary', op: 'gt', value: 1 }] } }), s('done', 'COMPLETION')])).toEqual(['UNKNOWN_FACT']);
    expect(codes([s('task', 'STAFF_TASK'), s('note', 'NOTIFICATION', { conditions: { any: [{ fact: 'request.priority', op: 'in', value: 'URGENT' }] } }), s('done', 'COMPLETION')])).toEqual(['INVALID_RULE']);
    expect(
      codes([s('task', 'STAFF_TASK'), s('branch', 'CONDITIONAL_BRANCH', { branches: [{ when: { all: [{ fact: 'weather', op: 'eq', value: 'sunny' }] }, goTo: 'done' }] }), s('done', 'COMPLETION')]),
    ).toEqual(['UNKNOWN_FACT']);
  });

  it('limits timeouts to 1..2160 hours', () => {
    for (const bad of [0, -5, 2161, 1.5]) {
      expect(codes([s('task', 'STAFF_TASK', { timeoutHours: bad }), s('done', 'COMPLETION')])).toEqual(['INVALID_TIMEOUT']);
    }
    for (const good of [1, 48, 2160]) {
      expect(check([s('task', 'STAFF_TASK', { timeoutHours: good }), s('done', 'COMPLETION')]).valid).toBe(true);
    }
  });

  it('requires branches on a conditional branch and nowhere else', () => {
    expect(codes([s('task', 'STAFF_TASK'), s('branch', 'CONDITIONAL_BRANCH'), s('done', 'COMPLETION')])).toContain('BRANCHES_REQUIRED');
    expect(codes([s('task', 'STAFF_TASK', { branches: [{ when: {}, goTo: 'done' }] }), s('done', 'COMPLETION')])).toContain('BRANCHES_NOT_ALLOWED');
  });

  it('every step must be reachable and every path must end at Completion', () => {
    // "note" is jumped over by an explicit next step and never referenced.
    expect(codes([s('task', 'STAFF_TASK', { nextStepKey: 'done' }), s('note', 'NOTIFICATION'), s('done', 'COMPLETION')])).toEqual(['UNREACHABLE_STEP']);
    // A branch target keeps the step reachable.
    expect(
      check([
        s('task', 'STAFF_TASK'),
        s('branch', 'CONDITIONAL_BRANCH', { nextStepKey: 'done', branches: [{ when: { all: [{ fact: 'customer.isCorporate', op: 'truthy' }] }, goTo: 'note' }] }),
        s('note', 'NOTIFICATION'),
        s('done', 'COMPLETION'),
      ]).valid,
    ).toBe(true);
  });

  it('reports all problems at once, each with the step it belongs to', () => {
    const result = check([s('pay', 'PAYMENT', { timeoutHours: 9999, assigneeRoleKey: 'nobody' }), s('done', 'COMPLETION')]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code).sort()).toEqual(['COMPLETION_REQUIRES_STAFF_TASK', 'INVALID_TIMEOUT', 'PAYMENT_REQUIRES_QUOTATION', 'UNKNOWN_ROLE']);
    expect(result.errors.find((e) => e.code === 'INVALID_TIMEOUT')!.stepKey).toBe('pay');
    expect(result.errors.every((e) => e.message.length > 10)).toBe(true);
  });

  it('defaultNextKey follows nextStepKey, then the order of the steps', () => {
    const steps = [s('a', 'STAFF_TASK', { nextStepKey: 'c' }), s('b', 'NOTIFICATION'), s('c', 'COMPLETION')];
    expect(defaultNextKey(steps, 0)).toBe('c');
    expect(defaultNextKey(steps, 1)).toBe('c');
    expect(defaultNextKey(steps, 2)).toBeNull();
  });
});
