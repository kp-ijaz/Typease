'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { Alert, Badge, Button, DescriptionList, PageHeader, PageSkeleton, RequirePermission, cn, focusRing, useApi, useErrorMessage, useI18n, type Tone } from '@typease/ui';
import { actionIcon, useAutomationLabels } from '@/components/ops/automation';
import { OpsStatusBadge, Panel, useRun } from '@/components/ops/common';
import type { Execution } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const ACTION_TONES: Record<string, Tone> = { PENDING: 'info', SUCCEEDED: 'success', SKIPPED: 'neutral', FAILED: 'danger' };

export function ExecutionPage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['automation.manage']}>
      <ExecutionView id={id} />
    </RequirePermission>
  );
}

/** One run of an automation: the event that started it, what each action did, and why it failed if it did. */
function ExecutionView({ id }: { id: string }) {
  const { t, has, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const describe = useErrorMessage();
  const labels = useAutomationLabels();
  const { run, busy } = useRun();
  const execution = useQuery({
    queryKey: opsKeys.automations.execution(id),
    queryFn: () => api.client.get<Execution>(`/automations/executions/${id}`),
    retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
    // A run that is still waiting or working finishes by itself: look again until it has.
    refetchInterval: (query) => (query.state.data && ['PENDING', 'RUNNING'].includes(query.state.data.status) ? 4000 : false),
  });
  const crumbs = [
    { label: t('ops.automations.title'), href: '/automations' },
    { label: t('ops.automations.log.title'), href: '/automations/executions' },
  ];

  if (execution.isPending) return <PageSkeleton label={t('common.loading')} />;
  if (execution.isError) {
    return (
      <>
        <PageHeader title={t('ops.automations.execution.title')} breadcrumbs={crumbs} />
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={() => void execution.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {describe(execution.error)}
        </Alert>
      </>
    );
  }

  const e = execution.data;
  const eventData = Object.entries(e.event?.data ?? {}).filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object');
  const retry = () =>
    run('retry', () => api.client.post(`/automations/executions/${e.id}/retry`), { success: t('ops.automations.log.retried'), description: t('ops.automations.log.retriedText'), invalidate: [opsKeys.automations.executions, opsKeys.automations.summary] });

  return (
    <>
      <PageHeader
        title={e.ruleName ?? t('ops.automations.log.deletedRule')}
        description={t('ops.automations.execution.description', { event: labels.trigger(e.eventType, e.eventLabel), when: formatDateTime(e.createdAt) })}
        breadcrumbs={crumbs}
        meta={<OpsStatusBadge kind="execution" status={e.status} />}
        action={
          e.status === 'DEAD_LETTER' ? (
            <Button variant="accent" disabled={e.canRetry === false} loading={busy === 'retry'} loadingText={t('common.loading')} onClick={() => void retry()}>
              <RotateCw aria-hidden="true" />
              {t('ops.automations.log.retry')}
            </Button>
          ) : undefined
        }
      />

      {e.status === 'DEAD_LETTER' ? (
        <Alert tone="danger" title={t('ops.automations.execution.deadLetterTitle')} className="mb-4">
          {t(e.canRetry === false ? 'ops.automations.execution.deadLetterOff' : 'ops.automations.execution.deadLetterText')}
        </Alert>
      ) : null}
      {e.error ? (
        <Alert tone={e.status === 'DEAD_LETTER' || e.status === 'FAILED' ? 'warning' : 'info'} title={t('ops.automations.log.error')} className="mb-4">
          <span dir="auto">{e.error}</span>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel title={t('ops.automations.execution.actions')} description={t('ops.automations.execution.actionsText')}>
          {e.actions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('ops.automations.execution.noActions')}</p>
          ) : (
            <ol className="space-y-3">
              {e.actions.map((action) => {
                const output = Object.entries(action.output ?? {}).filter(([key, value]) => key !== 'reason' && value !== null && value !== undefined && typeof value !== 'object');
                const reason = typeof action.output?.reason === 'string' ? action.output.reason : null;
                return (
                  <li key={action.index} className="rounded-md border p-3">
                    <p className="flex flex-wrap items-center gap-2 font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                      {actionIcon(action.type)}
                      <span>
                        {formatNumber(action.index + 1)}. {labels.action(action.type, action.label)}
                      </span>
                      <Badge tone={ACTION_TONES[action.status] ?? 'neutral'}>{has(`ops.automations.execution.actionStatus.${action.status}`) ? t(`ops.automations.execution.actionStatus.${action.status}`) : action.status}</Badge>
                      {action.attempts > 1 ? <span className="text-sm font-normal text-muted-foreground">{t('ops.automations.execution.attempts', { count: formatNumber(action.attempts) })}</span> : null}
                    </p>
                    {action.finishedAt ? <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(action.finishedAt)}</p> : null}
                    {reason ? (
                      <p className="mt-1.5 text-sm text-foreground/90" dir="auto">
                        {reason}
                      </p>
                    ) : null}
                    {action.error ? (
                      <p className="mt-1.5 text-sm text-destructive-text" dir="auto">
                        {action.error.message}
                        {action.error.retryable === false ? ` (${t('ops.automations.execution.notRetryable')})` : ''}
                      </p>
                    ) : null}
                    {output.length ? (
                      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
                        {output.map(([key, value]) => (
                          <React.Fragment key={key}>
                            {has(`ops.automations.output.${key}`) ? <dt className="text-muted-foreground">{t(`ops.automations.output.${key}`)}</dt> : <dt className="ltr-value font-mono text-xs leading-6 text-muted-foreground">{key}</dt>}
                            <dd className="ltr-value break-all text-foreground">{typeof value === 'number' ? formatNumber(value) : key === 'to' && has(`ops.automations.recipients.${String(value)}`) ? t(`ops.automations.recipients.${String(value)}`) : String(value)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <Panel title={t('ops.common.details')}>
          <DescriptionList
            columns={1}
            items={[
              {
                label: t('ops.automations.log.rule'),
                value: e.ruleName ? (
                  <Link href={`/automations/${e.ruleId}`} className={cn('rounded-sm text-secondary-text hover:underline', focusRing)} dir="auto">
                    {e.ruleName}
                  </Link>
                ) : (
                  t('ops.automations.log.deletedRule')
                ),
              },
              { label: t('ops.automations.log.event'), value: labels.trigger(e.eventType, e.eventLabel) },
              { label: t('ops.automations.execution.eventAt'), value: e.event?.occurredAt ? formatDateTime(e.event.occurredAt) : null },
              { label: t('ops.automations.execution.startedAt'), value: e.startedAt ? formatDateTime(e.startedAt) : null },
              { label: t('ops.automations.execution.finishedAt'), value: e.finishedAt ? formatDateTime(e.finishedAt) : null },
              { label: t('ops.automations.log.attempts'), value: e.maxRetries !== undefined ? t('ops.automations.execution.attemptsOf', { count: formatNumber(e.attempts), max: formatNumber(e.maxRetries + 1) }) : formatNumber(e.attempts) },
            ]}
          />
          {eventData.length ? (
            <div className="mt-4 border-t pt-4">
              <p className="text-sm font-medium">{t('ops.automations.execution.eventData')}</p>
              <p className="text-sm text-muted-foreground">{t('ops.automations.execution.eventDataText')}</p>
              <dl className="mt-2 space-y-1 text-sm">
                {eventData.map(([key, value]) => (
                  <div key={key} className="flex flex-wrap gap-x-2">
                    <dt className="ltr-value font-mono text-xs leading-6 text-muted-foreground">{key}</dt>
                    <dd className="ltr-value min-w-0 break-all font-mono text-xs leading-6 text-foreground">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
