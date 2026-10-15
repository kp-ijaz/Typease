'use client';

import * as React from 'react';
import Link from 'next/link';
import { ClipboardList, Copy, ExternalLink, Plus } from 'lucide-react';
import type { RequestBucket, RequestListItem, RequestPriority } from '@typease/api-client';
import {
  Badge, Button, DataTable, PageHeader, PermissionGate, STATUS_META, StatusBadge, useApi, useI18n, useToast, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { useBranches } from '@/components/branch';
import { keys } from '@/lib/query-keys';
import { RequestsViewSwitch } from './view-switch';

const BUCKETS: RequestBucket[] = ['newRequests', 'pendingVerification', 'awaitingCustomer', 'awaitingPayment', 'readyForProcessing', 'inProgress', 'completedToday', 'overdue'];
const PRIORITIES: RequestPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

/**
 * REFERENCE IMPLEMENTATION OF A LIST PAGE.
 * A page header with the one primary action, and a <DataTable> that talks to a
 * `{ data, meta }` endpoint. Everything else (loading, empty, error, paging,
 * URL state, the stacked cards on phones) comes from the table.
 */
export function RequestsList() {
  const { t, pick, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const branches = useBranches();

  const columns = React.useMemo<Array<DataTableColumn<RequestListItem>>>(
    () => [
      {
        id: 'number',
        header: t('requests.columns.number'),
        sortField: 'requestNo',
        mobile: 'title',
        className: 'whitespace-nowrap',
        cell: (r) => <span className="tabular">{r.requestNo}</span>,
      },
      {
        id: 'customer',
        header: t('requests.columns.customer'),
        className: 'whitespace-nowrap',
        cell: (r) => (
          <>
            <span className="block font-medium text-foreground">{r.customerName}</span>
            <span className="tabular block text-sm text-muted-foreground">{r.customer.customerNo}</span>
          </>
        ),
      },
      { id: 'service', header: t('requests.columns.service'), cell: (r) => pick(r.service.name, r.service.nameAr) },
      {
        id: 'status',
        header: t('requests.columns.status'),
        mobile: 'badge',
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="request" status={r.status} label={r.statusLabel} />
            {r.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      {
        id: 'priority',
        header: t('requests.columns.priority'),
        sortField: 'priority',
        className: 'whitespace-nowrap',
        // Normal and low are the default: only what stands out gets a badge.
        cell: (r) => (r.priority === 'HIGH' || r.priority === 'URGENT' ? <StatusBadge kind="priority" status={r.priority} /> : <StatusBadge kind="priority" status={r.priority} className="bg-transparent px-0" />),
      },
      { id: 'assignee', header: t('requests.columns.assignee'), className: 'whitespace-nowrap', mobile: 'hidden', cell: (r) => r.assigneeName ?? <span className="text-muted-foreground">{t('requests.unassigned')}</span> },
      {
        id: 'submitted',
        header: t('requests.columns.submitted'),
        sortField: 'submittedAt',
        className: 'whitespace-nowrap tabular',
        cell: (r) => (r.submittedAt ? formatDate(r.submittedAt) : <span className="text-muted-foreground">{t('requests.notSubmitted')}</span>),
      },
      { id: 'target', header: t('requests.columns.target'), sortField: 'targetDate', className: 'whitespace-nowrap tabular', cell: (r) => formatDate(r.targetDate) },
    ],
    [t, pick, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'bucket', type: 'select', label: t('requests.filters.bucket'), options: BUCKETS.map((b) => ({ value: b, label: t(`dashboard.buckets.${b}`) })) },
      // Also set by the board's "+N more" links (several statuses as "A,B", which the API accepts).
      {
        id: 'status',
        type: 'select',
        label: t('requests.filters.status'),
        options: (Object.keys(STATUS_META.request) as Array<keyof typeof STATUS_META.request>).map((s) => ({ value: s, label: pick(STATUS_META.request[s].en, STATUS_META.request[s].ar) })),
      },
      ...(branches.data && branches.data.length > 1
        ? [{ id: 'branchId', type: 'select' as const, label: t('requests.filters.branch'), options: branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) })) }]
        : []),
      { id: 'priority', type: 'select', label: t('requests.filters.priority'), options: PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) })) },
      { id: 'created', type: 'dateRange', label: t('requests.filters.created'), fromKey: 'createdFrom', toKey: 'createdTo' },
    ],
    [t, pick, branches.data],
  );

  const rowActions = React.useMemo<Array<RowAction<RequestListItem>>>(
    () => [
      { id: 'open', label: t('requests.open'), icon: <ExternalLink aria-hidden="true" />, href: (r) => `/requests/${r.id}` },
      {
        id: 'copy',
        label: t('requests.copyNumber'),
        icon: <Copy aria-hidden="true" />,
        onSelect: (r) => void navigator.clipboard?.writeText(r.requestNo).then(() => toasts.success(t('common.copied'), r.requestNo)),
      },
    ],
    [t, toasts],
  );

  const newRequest = (
    <PermissionGate permission="request.create">
      <Button asChild variant="accent">
        <Link href="/requests/new">
          <Plus aria-hidden="true" />
          {t('requests.new')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('requests.title')} description={t('requests.description')} action={newRequest} secondary={<RequestsViewSwitch active="list" />} />
      <DataTable<RequestListItem>
        caption={t('requests.title')}
        queryKey={keys.requests.all}
        queryFn={(params, signal) => api.requests.list(params, signal)}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/requests/${r.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('requests.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <ClipboardList />, title: t('requests.emptyTitle'), description: t('requests.emptyText'), action: newRequest }}
      />
    </>
  );
}
