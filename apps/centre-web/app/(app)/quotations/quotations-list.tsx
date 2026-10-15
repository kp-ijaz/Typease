'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, FileDown, FileText, Plus } from 'lucide-react';
import { QuotationStatusValues } from '@typease/types';
import { Badge, Button, DataTable, PageHeader, PermissionGate, STATUS_META, StatusBadge, useI18n, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { ScopeBar, useScopeParams } from '@/components/fin/scope-filters';
import { Money, useBranchFilter, useDownload } from '@/components/fin/shared';
import type { QuotationRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const SCOPE = ['customerId', 'corporateAccountId', 'requestId'] as const;

export function QuotationsList() {
  const { t, pick, formatDate } = useI18n();
  const api = useFinApi();
  const scope = useScopeParams(SCOPE);
  const branchFilter = useBranchFilter();
  const download = useDownload();

  const columns = React.useMemo<Array<DataTableColumn<QuotationRow>>>(
    () => [
      { id: 'number', header: t('fin.quotations.columns.number'), sortField: 'quotationNo', mobile: 'title', className: 'whitespace-nowrap', cell: (q) => <span className="tabular">{q.quotationNo}</span> },
      {
        id: 'customer',
        header: t('fin.common.customer'),
        cell: (q) => (
          <>
            <span className="block font-medium text-foreground">{q.customer.fullName}</span>
            {q.corporateAccount ? <span className="block text-sm text-muted-foreground">{q.corporateAccount.companyName}</span> : null}
          </>
        ),
      },
      { id: 'request', header: t('fin.common.request'), className: 'whitespace-nowrap tabular', cell: (q) => q.request?.requestNo ?? null },
      {
        id: 'status',
        header: t('fin.common.status'),
        mobile: 'badge',
        cell: (q) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="quotation" status={q.status} />
            {q.status === 'DRAFT' && q.discountApproval === 'PENDING' ? <Badge tone="warning">{t('fin.quotations.discount.badgePending')}</Badge> : null}
            {q.status === 'DRAFT' && q.discountApproval === 'REJECTED' ? <Badge tone="danger">{t('fin.quotations.discount.badgeRejected')}</Badge> : null}
          </span>
        ),
      },
      { id: 'valid', header: t('fin.quotations.columns.validUntil'), sortField: 'validUntil', className: 'whitespace-nowrap tabular', cell: (q) => (q.validUntil ? formatDate(q.validUntil) : null) },
      { id: 'branch', header: t('fin.common.branch'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (q) => q.branch.name },
      { id: 'total', header: t('fin.common.total'), sortField: 'total', align: 'end', cell: (q) => <Money amount={q.total} currency={q.currency} className="font-medium" /> },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('fin.common.status'), options: QuotationStatusValues.map((s) => ({ value: s, label: pick(STATUS_META.quotation[s].en, STATUS_META.quotation[s].ar) })) },
      {
        id: 'discountApproval',
        type: 'select',
        label: t('fin.quotations.filters.discount'),
        options: (['PENDING', 'APPROVED', 'REJECTED', 'NONE'] as const).map((v) => ({ value: v, label: t(`fin.quotations.discount.states.${v}`) })),
      },
      ...branchFilter,
      { id: 'created', type: 'dateRange', label: t('fin.quotations.filters.created'), fromKey: 'from', toKey: 'to' },
    ],
    [t, pick, branchFilter],
  );

  const rowActions = React.useMemo<Array<RowAction<QuotationRow>>>(
    () => [
      { id: 'open', label: t('fin.quotations.open'), icon: <ExternalLink aria-hidden="true" />, href: (q) => `/quotations/${q.id}` },
      { id: 'pdf', label: t('fin.common.downloadPdf'), icon: <FileDown aria-hidden="true" />, onSelect: (q) => void download.save(q.id, api.quotations.pdfPath(q.id), { fallbackFilename: `${q.quotationNo}.pdf` }) },
    ],
    [t, download, api],
  );

  const create = (
    <PermissionGate permission="quotation.manage">
      <Button asChild variant="accent">
        <Link href={scope.values.requestId ? `/quotations/new?requestId=${scope.values.requestId}` : scope.values.customerId ? `/quotations/new?customerId=${scope.values.customerId}` : '/quotations/new'}>
          <Plus aria-hidden="true" />
          {t('fin.quotations.new')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('fin.quotations.title')} description={t('fin.quotations.description')} action={create} />
      <ScopeBar scope={scope} show={SCOPE} />
      <DataTable<QuotationRow>
        caption={t('fin.quotations.title')}
        queryKey={finKeys.quotations.all}
        queryFn={(params, signal) => api.quotations.list(params, signal)}
        fixedParams={scope.params}
        columns={columns}
        rowKey={(q) => q.id}
        rowHref={(q) => `/quotations/${q.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.quotations.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <FileText />, title: t('fin.quotations.emptyTitle'), description: t('fin.quotations.emptyText'), action: create }}
      />
    </>
  );
}
