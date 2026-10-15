'use client';

import * as React from 'react';
import { FileText } from 'lucide-react';
import { DataTable, PageHeader, StatusBadge, useI18n, type DataTableColumn, type DataTableFilter } from '@typease/ui';
import { Money } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { QuotationRow } from '@/lib/types';

/** A sent quotation past its date reads "Expired" even before the centre's job has marked it. */
export const quotationStatus = (q: Pick<QuotationRow, 'status' | 'expired'>) => (q.status === 'SENT' && q.expired ? 'EXPIRED' : q.status);

const STATUSES = ['SENT', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;

/** Price offers of the centre: the ones waiting for the customer's decision and the earlier ones. */
export function QuotationsList() {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const columns = React.useMemo<Array<DataTableColumn<QuotationRow>>>(
    () => [
      { id: 'number', header: t('my.quotations.columns.number'), mobile: 'title', className: 'whitespace-nowrap', cell: (q) => <span className="tabular ltr-value">{q.quotationNo}</span> },
      { id: 'status', header: t('my.requests.columns.status'), mobile: 'badge', cell: (q) => <StatusBadge kind="quotation" status={quotationStatus(q)} label={q.status === 'SENT' && !q.expired ? { en: t('my.quotations.waiting'), ar: t('my.quotations.waiting') } : undefined} /> },
      { id: 'request', header: t('my.quotations.columns.request'), className: 'whitespace-nowrap', cell: (q) => (q.request ? <span className="tabular ltr-value">{q.request.requestNo}</span> : null) },
      { id: 'total', header: t('my.fees.total'), align: 'end', className: 'whitespace-nowrap', cell: (q) => <Money amount={q.total} currency={q.currency} /> },
      { id: 'valid', header: t('my.quotations.columns.validUntil'), className: 'whitespace-nowrap', cell: (q) => (q.validUntil ? formatDate(q.validUntil) : null) },
      { id: 'sent', header: t('my.quotations.columns.sent'), sortField: 'createdAt', mobile: 'hidden', className: 'whitespace-nowrap', cell: (q) => formatDate(q.sentAt ?? q.createdAt) },
    ],
    [t, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'status', type: 'select', label: t('my.requests.columns.status'), options: STATUSES.map((s) => ({ value: s, label: t(`my.quotations.status.${s}`) })) }],
    [t],
  );
  return (
    <>
      <PageHeader title={t('nav.quotations')} description={t('account.sections.quotations')} />
      <DataTable<QuotationRow>
        caption={t('nav.quotations')}
        queryKey={keys.quotations.all}
        queryFn={(params, signal) => api.quotations(params, signal)}
        columns={columns}
        rowKey={(q) => q.id}
        rowHref={(q) => `/quotations/${q.id}`}
        filters={filters}
        searchPlaceholder={t('my.quotations.search')}
        defaultSort="createdAt:desc"
        empty={{ icon: <FileText />, title: t('my.quotations.emptyTitle'), description: t('my.quotations.emptyText') }}
      />
    </>
  );
}
