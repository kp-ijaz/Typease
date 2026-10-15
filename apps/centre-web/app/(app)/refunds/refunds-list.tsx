'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus, Undo2 } from 'lucide-react';
import { RefundStatusValues } from '@typease/types';
import { Alert, Button, DataTable, PageHeader, PermissionGate, RequirePermission, STATUS_META, StatusBadge, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { ScopeBar, useScopeParams } from '@/components/fin/scope-filters';
import { Money, TextLink } from '@/components/fin/shared';
import type { RefundRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const SCOPE = ['paymentId', 'invoiceId', 'requestId'] as const;

export function RefundsList() {
  return (
    <RequirePermission anyOf={['refund.request', 'refund.approve']}>
      <RefundsListInner />
    </RequirePermission>
  );
}

function RefundsListInner() {
  const { t, tn, pick, formatDate } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const scope = useScopeParams(SCOPE);
  const canApprove = session.hasPermission('refund.approve');
  // Remounting the table makes it read its filters from the URL again (the "show the queue" shortcut).
  const [tableKey, setTableKey] = React.useState(0);

  const waiting = useQuery({
    queryKey: [...finKeys.refunds.all, 'waiting'],
    queryFn: ({ signal }) => api.refunds.list({ status: 'REQUESTED', pageSize: 1 }, signal),
    enabled: canApprove,
  });
  const waitingCount = waiting.data?.meta.total ?? 0;

  const showQueue = () => {
    const url = new URL(window.location.href);
    url.search = '?status=REQUESTED';
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    setTableKey((k) => k + 1);
  };

  const columns = React.useMemo<Array<DataTableColumn<RefundRow>>>(
    () => [
      { id: 'number', header: t('fin.refunds.columns.number'), sortField: 'refundNo', mobile: 'title', className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.refundNo}</span> },
      { id: 'status', header: t('fin.common.status'), mobile: 'badge', cell: (r) => <StatusBadge kind="refund" status={r.status} /> },
      {
        id: 'payment',
        header: t('fin.common.payment'),
        className: 'whitespace-nowrap',
        cell: (r) => (
          <>
            <TextLink href={`/payments/${r.payment.id}`} className="tabular font-normal">
              {r.payment.paymentNo}
            </TextLink>
            <span className="block text-sm text-muted-foreground">{t(`fin.methods.${r.payment.method}`)}</span>
          </>
        ),
      },
      { id: 'invoice', header: t('fin.common.invoice'), className: 'whitespace-nowrap tabular', cell: (r) => (r.invoice ? <TextLink href={`/invoices/${r.invoice.id}`} className="font-normal">{r.invoice.invoiceNo}</TextLink> : null) },
      { id: 'reason', header: t('fin.common.reason'), mobile: 'hidden', cell: (r) => <span className="line-clamp-2 max-w-xs text-sm" dir="auto" title={r.reason}>{r.reason}</span> },
      { id: 'requested', header: t('fin.refunds.columns.requested'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (r) => formatDate(r.createdAt) },
      { id: 'amount', header: t('fin.common.amount'), sortField: 'amount', align: 'end', cell: (r) => <Money amount={r.amount} currency={r.currency} className="font-medium" /> },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('fin.common.status'), options: RefundStatusValues.map((s) => ({ value: s, label: pick(STATUS_META.refund[s].en, STATUS_META.refund[s].ar) })) },
      { id: 'requested', type: 'dateRange', label: t('fin.refunds.columns.requested'), fromKey: 'from', toKey: 'to' },
    ],
    [t, pick],
  );

  const rowActions = React.useMemo<Array<RowAction<RefundRow>>>(() => [{ id: 'open', label: t('fin.refunds.open'), icon: <ExternalLink aria-hidden="true" />, href: (r) => `/refunds/${r.id}` }], [t]);

  const request = (
    <PermissionGate permission="refund.request">
      <Button asChild variant="accent">
        <Link href={scope.values.paymentId ? `/refunds/new?paymentId=${scope.values.paymentId}` : '/refunds/new'}>
          <Plus aria-hidden="true" />
          {t('fin.refunds.request')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('fin.refunds.title')} description={t('fin.refunds.description')} action={request} />
      {canApprove && waitingCount > 0 ? (
        <Alert
          tone="warning"
          className="mb-4"
          title={tn('fin.refunds.queue.title', waitingCount)}
          action={
            <Button size="sm" variant="outline" onClick={showQueue}>
              {t('fin.refunds.queue.show')}
            </Button>
          }
        >
          {t('fin.refunds.queue.text')}
        </Alert>
      ) : null}
      <ScopeBar scope={scope} show={SCOPE} />
      <DataTable<RefundRow>
        key={tableKey}
        caption={t('fin.refunds.title')}
        queryKey={finKeys.refunds.all}
        queryFn={(params, signal) => api.refunds.list(params, signal)}
        fixedParams={scope.params}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/refunds/${r.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.refunds.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Undo2 />, title: t('fin.refunds.emptyTitle'), description: t('fin.refunds.emptyText') }}
      />
    </>
  );
}
