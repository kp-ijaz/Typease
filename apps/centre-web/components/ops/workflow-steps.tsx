'use client';

import * as React from 'react';
import { Clock, EyeOff, GitBranch, UserRound } from 'lucide-react';
import { WORKFLOW_FACTS } from '@typease/types';
import { Badge, cn, useI18n } from '@typease/ui';
import { WORKFLOW_FACT_META, useRuleSummary } from './rule-editor';
import type { FactMeta, WorkflowStep } from './types';

export const WORKFLOW_FACT_LIST: FactMeta[] = WORKFLOW_FACTS.map((key) => ({ key, ...WORKFLOW_FACT_META[key] }));

/** Words for a step: who acts, how long it may take, when it applies. Shared by the read-only summary and the builder's step cards. */
export function useStepFacts(roles?: Array<{ key: string; name: string }>) {
  const { t, formatNumber } = useI18n();
  const summarise = useRuleSummary(WORKFLOW_FACT_LIST);
  return React.useCallback(
    (step: WorkflowStep) => {
      const role = (key: string | null) => (key ? roles?.find((r) => r.key === key)?.name ?? key : null);
      return {
        actor: role(step.assigneeRoleKey),
        timeout: step.timeoutHours
          ? step.escalateToRoleKey
            ? t('ops.workflows.step.timeoutEscalate', { hours: formatNumber(step.timeoutHours), role: role(step.escalateToRoleKey) ?? '' })
            : t('ops.workflows.step.timeout', { hours: formatNumber(step.timeoutHours) })
          : null,
        conditions: summarise(step.conditions),
      };
    },
    [roles, summarise, t, formatNumber],
  );
}

/**
 * A read-only, diagram-like summary of a workflow version: a vertical line of numbered
 * steps with their type, who acts, the time limit and the conditions under which a step applies.
 */
export function WorkflowSteps({ steps, roles, className }: { steps: WorkflowStep[]; roles?: Array<{ key: string; name: string }>; className?: string }) {
  const { t, pick, formatNumber } = useI18n();
  const facts = useStepFacts(roles);
  const summarise = useRuleSummary(WORKFLOW_FACT_LIST);
  const nameOf = (key: string | null) => {
    const step = steps.find((s) => s.key === key);
    return step ? pick(step.name, step.nameAr) : key ?? '';
  };
  return (
    <ol className={cn('relative', className)}>
      {steps.map((step, index) => {
        const { actor, timeout, conditions } = facts(step);
        const last = index === steps.length - 1;
        return (
          <li key={step.key} className="relative flex gap-3.5 pb-5 last:pb-0">
            {!last ? <span aria-hidden="true" className="absolute bottom-0 start-[0.8125rem] top-8 w-px bg-border" /> : null}
            <span aria-hidden="true" className={cn('tabular relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold', step.type === 'COMPLETION' ? 'border-success bg-success text-success-foreground' : 'border-secondary bg-card text-secondary-text')}>
              {formatNumber(index + 1)}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium leading-6 text-foreground">
                {pick(step.name, step.nameAr)}
                <Badge tone={step.type === 'CONDITIONAL_BRANCH' ? 'warning' : 'neutral'}>{t(`ops.workflows.stepTypes.${step.type}`)}</Badge>
                {step.customerVisible ? null : (
                  <Badge tone="outline" icon={<EyeOff />}>
                    {t('ops.workflows.step.hiddenFromCustomer')}
                  </Badge>
                )}
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground [&_svg]:me-1.5 [&_svg]:inline [&_svg]:size-3.5 [&_svg]:align-[-2px]">
                {actor ? (
                  <li>
                    <UserRound aria-hidden="true" />
                    {t('ops.workflows.step.actor', { role: actor })}
                  </li>
                ) : null}
                {timeout ? (
                  <li>
                    <Clock aria-hidden="true" />
                    {timeout}
                  </li>
                ) : null}
                {conditions.length ? (
                  <li>
                    <GitBranch aria-hidden="true" />
                    {t('ops.workflows.step.onlyWhen', { conditions: conditions.join('; ') })}
                  </li>
                ) : null}
                {step.type === 'NOTIFICATION' && typeof step.config?.message === 'string' ? <li dir="auto">“{step.config.message}”</li> : null}
                {(step.branches ?? []).map((branch, i) => (
                  <li key={i}>
                    <GitBranch aria-hidden="true" />
                    {t('ops.workflows.step.branchLine', { conditions: summarise(branch.when).join('; ') || t('ops.workflows.step.always'), step: nameOf(branch.goTo) })}
                  </li>
                ))}
                {step.onRejectStepKey ? <li>{t('ops.workflows.step.onReject', { step: nameOf(step.onRejectStepKey) })}</li> : null}
                {step.nextStepKey ? <li>{t('ops.workflows.step.thenGoTo', { step: nameOf(step.nextStepKey) })}</li> : null}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
