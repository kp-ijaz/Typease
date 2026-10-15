'use client';

import * as React from 'react';
import Link from 'next/link';
import { Banknote, ExternalLink, FileDown, Plus, Receipt } from 'lucide-react';
import { InvoiceStatusValues } from '@typease/types';
import {
  Badge, Button, DataTable, PageHeader, PermissionGate, STATUS_META, StatusBadge, addMoney, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { ScopeBar, useActiveListPage, useScopeParams } from '@/components/fin/scope-filters';
import { Money, useBranchFilter, useDownload } from '@/components/fin/shared';
import type { InvoiceRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const SCOPE = ['customerId', 'corporateAccountId', 'requestId'] as const;

export function InvoicesList() {
  const { t, tn, pick, formatDate } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const scope = useScopeParams(SCOPE);
  const branchFilter = useBranchFilter();
  const download = useDownload();
  const page = useActiveListPage<InvoiceRow>(finKeys.invoices.all);

  const columns = React.useMemo<Array<DataTableColumn<InvoiceRow>>>(
    () => [
      {
        id: 'number',
        header: t('fin.invoices.columns.number'),
        sortField: 'invoiceNo',
        mobile: 'title',
        className: 'whitespace-nowrap',
        cell: (r) => <span className="tabular">{r.status === 'DRAFT' || r.invoiceNo.startsWith('DRAFT-') ? t('fin.invoices.draftNumber') : r.invoiceNo}</span>,
      },
      {
        id: 'customer',
        header: t('fin.invoices.columns.customer'),
        cell: (r) => (
          <>
            <span className="block font-medium text-foreground">{r.customer.fullName}</span>
            {r.corporateAccount ? <span className="block text-sm text-muted-foreground">{r.corporateAccount.companyName}</span> : null}
          </>
        ),
      },
      { id: 'request', header: t('fin.invoices.columns.request'), className: 'whitespace-nowrap tabular', mobile: 'hidden', cell: (r) => r.request?.requestNo ?? null },
      {
        id: 'status',
        header: t('fin.invoices.columns.status'),
        mobile: 'badge',
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="invoice" status={r.status} />
            {r.overdue ? <Badge tone="danger">{t('fin.invoices.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'issued', header: t('fin.invoices.columns.issued'), sortField: 'issuedAt', className: 'whitespace-nowrap tabular', cell: (r) => (r.issuedAt ? formatDate(r.issuedAt) : null) },
      { id: 'due', header: t('fin.invoices.columns.due'), sortField: 'dueAt', className: 'whitespace-nowrap tabular', cell: (r) => (r.dueAt ? formatDate(r.dueAt) : null) },
      { id: 'total', header: t('fin.invoices.columns.total'), sortField: 'total', align: 'end', cell: (r) => <Money amount={r.total} currency={r.currency} /> },
      {
        id: 'balance',
        header: t('fin.invoices.columns.balance'),
        sortField: 'balanceDue',
        align: 'end',
        cell: (r) => (r.status === 'DRAFT' || r.status === 'VOID' ? null : <Money amount={r.balanceDue} currency={r.currency} className={Number(r.balanceDue) > 0 ? 'font-semibold' : 'text-muted-foreground'} />),
      },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('fin.common.status'), options: InvoiceStatusValues.map((s) => ({ value: s, label: pick(STATUS_META.invoice[s].en, STATUS_META.invoice[s].ar) })) },
      { id: 'overdue', type: 'select', label: t('fin.invoices.filters.overdue'), options: [{ value: 'true', label: t('fin.invoices.filters.overdueOnly') }, { value: 'false', label: t('fin.invoices.filters.notOverdue') }] },
      ...branchFilter,
      { id: 'issued', type: 'dateRange', label: t('fin.invoices.filters.created'), fromKey: 'from', toKey: 'to' },
    ],
    [t, pick, branchFilter],
  );

  const mayRecord = session.hasPermission('payment.record');
  const rowActions = React.useMemo<Array<RowAction<InvoiceRow>>>(
    () => [
      { id: 'open', label: t('fin.invoices.open'), icon: <ExternalLink aria-hidden="true" />, href: (r) => `/invoices/${r.id}` },
      {
        id: 'pay',
        label: t('fin.invoices.recordPayment'),
        icon: <Banknote aria-hidden="true" />,
        href: (r) => `/payments/new?invoiceId=${r.id}`,
        hidden: (r) => !mayRecord || !(r.status === 'ISSUED' || r.status === 'PARTIALLY_PAID'),
      },
      {
        id: 'pdf',
        label: t('fin.common.downloadPdf'),
        icon: <FileDown aria-hidden="true" />,
        onSelect: (r) => void download.save(r.id, api.invoices.pdfPath(r.id), { fallbackFilename: `${r.invoiceNo}.pdf` }),
        hidden: (r) => r.status === 'DRAFT' || r.invoiceNo.startsWith('DRAFT-'),
      },
    ],
    [t, mayRecord, download, api],
  );

  const newInvoice = (
    <PermissionGate permission="invoice.manage">
      <Button asChild variant="accent">
        <Link href="/invoices/new">
          <Plus aria-hidden="true" />
          {t('fin.invoices.new')}
        </Link>
      </Button>
    </PermissionGate>
  );

  // Totals of the rows on screen. Drafts and void invoices are not money owed, so they are left out.
  const rows = (page?.data ?? []).filter((r) => r.status !== 'DRAFT' && r.status !== 'VOID');
  const currency = rows[0]?.currency;
  const sameCurrency = rows.every((r) => r.currency === currency);

  return (
    <>
      <PageHeader title={t('fin.invoices.title')} description={t('fin.invoices.description')} action={newInvoice} />
      <ScopeBar scope={scope} show={SCOPE} />
      <DataTable<InvoiceRow>
        caption={t('fin.invoices.title')}
        queryKey={finKeys.invoices.all}
        queryFn={(params, signal) => api.invoices.list(params, signal)}
        fixedParams={scope.params}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/invoices/${r.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.invoices.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Receipt />, title: t('fin.invoices.emptyTitle'), description: t('fin.invoices.emptyText'), action: newInvoice }}
      />
      {rows.length > 0 && sameCurrency ? (
        <dl aria-label={t('fin.invoices.pageTotals')} className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-xs">
          <div className="me-auto text-muted-foreground">
            <dt className="sr-only">{t('fin.invoices.pageTotals')}</dt>
            <dd>{tn('fin.invoices.pageTotalsOf', rows.length)}</dd>
          </div>
          {(
            [
              ['total', addMoney(...rows.map((r) => r.total))],
              ['paid', addMoney(...rows.map((r) => r.amountPaid))],
              ['balance', addMoney(...rows.map((r) => r.balanceDue))],
            ] as const
          ).map(([key, amount]) => (
            <div key={key} className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">{t(`fin.invoices.totals.${key}`)}</dt>
              <dd className="text-base font-semibold text-foreground">
                <Money amount={amount} currency={currency} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}
