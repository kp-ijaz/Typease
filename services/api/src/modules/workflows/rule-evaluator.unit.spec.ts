import { WORKFLOW_FACTS } from '@typease/types';
import type { Rule, RuleOp } from '@typease/types';
import { checkRule, evaluateCondition, evaluateRule, RULE_OPS, ruleConditions } from './rule-evaluator';

const facts = {
  'service.code': 'VISA-NEW',
  'service.requiresApproval': true,
  'service.complianceCapability': 'DIRECT_AUTHORISED',
  'customer.isCorporate': false,
  'request.priority': 'URGENT',
  'quotation.total': 350.5,
  'payment.status': 'PAID',
  'approval.result': null,
  'documents.tags': ['passport', 'photo'],
};
const c = (fact: string, op: RuleOp, value?: unknown) => evaluateCondition({ fact, op, value }, facts);

describe('workflow rule evaluator', () => {
  it('covers every operator of the rule language', () => {
    expect([...RULE_OPS].sort()).toEqual(['eq', 'exists', 'gt', 'gte', 'in', 'lt', 'lte', 'neq', 'nin', 'truthy']);
  });

  it('eq / neq compare values, treating 5 and "5" alike but never coercing booleans or null', () => {
    expect(c('service.code', 'eq', 'VISA-NEW')).toBe(true);
    expect(c('service.code', 'eq', 'visa-new')).toBe(false);
    expect(c('quotation.total', 'eq', '350.5')).toBe(true);
    expect(c('service.requiresApproval', 'eq', true)).toBe(true);
    expect(c('service.requiresApproval', 'eq', 'true')).toBe(false);
    expect(c('service.requiresApproval', 'eq', 1)).toBe(false);
    expect(c('approval.result', 'eq', null)).toBe(true);
    expect(c('missing.fact', 'eq', 'x')).toBe(false);
    expect(c('service.code', 'neq', 'OTHER')).toBe(true);
    expect(c('service.code', 'neq', 'VISA-NEW')).toBe(false);
    expect(c('missing.fact', 'neq', 'x')).toBe(true);
  });

  it('in / nin test list membership and need a list', () => {
    expect(c('service.complianceCapability', 'in', ['PARTNER_COORDINATION', 'DIRECT_AUTHORISED'])).toBe(true);
    expect(c('service.complianceCapability', 'in', ['INFORMATIONAL_ONLY'])).toBe(false);
    expect(c('service.complianceCapability', 'in', 'DIRECT_AUTHORISED')).toBe(false);
    expect(c('documents.tags', 'in', ['photo'])).toBe(true);
    expect(c('documents.tags', 'in', ['visa'])).toBe(false);
    expect(c('request.priority', 'nin', ['LOW', 'NORMAL'])).toBe(true);
    expect(c('request.priority', 'nin', ['URGENT'])).toBe(false);
    expect(c('request.priority', 'nin', 'URGENT')).toBe(false);
    expect(c('missing.fact', 'nin', ['x'])).toBe(true);
  });

  it('gt / gte / lt / lte compare numbers only', () => {
    expect(c('quotation.total', 'gt', 350)).toBe(true);
    expect(c('quotation.total', 'gt', 350.5)).toBe(false);
    expect(c('quotation.total', 'gte', 350.5)).toBe(true);
    expect(c('quotation.total', 'gte', '351')).toBe(false);
    expect(c('quotation.total', 'lt', 1000)).toBe(true);
    expect(c('quotation.total', 'lt', 350.5)).toBe(false);
    expect(c('quotation.total', 'lte', 350.5)).toBe(true);
    expect(c('quotation.total', 'lte', 10)).toBe(false);
    // Non-numeric operands never satisfy an ordering comparison.
    expect(c('service.code', 'gt', 1)).toBe(false);
    expect(c('quotation.total', 'lt', 'abc')).toBe(false);
    expect(c('missing.fact', 'lte', 5)).toBe(false);
    expect(c('service.requiresApproval', 'gte', 1)).toBe(false);
  });

  it('exists checks for a value (null and unknown facts do not exist)', () => {
    expect(c('service.code', 'exists')).toBe(true);
    expect(c('customer.isCorporate', 'exists')).toBe(true);
    expect(c('approval.result', 'exists')).toBe(false);
    expect(c('missing.fact', 'exists')).toBe(false);
    expect(c('approval.result', 'exists', false)).toBe(true);
    expect(c('service.code', 'exists', false)).toBe(false);
  });

  it('truthy follows the value, with empty lists counting as false', () => {
    expect(c('service.requiresApproval', 'truthy')).toBe(true);
    expect(c('customer.isCorporate', 'truthy')).toBe(false);
    expect(c('customer.isCorporate', 'truthy', false)).toBe(true);
    expect(c('missing.fact', 'truthy')).toBe(false);
    expect(c('documents.tags', 'truthy')).toBe(true);
    expect(evaluateCondition({ fact: 'x', op: 'truthy' }, { x: [] })).toBe(false);
  });

  it('an unknown operator can never be satisfied', () => {
    expect(evaluateCondition({ fact: 'service.code', op: 'matches' as RuleOp, value: '.*' }, facts)).toBe(false);
  });

  it('combines conditions: all must hold, and one of any when given', () => {
    expect(evaluateRule(null, facts)).toBe(true);
    expect(evaluateRule(undefined, facts)).toBe(true);
    expect(evaluateRule({}, facts)).toBe(true);
    expect(evaluateRule({ all: [], any: [] }, facts)).toBe(true);
    const urgent = { fact: 'request.priority', op: 'eq', value: 'URGENT' } as const;
    const corporate = { fact: 'customer.isCorporate', op: 'truthy' } as const;
    const paid = { fact: 'payment.status', op: 'eq', value: 'PAID' } as const;
    expect(evaluateRule({ all: [urgent, paid] }, facts)).toBe(true);
    expect(evaluateRule({ all: [urgent, corporate] }, facts)).toBe(false);
    expect(evaluateRule({ any: [corporate, paid] }, facts)).toBe(true);
    expect(evaluateRule({ any: [corporate] }, facts)).toBe(false);
    expect(evaluateRule({ all: [urgent], any: [corporate] }, facts)).toBe(false);
    expect(evaluateRule({ all: [urgent], any: [corporate, paid] }, facts)).toBe(true);
    expect(evaluateRule({ all: [corporate], any: [paid] }, facts)).toBe(false);
  });

  it('reports unknown facts and malformed conditions when a rule is saved', () => {
    const rule: Rule = {
      all: [{ fact: 'service.code', op: 'eq', value: 'A' }, { fact: 'customer.shoeSize', op: 'gt', value: 5 }],
      any: [{ fact: 'request.priority', op: 'in', value: 'URGENT' }, { fact: 'quotation.total', op: 'gte', value: 'lots' }, { fact: 'branch.code', op: 'eq' }],
    };
    expect(ruleConditions(rule)).toHaveLength(5);
    const problems = checkRule(rule, WORKFLOW_FACTS);
    expect(problems.map((p) => p.code)).toEqual(['UNKNOWN_FACT', 'INVALID_RULE', 'INVALID_RULE', 'INVALID_RULE']);
    expect(problems[0].message).toContain('customer.shoeSize');
    expect(checkRule({ all: [{ fact: 'service.requiresApproval', op: 'truthy' }] }, WORKFLOW_FACTS)).toEqual([]);
    expect(checkRule({ all: [{ fact: 'service.code', op: 'like' as RuleOp, value: 'x' }] }, WORKFLOW_FACTS)[0].code).toBe('INVALID_RULE');
    expect(checkRule(null, WORKFLOW_FACTS)).toEqual([]);
  });
});
