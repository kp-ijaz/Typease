'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Rule, RuleCondition, RuleOp } from '@typease/types';
import { Button, Checkbox, Combobox, Input, Select, cn, useI18n } from '@typease/ui';
import type { FactMeta } from './types';

/**
 * A simple editor for the rule language shared by workflow steps and
 * automations: `{ all?: Condition[], any?: Condition[] }`, each condition
 * `{ fact, op, value }`. No free-form expressions: the person picks a fact,
 * a comparison in plain words and a value. Used by both builders.
 */

const DEFAULT_OPERATORS: RuleOp[] = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists', 'truthy'];
const NUMERIC_OPS: RuleOp[] = ['gt', 'gte', 'lt', 'lte'];
const LIST_OPS: RuleOp[] = ['in', 'nin'];
const NO_VALUE_OPS: RuleOp[] = ['exists', 'truthy'];

/** What is known about the facts of workflow conditions (the builder-meta endpoint lists only their keys). */
export const WORKFLOW_FACT_META: Record<string, Omit<FactMeta, 'key'>> = {
  'service.requiresApproval': { type: 'boolean' },
  'customer.isCorporate': { type: 'boolean' },
  'documents.complete': { type: 'boolean' },
  'quotation.total': { type: 'number' },
  'service.complianceCapability': { values: ['DOCUMENT_PREPARATION_ONLY', 'PARTNER_COORDINATION', 'DIRECT_AUTHORISED', 'INFORMATIONAL_ONLY'] },
  'service.paymentPolicy': { values: ['BEFORE_PROCESSING', 'AFTER_COMPLETION', 'DEPOSIT'] },
  'customer.type': { values: ['INDIVIDUAL', 'BUSINESS'] },
  'request.priority': { values: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
  'request.source': { values: ['WALK_IN', 'ONLINE', 'MOBILE', 'CORPORATE'] },
  'payment.status': { values: ['NOT_REQUIRED', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
};

const dictKey = (value: string) => value.replace(/[^A-Za-z0-9]/g, '_');

/** Labels for facts, operators and values: our own wording when the dictionary has it, else the API's label, else the raw key. */
export function useRuleLabels(facts: FactMeta[]) {
  const { t, has } = useI18n();
  return React.useMemo(() => {
    const byKey = new Map(facts.map((f) => [f.key, f]));
    return {
      fact: (key: string) => (has(`ops.rules.facts.${dictKey(key)}`) ? t(`ops.rules.facts.${dictKey(key)}`) : byKey.get(key)?.label ?? key),
      op: (op: string) => (has(`ops.rules.ops.${op}`) ? t(`ops.rules.ops.${op}`) : op),
      value: (value: unknown): string => {
        if (value === true) return t('common.yes');
        if (value === false) return t('common.no');
        if (Array.isArray(value)) return value.map((v) => (has(`ops.rules.values.${dictKey(String(v))}`) ? t(`ops.rules.values.${dictKey(String(v))}`) : String(v))).join(', ');
        if (value === null || value === undefined) return '';
        return has(`ops.rules.values.${dictKey(String(value))}`) ? t(`ops.rules.values.${dictKey(String(value))}`) : String(value);
      },
    };
  }, [facts, t, has]);
}

/** One sentence per condition, for read-only summaries: "Priority is one of High, Urgent". */
export function useRuleSummary(facts: FactMeta[]) {
  const { t } = useI18n();
  const labels = useRuleLabels(facts);
  return React.useCallback(
    (rule: Rule | null | undefined): string[] => {
      const line = (c: RuleCondition) => (NO_VALUE_OPS.includes(c.op) ? `${labels.fact(c.fact)} ${labels.op(c.op)}` : `${labels.fact(c.fact)} ${labels.op(c.op)} ${labels.value(c.value)}`);
      const all = (rule?.all ?? []).map(line);
      const any = (rule?.any ?? []).map(line);
      return [...all, ...(any.length ? [t('ops.rules.anySummary', { list: any.join(' / ') })] : [])];
    },
    [labels, t],
  );
}

export const isEmptyRule = (rule: Rule | null | undefined) => !rule || ((rule.all?.length ?? 0) === 0 && (rule.any?.length ?? 0) === 0);

/** Drops empty groups; an empty rule becomes null ("always"). */
function tidy(rule: Rule): Rule | null {
  const out: Rule = {};
  if (rule.all?.length) out.all = rule.all;
  if (rule.any?.length) out.any = rule.any;
  return out.all || out.any ? out : null;
}

export interface RuleEditorProps {
  value: Rule | null | undefined;
  onChange: (rule: Rule | null) => void;
  facts: FactMeta[];
  operators?: RuleOp[];
  maxPerGroup?: number;
  disabled?: boolean;
  /** Shown when there is no condition at all ("This step always runs."). */
  emptyText?: string;
}

export function RuleEditor({ value, onChange, facts, operators = DEFAULT_OPERATORS, maxPerGroup = 20, disabled, emptyText }: RuleEditorProps) {
  const { t } = useI18n();
  const rule: Rule = value ?? {};
  const empty = isEmptyRule(rule);

  const setGroup = (group: 'all' | 'any', list: RuleCondition[]) => onChange(tidy({ ...rule, [group]: list }));
  const add = (group: 'all' | 'any') => {
    const first = facts[0];
    if (!first) return;
    setGroup(group, [...(rule[group] ?? []), defaultCondition(first)]);
  };

  return (
    <div className="space-y-4">
      {empty && emptyText ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null}
      {(['all', 'any'] as const).map((group) => {
        const list = rule[group] ?? [];
        if (!list.length) return null;
        return (
          <fieldset key={group} className="space-y-2" disabled={disabled}>
            <legend className="text-sm font-medium text-foreground">{t(group === 'all' ? 'ops.rules.allTitle' : 'ops.rules.anyTitle')}</legend>
            {list.map((condition, index) => (
              <ConditionRow
                key={index}
                condition={condition}
                facts={facts}
                operators={operators}
                disabled={disabled}
                onChange={(next) => setGroup(group, list.map((c, i) => (i === index ? next : c)))}
                onRemove={() => setGroup(group, list.filter((_, i) => i !== index))}
              />
            ))}
            <Button variant="ghost" size="sm" disabled={disabled || list.length >= maxPerGroup} onClick={() => add(group)}>
              <Plus aria-hidden="true" />
              {t('ops.rules.addCondition')}
            </Button>
          </fieldset>
        );
      })}
      <div className="flex flex-wrap gap-2">
        {!(rule.all?.length ?? 0) ? (
          <Button variant="outline" size="sm" disabled={disabled || !facts.length} onClick={() => add('all')}>
            <Plus aria-hidden="true" />
            {t(empty ? 'ops.rules.addFirst' : 'ops.rules.addAll')}
          </Button>
        ) : null}
        {!(rule.any?.length ?? 0) && !empty ? (
          <Button variant="outline" size="sm" disabled={disabled || !facts.length} onClick={() => add('any')}>
            <Plus aria-hidden="true" />
            {t('ops.rules.addAny')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function defaultCondition(fact: FactMeta): RuleCondition {
  if (fact.type === 'boolean') return { fact: fact.key, op: 'eq', value: true };
  if (fact.type === 'number') return { fact: fact.key, op: 'gte', value: 0 };
  if (fact.values?.length) return { fact: fact.key, op: 'eq', value: fact.values[0] };
  return { fact: fact.key, op: 'eq', value: '' };
}

/** Operators that make sense for a fact. */
function operatorsFor(fact: FactMeta | undefined, operators: RuleOp[]): RuleOp[] {
  if (!fact) return operators;
  if (fact.type === 'boolean') return operators.filter((op) => op === 'eq' || op === 'neq');
  if (fact.type === 'number') return operators.filter((op) => !LIST_OPS.includes(op) && op !== 'truthy');
  return operators.filter((op) => !NUMERIC_OPS.includes(op) && op !== 'truthy');
}

/** Keeps the value in the shape the operator needs when the operator or fact changes. */
function coerce(fact: FactMeta | undefined, op: RuleOp, value: unknown): unknown {
  if (NO_VALUE_OPS.includes(op)) return undefined;
  if (LIST_OPS.includes(op)) return Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  const single = Array.isArray(value) ? value[0] : value;
  if (fact?.type === 'boolean') return typeof single === 'boolean' ? single : true;
  if (fact?.type === 'number' || NUMERIC_OPS.includes(op)) return typeof single === 'number' ? single : Number(single) || 0;
  if (fact?.values?.length) return fact.values.includes(String(single)) ? single : fact.values[0];
  return single === undefined || single === null ? '' : String(single);
}

function ConditionRow({ condition, facts, operators, disabled, onChange, onRemove }: {
  condition: RuleCondition;
  facts: FactMeta[];
  operators: RuleOp[];
  disabled?: boolean;
  onChange: (condition: RuleCondition) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const labels = useRuleLabels(facts);
  const fact = facts.find((f) => f.key === condition.fact);
  const ops = operatorsFor(fact, operators);
  const factOptions = React.useMemo(() => {
    const options = facts.map((f) => ({ value: f.key, label: labels.fact(f.key), keywords: [f.key] }));
    // A fact that is no longer offered (stale rule) stays visible so that it can be replaced.
    return fact ? options : [...options, { value: condition.fact, label: condition.fact, keywords: [] }];
  }, [facts, labels, fact, condition.fact]);

  const setFact = (key: string) => {
    const next = facts.find((f) => f.key === key);
    if (!next) return;
    const allowed = operatorsFor(next, operators);
    const op = allowed.includes(condition.op) ? condition.op : allowed[0];
    onChange({ fact: key, op, value: key === condition.fact ? coerce(next, op, condition.value) : defaultCondition(next).op === op ? defaultCondition(next).value : coerce(next, op, undefined) });
  };
  const setOp = (op: RuleOp) => onChange({ fact: condition.fact, op, value: coerce(fact, op, condition.value) });
  const setValue = (value: unknown) => onChange({ ...condition, value });

  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border bg-muted/30 p-2.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto] sm:items-start">
      <Combobox aria-label={t('ops.rules.fact')} value={condition.fact} onValueChange={setFact} options={factOptions} disabled={disabled} />
      <Select aria-label={t('ops.rules.comparison')} value={condition.op} onValueChange={(op) => setOp(op as RuleOp)} options={(ops.includes(condition.op) ? ops : [...ops, condition.op]).map((op) => ({ value: op, label: labels.op(op) }))} disabled={disabled} />
      <ValueInput condition={condition} fact={fact} labels={labels} disabled={disabled} onChange={setValue} />
      <Button variant="ghost" size="icon" disabled={disabled} onClick={onRemove} aria-label={t('ops.rules.removeCondition')} title={t('ops.rules.removeCondition')} className="justify-self-end">
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

function ValueInput({ condition, fact, labels, disabled, onChange }: {
  condition: RuleCondition;
  fact: FactMeta | undefined;
  labels: ReturnType<typeof useRuleLabels>;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const { op, value } = condition;
  if (NO_VALUE_OPS.includes(op)) return <span className="hidden sm:block" />;

  if (LIST_OPS.includes(op)) {
    const list = Array.isArray(value) ? value.map(String) : [];
    if (fact?.values?.length) {
      const toggle = (v: string, on: boolean) => onChange(on ? [...list, v] : list.filter((x) => x !== v));
      return (
        <div role="group" aria-label={t('ops.rules.value')} className="flex flex-wrap gap-x-4 gap-y-1.5 py-1.5">
          {fact.values.map((v) => (
            <label key={v} htmlFor={`${id}-${v}`} className={cn('flex cursor-pointer items-center gap-2 text-sm', disabled && 'opacity-60')}>
              <Checkbox id={`${id}-${v}`} checked={list.includes(v)} onCheckedChange={(on) => toggle(v, on === true)} disabled={disabled} />
              {labels.value(v)}
            </label>
          ))}
        </div>
      );
    }
    return <ListInput aria-label={t('ops.rules.value')} value={list} onChange={onChange} disabled={disabled} placeholder={t('ops.rules.listPlaceholder')} />;
  }

  if (fact?.type === 'boolean') {
    return (
      <Select
        aria-label={t('ops.rules.value')}
        value={value === false ? 'false' : 'true'}
        onValueChange={(v) => onChange(v === 'true')}
        disabled={disabled}
        options={[
          { value: 'true', label: t('common.yes') },
          { value: 'false', label: t('common.no') },
        ]}
      />
    );
  }
  if (fact?.type === 'number' || NUMERIC_OPS.includes(op)) {
    return <Input aria-label={t('ops.rules.value')} type="number" inputMode="decimal" dir="ltr" className="tabular" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} disabled={disabled} />;
  }
  if (fact?.values?.length) {
    const options = fact.values.map((v) => ({ value: v, label: labels.value(v) }));
    return options.length > 10 ? (
      <Combobox aria-label={t('ops.rules.value')} value={String(value ?? '')} onValueChange={onChange} options={options} disabled={disabled} />
    ) : (
      <Select aria-label={t('ops.rules.value')} value={String(value ?? '')} onValueChange={onChange} options={options} disabled={disabled} />
    );
  }
  return <Input aria-label={t('ops.rules.value')} value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} disabled={disabled} dir="auto" placeholder={t('ops.rules.valuePlaceholder')} />;
}

/** Comma-separated values kept as an array; the text is only re-parsed, never re-formatted, while typing. */
function ListInput({ value, onChange, ...props }: { value: string[]; onChange: (value: string[]) => void; disabled?: boolean; placeholder?: string; 'aria-label'?: string }) {
  const [text, setText] = React.useState(value.join(', '));
  const sent = React.useRef(value.join('\u0000'));
  React.useEffect(() => {
    if (value.join('\u0000') !== sent.current) {
      sent.current = value.join('\u0000');
      setText(value.join(', '));
    }
  }, [value]);
  return (
    <Input
      {...props}
      value={text}
      dir="auto"
      onChange={(e) => {
        setText(e.target.value);
        const list = e.target.value.split(/[,،]/).map((v) => v.trim()).filter(Boolean);
        sent.current = list.join('\u0000');
        onChange(list);
      }}
    />
  );
}
