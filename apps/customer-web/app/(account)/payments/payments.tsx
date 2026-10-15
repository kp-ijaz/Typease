'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CircleCheck, CreditCard, Receipt, ReceiptText } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, DataTable, EmptyState, PageHeader, Skeleton, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, addMoney, useI18n, type DataTableColumn,
  type DataTableFilter, type RowAction,
} from '@typease/ui';
import { useUnpaidInvoices } from '@/components/portal/money-hooks';
import { PayInvoiceButton } from '@/components/portal/pay';
import { LoadError, Money, usePastDue, usePdfDownload } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { InvoiceRow, PaymentRow } from '@/lib/types';

const TABS = ['due', 'invoices', 'payments'] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);

const INVOICE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED', 'VOID'] as const;
const PAYMENT_STATUSES = ['COMPLETED', 'PENDING', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

/** Money: what is still to pay, every invoice, and every payment with its receipt. */
export function PaymentsOverview() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const unpaid = useUnpaidInvoices();
  const tabParam = search.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'due';
  const setTab = (next: string) => router.replace(next === 'due' ? pathname : `${pathname}?tab=${next}`, { scroll: false });

  return (
    <>
      <PageHeader title={t('nav.payments')} description={t('my.payments.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="-mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsTrigger value="due">
            {t('my.payments.tabs.due')}
            {unpaid.data?.length ? <Badge tone="warning">{unpaid.data.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="invoices">{t('my.payments.tabs.invoices')}</TabsTrigger>
          <TabsTrigger value="payments">{t('my.payments.tabs.payments')}</TabsTrigger>
        </TabsList>
        <TabsContent value="due">
          <DueInvoices />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTable />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentsTable />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- to pay

function DueInvoices() {
  const { t, tn, formatDate } = useI18n();
  const unpaid = useUnpaidInvoices();
  const pastDue = usePastDue();
  if (unpaid.isPending) {
    return (
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-24" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (unpaid.isError) return <LoadError error={unpaid.error} onRetry={() => void unpaid.refetch()} />;
  const invoices = unpaid.data;
  if (!invoices.length) {
    return (
      <Card>
        <EmptyState size="page" icon={<CircleCheck />} title={t('my.payments.nothingDueTitle')} description={t('my.payments.nothingDueText')} />
      </Card>
    );
  }
  // Balances are added in whole fils (no floating point), per currency.
  const balances = new Map<string, string>();
  for (const invoice of invoices) balances.set(invoice.currency, addMoney(balances.get(invoice.currency) ?? '0', invoice.balanceDue));

  return (
    <div className="space-y-4">
      <Card className="border-warning/60 bg-warning-soft/50" data-outstanding>
        <CardContent>
          <p className="text-sm font-medium text-muted-foreground">{t('my.payments.outstanding')}</p>
          <p className="mt-0.5 flex flex-wrap gap-x-4 text-3xl font-semibold">
            {[...balances.entries()].map(([currency, amount]) => (
              <Money key={currency} amount={amount} currency={currency} />
            ))}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{tn('my.payments.invoiceCount', invoices.length)}</p>
        </CardContent>
      </Card>
      <ul className="space-y-3">
        {invoices.map((invoice) => (
          <li key={invoice.id} className="rounded-lg border bg-card p-4 shadow-xs" data-invoice={invoice.invoiceNo}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="min-w-0 flex-1 basis-56 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link href={`/invoices/${invoice.id}`} className="tabular ltr-value text-md font-semibold text-foreground hover:underline">
                    {invoice.invoiceNo}
                  </Link>
                  <StatusBadge kind="invoice" status={invoice.status} />
                  {pastDue(invoice) ? <Badge tone="danger">{t('my.invoices.overdue')}</Badge> : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {invoice.request ? (
                    <>
                      {t('my.payments.forRequest')} <span className="tabular ltr-value">{invoice.request.requestNo}</span>
                      <span aria-hidden="true"> – </span>
                    </>
                  ) : null}
                  {invoice.dueAt ? t('my.invoices.dueOn', { date: formatDate(invoice.dueAt) }) : null}
                </p>
              </div>
              <p className="text-xl font-semibold">
                <Money amount={invoice.balanceDue} currency={invoice.currency} />
              </p>
              <div className="flex w-full gap-2 sm:w-auto">
                <Button asChild variant="outline" className="flex-1 sm:flex-none">
                  <Link href={`/invoices/${invoice.id}`}>{t('common.view')}</Link>
                </Button>
                <PayInvoiceButton invoice={invoice} className="flex-1 sm:flex-none">
                  <CreditCard aria-hidden="true" />
                  {t('my.pay.pay')}
                </PayInvoiceButton>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- all invoices

function InvoicesTable() {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const columns = React.useMemo<Array<DataTableColumn<InvoiceRow>>>(
    () => [
      { id: 'number', header: t('my.invoices.columns.number'), mobile: 'title', className: 'whitespace-nowrap', cell: (i) => <span className="tabular ltr-value">{i.invoiceNo}</span> },
      { id: 'status', header: t('my.requests.columns.status'), mobile: 'badge', cell: (i) => <StatusBadge kind="invoice" status={i.status} /> },
      { id: 'request', header: t('my.quotations.columns.request'), className: 'whitespace-nowrap', cell: (i) => (i.request ? <span className="tabular ltr-value">{i.request.requestNo}</span> : null) },
      { id: 'issued', header: t('my.invoices.issued'), className: 'whitespace-nowrap', cell: (i) => (i.issuedAt ? formatDate(i.issuedAt) : null) },
      { id: 'total', header: t('my.fees.total'), align: 'end', className: 'whitespace-nowrap', cell: (i) => <Money amount={i.total} currency={i.currency} /> },
      {
        id: 'balance',
        header: t('my.payments.toPay'),
        align: 'end',
        className: 'whitespace-nowrap',
        cell: (i) => (i.status === 'VOID' || Number(i.balanceDue) === 0 ? null : <Money amount={i.balanceDue} currency={i.currency} className="font-medium" />),
      },
    ],
    [t, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'status', type: 'select', label: t('my.requests.columns.status'), options: INVOICE_STATUSES.map((s) => ({ value: s, label: t(`my.invoices.status.${s}`) })) }],
    [t],
  );
  return (
    <DataTable<InvoiceRow>
      caption={t('my.payments.tabs.invoices')}
      queryKey={keys.invoices.all}
      queryFn={(params, signal) => api.invoices(params, signal)}
      columns={columns}
      rowKey={(i) => i.id}
      rowHref={(i) => `/invoices/${i.id}`}
      filters={filters}
      syncUrl={false}
      searchPlaceholder={t('my.invoices.search')}
      defaultSort="createdAt:desc"
      empty={{ icon: <ReceiptText />, title: t('my.invoices.emptyTitle'), description: t('my.invoices.emptyText') }}
    />
  );
}

// ---------------------------------------------------------------- payments and receipts

function PaymentsTable() {
  const { t, formatDateTime } = useI18n();
  const api = usePortalApi();
  const pdf = usePdfDownload();
  const columns = React.useMemo<Array<DataTableColumn<PaymentRow>>>(
    () => [
      { id: 'receipt', header: t('my.payments.columns.receipt'), mobile: 'title', className: 'whitespace-nowrap', cell: (p) => <span className="tabular ltr-value">{p.receiptNo ?? p.paymentNo}</span> },
      { id: 'status', header: t('my.requests.columns.status'), mobile: 'badge', cell: (p) => <StatusBadge kind="payment" status={p.status} /> },
      { id: 'date', header: t('my.payments.columns.date'), className: 'whitespace-nowrap', cell: (p) => formatDateTime(p.receivedAt ?? p.createdAt) },
      { id: 'method', header: t('my.payments.columns.method'), cell: (p) => t(`my.payments.methods.${p.method}`) },
      {
        id: 'invoice',
        header: t('account.titles.invoiceDetail'),
        cell: (p) => (p.paymentAllocations.length ? <span className="tabular ltr-value">{p.paymentAllocations.map((a) => a.invoice?.invoiceNo).filter(Boolean).join(', ')}</span> : p.reference ? <span className="tabular ltr-value">{p.reference}</span> : null),
      },
      { id: 'amount', header: t('my.pay.amount'), align: 'end', className: 'whitespace-nowrap', cell: (p) => <Money amount={p.amount} currency={p.currency} className="font-medium" /> },
    ],
    [t, formatDateTime],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'status', type: 'select', label: t('my.requests.columns.status'), options: PAYMENT_STATUSES.map((s) => ({ value: s, label: t(`my.payments.status.${s}`) })) }],
    [t],
  );
  const rowActions = React.useMemo<Array<RowAction<PaymentRow>>>(
    () => [
      {
        id: 'receipt',
        label: t('my.payments.downloadReceipt'),
        icon: <Receipt aria-hidden="true" />,
        hidden: (p) => !p.receiptNo,
        onSelect: (p) => void pdf.save(`/payments/${p.id}/receipt/pdf`, `${p.receiptNo}.pdf`),
      },
      { id: 'invoice', label: t('my.payments.openInvoice'), icon: <ReceiptText aria-hidden="true" />, hidden: (p) => !p.paymentAllocations.length, href: (p) => `/invoices/${p.paymentAllocations[0].invoiceId}` },
    ],
    [t, pdf],
  );
  return (
    <DataTable<PaymentRow>
      caption={t('my.payments.tabs.payments')}
      queryKey={keys.payments.all}
      queryFn={(params, signal) => api.payments(params, signal)}
      columns={columns}
      rowKey={(p) => p.id}
      rowActions={rowActions}
      filters={filters}
      // Abandoned checkouts stay "pending" for ever: the list starts with the payments that were received.
      initialFilterValues={{ status: 'COMPLETED' }}
      syncUrl={false}
      searchable={false}
      defaultSort="createdAt:desc"
      empty={{ icon: <Receipt />, title: t('my.payments.emptyTitle'), description: t('my.payments.emptyText') }}
    />
  );
}
