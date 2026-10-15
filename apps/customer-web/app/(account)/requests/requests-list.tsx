'use client';

import * as React from 'react';
import Link from 'next/link';
import { ClipboardList, Plus } from 'lucide-react';
import type { RequestListItem } from '@typease/api-client';
import { Button, DataTable, PageHeader, StatusBadge, useI18n, type DataTableColumn, type DataTableFilter } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';

/** Customers think in "what do I have to do" rather than in fourteen statuses: the filter groups them. */
export const STATUS_GROUPS = {
  waiting: 'DRAFT,AWAITING_CUSTOMER,QUOTED,AWAITING_PAYMENT',
  progress: 'SUBMITTED,UNDER_REVIEW,READY_FOR_PROCESSING,IN_PREPARATION,PENDING_APPROVAL,READY_TO_SUBMIT,EXTERNAL_PROCESSING,RETURNED,REJECTED,FINAL_REVIEW',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
} as const;

/** A draft opens in the step-by-step form where it stopped; everything else opens the request page. */
export const requestHref = (r: Pick<RequestListItem, 'id' | 'status'>) => (r.status === 'DRAFT' ? `${ROUTES.newRequest}?draft=${r.id}` : `/requests/${r.id}`);

export function RequestsList() {
  const { t, pick, formatDate } = useI18n();
  const api = usePortalApi();

  // "New request" is always within reach in the shell (top bar, and the round button on phones): the page
  // does not repeat it, except to fill an empty list.
  const newRequest = (
    <Button asChild variant="accent">
      <Link href={ROUTES.newRequest}>
        <Plus aria-hidden="true" />
        {t('nav.newRequest')}
      </Link>
    </Button>
  );

  const columns = React.useMemo<Array<DataTableColumn<RequestListItem>>>(
    () => [
      { id: 'service', header: t('my.requests.columns.service'), mobile: 'title', cell: (r) => pick(r.service.name, r.service.nameAr) },
      // The API words the status for customers ("Action needed from you").
      { id: 'status', header: t('my.requests.columns.status'), mobile: 'badge', cell: (r) => <StatusBadge kind="requestCustomer" status={r.status} label={r.statusLabel} /> },
      { id: 'number', header: t('my.requests.columns.number'), sortField: 'requestNo', className: 'whitespace-nowrap', cell: (r) => <span className="tabular ltr-value">{r.requestNo}</span> },
      { id: 'created', header: t('my.requests.columns.created'), sortField: 'createdAt', className: 'whitespace-nowrap', cell: (r) => formatDate(r.createdAt) },
      {
        id: 'payment',
        header: t('my.requests.columns.payment'),
        // "Unpaid" only means something once there is an invoice: before that the column stays empty.
        cell: (r) => (r.status === 'DRAFT' || r.status === 'CANCELLED' || r.paymentStatus === 'NOT_REQUIRED' || (r.paymentStatus === 'UNPAID' && r.status !== 'AWAITING_PAYMENT') ? null : <StatusBadge kind="requestPayment" status={r.paymentStatus} />),
      },
    ],
    [t, pick, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      {
        id: 'status',
        type: 'select',
        label: t('my.requests.filter.label'),
        options: (Object.keys(STATUS_GROUPS) as Array<keyof typeof STATUS_GROUPS>).map((key) => ({ value: STATUS_GROUPS[key], label: t(`my.requests.filter.${key}`) })),
      },
    ],
    [t],
  );

  return (
    <>
      <PageHeader title={t('nav.requests')} description={t('account.sections.requests')} />
      <DataTable<RequestListItem>
        caption={t('nav.requests')}
        queryKey={keys.requests.all}
        queryFn={(params, signal) => api.requests(params, signal)}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={requestHref}
        filters={filters}
        searchPlaceholder={t('my.requests.search')}
        defaultSort="createdAt:desc"
        empty={{ icon: <ClipboardList />, title: t('account.dashboard.emptyTitle'), description: t('account.dashboard.emptyText'), action: newRequest }}
      />
    </>
  );
}
