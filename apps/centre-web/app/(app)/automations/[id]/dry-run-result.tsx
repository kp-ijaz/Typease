'use client';

import * as React from 'react';
import { Check, X } from 'lucide-react';
import { Alert, Badge, cn, useI18n } from '@typease/ui';
import { actionIcon, useAutomationLabels } from '@/components/ops/automation';
import { useRuleLabels } from '@/components/ops/rule-editor';
import type { DryRun, FactMeta } from '@/components/ops/types';

const NO_VALUE_OPS = ['exists', 'truthy'];

/**
 * What a dry run found: the event it was tried against, each condition with the
 * value the event really had, and what every action would do. Nothing is changed or sent.
 */
export function DryRunResult({ result, facts }: { result: DryRun; facts: FactMeta[] }) {
  const { t, has, formatDateTime, formatNumber } = useI18n();
  const labels = useAutomationLabels();
  const rule = useRuleLabels(facts);
  const actions = result.actions ?? [];

  const previewValue = (key: string, value: unknown): React.ReactNode => {
    if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
    if (typeof value === 'number') return formatNumber(value);
    if (Array.isArray(value)) return value.map((v) => (key === 'channels' && has(`ops.notify.channelNames.${String(v)}`) ? t(`ops.notify.channelNames.${String(v)}`) : String(v))).join(', ');
    if (typeof value === 'string') return key === 'priority' && has(`ops.rules.values.${value}`) ? t(`ops.rules.values.${value}`) : value;
    return JSON.stringify(value);
  };

  return (
    <div className="space-y-6">
      <Alert tone={result.wouldRun ? 'success' : result.conditionsMet ? 'warning' : 'info'} title={t(result.wouldRun ? 'ops.automations.dryRun.wouldRun' : result.conditionsMet ? 'ops.automations.dryRun.metButOff' : 'ops.automations.dryRun.notMet')}>
        {result.notes.length ? (
          <ul className="space-y-0.5" dir="auto">
            {result.notes.map((note, i) => (
              <li key={i}>{!result.rule.isEnabled && /switched off/i.test(note) ? t('ops.automations.dryRun.switchedOff') : note}</li>
            ))}
          </ul>
        ) : null}
      </Alert>

      <section>
        <h3 className="text-md font-semibold">{t('ops.automations.dryRun.event')}</h3>
        <p className="mt-1 text-base">
          {labels.trigger(result.event.type, result.event.label)}
          <span className="text-muted-foreground"> · {formatDateTime(result.event.occurredAt)}</span>
        </p>
        <p className="text-sm text-muted-foreground">{t('ops.automations.dryRun.eventHint')}</p>
      </section>

      <section>
        <h3 className="text-md font-semibold">{t('ops.automations.editor.conditions')}</h3>
        {result.conditions.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">{t('ops.automations.editor.conditionsEmpty')}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {result.conditions.map((c, i) => (
              <li key={i} className="flex items-start gap-2.5 rounded-md border px-3 py-2">
                <span aria-hidden="true" className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5', c.passed ? 'bg-success-soft text-success-text' : 'bg-destructive-soft text-destructive-text')}>
                  {c.passed ? <Check /> : <X />}
                </span>
                <span className="min-w-0 text-sm">
                  <span className="block font-medium text-foreground">
                    {rule.fact(c.fact)} {rule.op(c.op)} {NO_VALUE_OPS.includes(c.op) ? '' : rule.value(c.value)}
                    {c.group === 'any' ? <span className="font-normal text-muted-foreground"> · {t('ops.automations.dryRun.anyGroup')}</span> : null}
                  </span>
                  <span className="block text-muted-foreground">
                    {t(c.passed ? 'ops.automations.dryRun.passed' : 'ops.automations.dryRun.failed')}
                    {' · '}
                    {t('ops.automations.dryRun.actual', { value: c.actual === null || c.actual === undefined ? t('ops.automations.dryRun.noValue') : rule.value(c.actual) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {actions.length ? (
        <section>
          <h3 className="text-md font-semibold">{t('ops.automations.dryRun.actions')}</h3>
          <ol className="mt-2 space-y-3">
            {actions.map((action) => {
              const preview = Object.entries(action.preview ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
              return (
                <li key={action.index} className="rounded-md border p-3">
                  <p className="flex flex-wrap items-center gap-2 font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                    {actionIcon(action.type)}
                    <span>
                      {formatNumber(action.index + 1)}. {labels.action(action.type, action.label)}
                    </span>
                    <Badge tone={action.applicable ? 'success' : 'warning'}>{t(action.applicable ? 'ops.automations.dryRun.applicable' : 'ops.automations.dryRun.notApplicable')}</Badge>
                  </p>
                  {action.note || action.reason ? (
                    <p className="mt-1.5 text-sm text-muted-foreground" dir="auto">
                      {action.note ?? action.reason}
                    </p>
                  ) : null}
                  {preview.length ? (
                    <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                      {preview.map(([key, value]) => (
                        <React.Fragment key={key}>
                          <dt className="text-muted-foreground">{has(`ops.automations.preview.${key}`) ? t(`ops.automations.preview.${key}`) : key}</dt>
                          <dd className="whitespace-pre-wrap break-words text-foreground" dir="auto">
                            {previewValue(key, value)}
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <p className="text-sm text-muted-foreground">{t('ops.automations.dryRun.nothingChanged')}</p>
    </div>
  );
}
