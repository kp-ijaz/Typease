'use client';

import * as React from 'react';
import Link from 'next/link';
import { CreditCard, ExternalLink, Plus, Printer, Undo2 } from 'lucide-react';
import { PaymentMethodValues, PaymentStatusValues } from '@typease/types';
import {
  Badge, Button, DataTable, PageHeader, PermissionGate, STATUS_META, StatusBadge, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { FinanceToolsMenu } from '@/components/fin/finance-tabs';
import { ScopeBar, useScopeParams } from '@/components/fin/scope-filters';
import { Money, PdfDialog, useBranchFilter } from '@/components/fin/shared';
import type { PaymentRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const SCOPE = ['customerId', 'corporateAccountId', 'invoiceId', 'requestId'] as const;
const REFUNDABLE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED']);

export function PaymentsList() {
  const { t, pick, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const scope = useScopeParams(SCOPE);
  const branchFilter = useBranchFilter();
  const [receipt, setReceipt] = React.useState<PaymentRow | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<PaymentRow>>>(
    () => [
      { id: 'number', header: t('fin.payments.columns.number'), sortField: 'paymentNo', mobile: 'title', className: 'whitespace-nowrap', cell: (p) => <span className="tabular">{p.paymentNo}</span> },
      { id: 'customer', header: t('fin.common.customer'), cell: (p) => (p.customer ? <span className="font-medium text-foreground">{p.customer.fullName}</span> : null) },
      {
        id: 'method',
        header: t('fin.payments.columns.method'),
        className: 'whitespace-nowrap',
        cell: (p) => (
          <>
            {t(`fin.methods.${p.method}`)}
            {p.reference ? <span className="block max-w-44 truncate text-sm text-muted-foreground" dir="auto" title={p.reference}>{p.reference}</span> : null}
          </>
        ),
      },
      { id: 'status', header: t('fin.common.status'), mobile: 'badge', cell: (p) => <StatusBadge kind="payment" status={p.status} /> },
      {
        id: 'invoices',
        header: t('fin.payments.columns.invoices'),
        className: 'tabular',
        cell: (p) => (p.paymentAllocations.length ? p.paymentAllocations.map((a) => a.invoice.invoiceNo).join(', ') : null),
      },
      { id: 'received', header: t('fin.payments.columns.received'), sortField: 'receivedAt', className: 'whitespace-nowrap tabular', cell: (p) => (p.receivedAt ? formatDateTime(p.receivedAt) : null) },
      {
        id: 'amount',
        header: t('fin.common.amount'),
        sortField: 'amount',
        align: 'end',
        cell: (p) => (
          <>
            <Money amount={p.amount} currency={p.currency} className="font-medium" />
            {Number(p.refundedAmount) > 0 ? (
              <span className="block text-sm text-muted-foreground">
                {t('fin.payments.refundedShort')} <Money amount={p.refundedAmount} currency={p.currency} />
              </span>
            ) : null}
          </>
        ),
      },
      {
        id: 'reconciled',
        header: t('fin.payments.columns.reconciled'),
        mobile: 'hidden',
        cell: (p) => (REFUNDABLE.has(p.status) || p.status === 'REFUNDED' ? <Badge tone={p.reconciledAt ? 'success' : 'neutral'}>{p.reconciledAt ? t('fin.payments.reconciled.yes') : t('fin.payments.reconciled.no')}</Badge> : null),
      },
    ],
    [t, formatDateTime],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'method', type: 'select', label: t('fin.payments.columns.method'), options: PaymentMethodValues.map((m) => ({ value: m, label: t(`fin.methods.${m}`) })) },
      { id: 'status', type: 'select', label: t('fin.common.status'), options: PaymentStatusValues.map((s) => ({ value: s, label: pick(STATUS_META.payment[s].en, STATUS_META.payment[s].ar) })) },
      ...branchFilter,
      { id: 'reconciled', type: 'select', label: t('fin.payments.columns.reconciled'), options: [{ value: 'true', label: t('fin.payments.reconciled.yes') }, { value: 'false', label: t('fin.payments.reconciled.no') }] },
      { id: 'received', type: 'dateRange', label: t('fin.payments.columns.received'), fromKey: 'from', toKey: 'to' },
    ],
    [t, pick, branchFilter],
  );

  const mayRefund = session.hasPermission('refund.request');
  const rowActions = React.useMemo<Array<RowAction<PaymentRow>>>(
    () => [
      { id: 'open', label: t('fin.payments.open'), icon: <ExternalLink aria-hidden="true" />, href: (p) => `/payments/${p.id}` },
      { id: 'receipt', label: t('fin.payments.printReceipt'), icon: <Printer aria-hidden="true" />, onSelect: (p) => setReceipt(p), hidden: (p) => !p.receiptNo },
      { id: 'refund', label: t('fin.payments.requestRefund'), icon: <Undo2 aria-hidden="true" />, href: (p) => `/refunds/new?paymentId=${p.id}`, hidden: (p) => !mayRefund || !REFUNDABLE.has(p.status) },
    ],
    [t, mayRefund],
  );

  const record = (
    <PermissionGate permission="payment.record">
      <Button asChild variant="accent">
        <Link href="/payments/new">
          <Plus aria-hidden="true" />
          {t('fin.payments.record')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('fin.payments.title')} description={t('fin.payments.description')} action={record} secondary={<FinanceToolsMenu />} />
      <ScopeBar scope={scope} show={SCOPE} />
      <DataTable<PaymentRow>
        caption={t('fin.payments.title')}
        queryKey={finKeys.payments.all}
        queryFn={(params, signal) => api.payments.list(params, signal)}
        fixedParams={scope.params}
        columns={columns}
        rowKey={(p) => p.id}
        rowHref={(p) => `/payments/${p.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.payments.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <CreditCard />, title: t('fin.payments.emptyTitle'), description: t('fin.payments.emptyText'), action: record }}
      />
      {receipt ? (
        <PdfDialog
          open
          onOpenChange={(open) => !open && setReceipt(null)}
          path={api.payments.receiptPath(receipt.id)}
          title={t('fin.payments.receiptTitle', { number: receipt.receiptNo ?? receipt.paymentNo })}
          fallbackFilename={`${receipt.receiptNo ?? receipt.paymentNo}.pdf`}
        />
      ) : null}
    </>
  );
}
