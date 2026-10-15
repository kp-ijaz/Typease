'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, History, RotateCw } from 'lucide-react';
import type { Page } from '@typease/types';
import { Alert, DataTable, PageHeader, RequirePermission, useApi, useI18n, type DataTableColumn, type DataTableFilter } from '@typease/ui';
import { useAutomationLabels } from '@/components/ops/automation';
import { OpsStatusBadge, useRun } from '@/components/ops/common';
import type { AutomationMeta, AutomationRule, Execution } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

export const EXECUTION_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'DEAD_LETTER'];

export function Executions() {
  return (
    <RequirePermission anyOf={['automation.manage']}>
      <ExecutionLog />
    </RequirePermission>
  );
}

/** Every time an automation ran (or was skipped, or failed): filter by rule, status, event and day; retry the ones that gave up. */
function ExecutionLog() {
  const { t, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const labels = useAutomationLabels();
  const { run } = useRun();
  const meta = useQuery({ queryKey: opsKeys.automations.meta, queryFn: () => api.client.get<AutomationMeta>('/automations/meta'), staleTime: 5 * 60_000 });
  const rules = useQuery({ queryKey: [...opsKeys.automations.all, 'list'], queryFn: () => api.client.get<Page<AutomationRule>>('/automations', { query: { page: 1, pageSize: 100 } }) });

  const columns = React.useMemo<Array<DataTableColumn<Execution>>>(
    () => [
      { id: 'when', header: t('ops.automations.log.when'), className: 'whitespace-nowrap tabular', cell: (e) => formatDateTime(e.createdAt) },
      { id: 'rule', header: t('ops.automations.log.rule'), mobile: 'title', cell: (e) => <span dir="auto">{e.ruleName ?? t('ops.automations.log.deletedRule')}</span> },
      { id: 'event', header: t('ops.automations.log.event'), cell: (e) => labels.trigger(e.eventType, e.eventLabel) },
      { id: 'status', header: t('ops.common.status'), mobile: 'badge', cell: (e) => <OpsStatusBadge kind="execution" status={e.status} /> },
      { id: 'attempts', header: t('ops.automations.log.attempts'), align: 'end', className: 'tabular', mobile: 'hidden', cell: (e) => formatNumber(e.attempts) },
      { id: 'error', header: t('ops.automations.log.error'), mobile: 'hidden', cell: (e) => (e.error ? <span className="block max-w-72 truncate text-sm text-destructive-text" title={e.error} dir="auto">{e.error}</span> : null) },
    ],
    [t, formatDateTime, formatNumber, labels],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('ops.common.status'), options: EXECUTION_STATUSES.map((s) => ({ value: s, label: t(`ops.status.execution.${s}`) })) },
      { id: 'ruleId', type: 'select', label: t('ops.automations.log.rule'), options: (rules.data?.data ?? []).map((r) => ({ value: r.id, label: r.name })) },
      { id: 'eventType', type: 'select', label: t('ops.automations.log.event'), options: (meta.data?.triggers ?? []).map((x) => ({ value: x.key, label: labels.trigger(x.key, x.label) })) },
      { id: 'created', type: 'dateRange', label: t('ops.automations.log.when'), fromKey: 'from', toKey: 'to' },
    ],
    [t, rules.data, meta.data, labels],
  );

  const retry = (row: Execution) =>
    run(`retry-${row.id}`, () => api.client.post(`/automations/executions/${row.id}/retry`), { success: t('ops.automations.log.retried'), description: t('ops.automations.log.retriedText'), invalidate: [opsKeys.automations.executions, opsKeys.automations.summary] });

  return (
    <>
      <PageHeader title={t('ops.automations.log.title')} description={t('ops.automations.log.description')} breadcrumbs={[{ label: t('ops.automations.title'), href: '/automations' }]} />
      {meta.data?.available === false ? (
        <Alert tone="warning" title={t('ops.common.planTitle')} className="mb-4">
          {t('ops.automations.planText')}
        </Alert>
      ) : null}
      <DataTable<Execution>
        caption={t('ops.automations.log.title')}
        queryKey={opsKeys.automations.executions}
        // The endpoint accepts exactly these parameters (no search, no sorting: newest first).
        queryFn={({ page, pageSize, status, ruleId, eventType, from, to }, signal) => api.client.get<Page<Execution>>('/automations/executions', { query: { page, pageSize, status, ruleId, eventType, from, to }, signal })}
        columns={columns}
        rowKey={(e) => e.id}
        rowHref={(e) => `/automations/executions/${e.id}`}
        rowActions={[
          { id: 'open', label: t('ops.common.details'), icon: <Eye aria-hidden="true" />, href: (e) => `/automations/executions/${e.id}` },
          { id: 'retry', label: t('ops.automations.log.retry'), icon: <RotateCw aria-hidden="true" />, hidden: (e) => e.status !== 'DEAD_LETTER', onSelect: (e) => void retry(e) },
        ]}
        filters={filters}
        searchable={false}
        empty={{ icon: <History />, title: t('ops.automations.log.emptyTitle'), description: t('ops.automations.log.emptyText') }}
      />
    </>
  );
}
