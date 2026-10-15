import type { Rule, RuleCondition, RuleOp } from '@typease/types';

/**
 * Pure evaluator for the workflow rule language:
 *
 *     { all?: Condition[], any?: Condition[] }   Condition = { fact, op, value }
 *
 * `all` must all hold, and (when present) at least one of `any` must hold.
 * An absent or empty rule is true. Facts are looked up by their dotted name in
 * a flat object ("service.code"); an unknown fact is `undefined`, which makes
 * every comparison except `neq`, `nin`, `exists(false)` and `truthy(false)` false.
 */
export type Facts = Record<string, unknown>;

export const RULE_OPS: readonly RuleOp[] = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists', 'truthy'];

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Equality that treats 5 and "5" as equal but never coerces booleans or null. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = toNumber(a);
    const y = toNumber(b);
    return x !== null && y !== null && x === y;
  }
  return false;
}

function inList(fact: unknown, list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  // A multi-valued fact matches when any of its values is listed.
  if (Array.isArray(fact)) return fact.some((f) => list.some((v) => same(f, v)));
  return list.some((v) => same(fact, v));
}

function compare(fact: unknown, value: unknown, test: (a: number, b: number) => boolean): boolean {
  const a = toNumber(fact);
  const b = toNumber(value);
  return a !== null && b !== null && test(a, b);
}

export function evaluateCondition(condition: RuleCondition, facts: Facts): boolean {
  const fact = facts[condition.fact];
  switch (condition.op) {
    case 'eq':
      return same(fact, condition.value);
    case 'neq':
      return !same(fact, condition.value);
    case 'in':
      return inList(fact, condition.value);
    case 'nin':
      return Array.isArray(condition.value) && !inList(fact, condition.value);
    case 'gt':
      return compare(fact, condition.value, (a, b) => a > b);
    case 'gte':
      return compare(fact, condition.value, (a, b) => a >= b);
    case 'lt':
      return compare(fact, condition.value, (a, b) => a < b);
    case 'lte':
      return compare(fact, condition.value, (a, b) => a <= b);
    case 'exists': {
      const exists = fact !== undefined && fact !== null;
      return condition.value === false ? !exists : exists;
    }
    case 'truthy': {
      const truthy = Array.isArray(fact) ? fact.length > 0 : !!fact;
      return condition.value === false ? !truthy : truthy;
    }
    default:
      // An operator this version does not know can never be satisfied (fail closed).
      return false;
  }
}

export function evaluateRule(rule: Rule | null | undefined, facts: Facts): boolean {
  if (!rule) return true;
  const all = rule.all ?? [];
  const any = rule.any ?? [];
  if (!all.every((c) => evaluateCondition(c, facts))) return false;
  if (any.length && !any.some((c) => evaluateCondition(c, facts))) return false;
  return true;
}

export function ruleConditions(rule: Rule | null | undefined): RuleCondition[] {
  return rule ? [...(rule.all ?? []), ...(rule.any ?? [])] : [];
}

export interface RuleProblem {
  code: 'UNKNOWN_FACT' | 'INVALID_RULE';
  message: string;
}

/** Static checks used when a workflow is saved: known facts, known operators, list operands. */
export function checkRule(rule: Rule | null | undefined, allowedFacts: readonly string[]): RuleProblem[] {
  const problems: RuleProblem[] = [];
  for (const c of ruleConditions(rule)) {
    if (!allowedFacts.includes(c.fact)) problems.push({ code: 'UNKNOWN_FACT', message: `"${c.fact}" is not a fact that workflow rules can use.` });
    if (!RULE_OPS.includes(c.op)) problems.push({ code: 'INVALID_RULE', message: `"${String(c.op)}" is not a supported comparison.` });
    else if ((c.op === 'in' || c.op === 'nin') && !Array.isArray(c.value)) problems.push({ code: 'INVALID_RULE', message: `The "${c.op}" comparison on "${c.fact}" needs a list of values.` });
    else if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && toNumber(c.value) === null) problems.push({ code: 'INVALID_RULE', message: `The "${c.op}" comparison on "${c.fact}" needs a number.` });
    else if ((c.op === 'eq' || c.op === 'neq') && c.value === undefined) problems.push({ code: 'INVALID_RULE', message: `The "${c.op}" comparison on "${c.fact}" needs a value.` });
  }
  return problems;
}
