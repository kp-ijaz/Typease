'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CreditCard, Download, Printer, ReceiptText } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, DataTable, EmptyState, PageHeader, Skeleton, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, cn, useI18n, type DataTableColumn,
  type DataTableFilter, type RowAction,
} from '@typease/ui';
import { PayInvoiceButton } from '@/components/portal/pay';
import { Gate, LoadError, Ltr, Money, PersonName, retryUnlessFinal, SectionTitle, usePastDue, usePdfDownload } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { AgeingBucket, InvoiceRow, Statement } from '@/lib/types';

const TABS = ['due', 'all'] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);
const INVOICE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED', 'VOID'] as const;
const AGEING: AgeingBucket[] = ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'];

export const isPayable = (invoice: { status: string; balanceDue: string }) => (invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID') && Number(invoice.balanceDue) > 0;

export function useStatement() {
  const api = usePortalApi();
  return useQuery({ queryKey: keys.invoices.statement, queryFn: () => api.statement(), retry: retryUnlessFinal, staleTime: 30_000 });
}

/**
 * The company's money with the centre: the statement (what is open, how old it is, how much of
 * the approved credit is used) and every invoice. All figures are the API's; nothing is added up here.
 */
export function Invoices() {
  return (
    <Gate anyOf={['corp.invoices.read']}>
      <InvoicesPage />
    </Gate>
  );
}

function InvoicesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const statement = useStatement();
  const tabParam = search.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'due';
  const setTab = (next: string) => router.replace(next === 'due' ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  return (
    <>
      <PageHeader
        title={t('nav.invoices')}
        description={t('sections.invoices')}
        secondary={
          <Button variant="outline" className="no-print" onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            {t('my.statement.print')}
          </Button>
        }
      />
      <StatementSummary />
      <Tabs value={tab} onValueChange={setTab} className="mt-6">
        <TabsList className="no-print -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsTrigger value="due">
            {t('my.invoices.tabs.due')}
            {statement.data?.invoices.length ? <Badge tone="warning">{statement.data.invoices.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="all">{t('my.invoices.tabs.all')}</TabsTrigger>
        </TabsList>
        <TabsContent value="due">
          <OpenInvoices />
        </TabsContent>
        <TabsContent value="all">
          <AllInvoices />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- statement

/** How much of the approved credit is in use, as a bar with the figures in words beside it. */
function CreditUsage({ statement }: { statement: Statement }) {
  const { t, formatMoney, formatNumber } = useI18n();
  const { creditLimit } = statement.account;
  if (!creditLimit || Number(creditLimit) <= 0) return null;
  // A share for the width of the bar only; the amounts shown are the API's.
  const used = Math.min(100, Math.max(0, Math.round((Number(statement.openBalance) / Number(creditLimit)) * 100)));
  return (
    <div data-credit-usage={used}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium text-muted-foreground">{t('my.statement.creditUsed')}</p>
        <p className="text-sm text-foreground">{t('my.statement.creditOf', { used: formatMoney(statement.openBalance, statement.currency), limit: formatMoney(creditLimit, statement.currency) })}</p>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={t('my.statement.creditPercent', { percent: formatNumber(used) })}
        aria-label={t('my.statement.creditUsed')}
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full', used >= 90 ? 'bg-destructive' : used >= 70 ? 'bg-warning' : 'bg-secondary')} style={{ width: `${used}%` }} />
      </div>
      {statement.availableCredit !== null ? <p className="mt-1.5 text-sm text-muted-foreground">{t('my.statement.creditAvailable', { amount: formatMoney(statement.availableCredit, statement.currency) })}</p> : null}
    </div>
  );
}

function StatementSummary() {
  const { t, tn, formatDate } = useI18n();
  const statement = useStatement();
  if (statement.isPending) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    );
  }
  if (statement.isError) return <LoadError error={statement.error} onRetry={() => void statement.refetch()} />;
  const s = statement.data;
  const owing = Number(s.openBalance) > 0;
  const overdue = AGEING.slice(1).some((bucket) => Number(s.ageing[bucket]) > 0);
  const terms = s.account.creditApproved;
  return (
    <section aria-label={t('my.statement.title')} className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-statement>
      <Card className={cn(owing && (overdue ? 'border-destructive/40 bg-destructive-soft/40' : 'border-warning/60 bg-warning-soft/50'))}>
        <CardContent className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{t('my.statement.outstanding')}</p>
          <p className="text-3xl font-semibold text-foreground" data-open-balance={s.openBalance}>
            <Money amount={s.openBalance} currency={s.currency} />
          </p>
          <p className="text-sm text-muted-foreground">
            {owing ? tn('my.statement.openCount', s.invoices.length) : t('my.statement.nothingOpen')}
            <span aria-hidden="true"> – </span>
            {t('my.statement.asOf', { date: formatDate(s.asOf) })}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-sm font-medium text-muted-foreground">{t('my.statement.terms')}</p>
            <p className="text-base font-medium text-foreground" data-payment-terms={terms ? s.account.paymentTermsDays : 0}>
              {terms && s.account.paymentTermsDays > 0 ? tn('my.company.termsDays', s.account.paymentTermsDays) : t('my.company.termsOnInvoice')}
            </p>
          </div>
          {terms ? <CreditUsage statement={s} /> : <p className="text-sm text-muted-foreground">{t('my.statement.noCredit')}</p>}
        </CardContent>
      </Card>
      {owing ? (
        <Card className="lg:col-span-2">
          <CardContent className="space-y-3">
            <SectionTitle className="text-md">{t('my.statement.ageingTitle')}</SectionTitle>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {AGEING.map((bucket) => {
                const amount = s.ageing[bucket];
                const late = bucket !== 'current' && Number(amount) > 0;
                return (
                  <div key={bucket} className={cn('rounded-lg border p-3', late && 'border-destructive/30 bg-destructive-soft/50')} data-ageing={bucket}>
                    <dt className="text-sm text-muted-foreground">{t(`my.statement.ageing.${bucket}`)}</dt>
                    <dd className={cn('mt-0.5 text-md font-semibold', Number(amount) === 0 && 'font-normal text-muted-foreground')}>
                      <Money amount={amount} currency={s.currency} />
                    </dd>
                  </div>
                );
              })}
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- what is open

function OpenInvoices() {
  const { t, tn, formatDate } = useI18n();
  const statement = useStatement();
  const pastDue = usePastDue();
  if (statement.isPending) {
    return (
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (statement.isError) return null;
  const invoices = statement.data.invoices;
  if (!invoices.length) {
    return (
      <Card>
        <EmptyState size="page" icon={<CircleCheck />} title={t('my.invoices.nothingDueTitle')} description={t('my.invoices.nothingDueText')} />
      </Card>
    );
  }
  return (
    <ul className="space-y-3">
      {invoices.map((invoice) => (
        <li key={invoice.id} className="rounded-lg border bg-card p-4 shadow-xs" data-invoice={invoice.invoiceNo}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-56 space-y-1">
              <p className="flex flex-wrap items-center gap-2">
                <Link href={`${ROUTES.invoices}/${invoice.id}`} className="text-md font-semibold text-foreground hover:underline">
                  <Ltr>{invoice.invoiceNo}</Ltr>
                </Link>
                <StatusBadge kind="invoice" status={invoice.status} />
                {invoice.daysOverdue > 0 && pastDue(invoice) ? <Badge tone="danger">{tn('my.invoices.overdueDays', invoice.daysOverdue)}</Badge> : null}
              </p>
              {invoice.customerName || invoice.customerErased || invoice.requestNo ? (
                <p className="flex flex-wrap items-center gap-x-2 text-base">
                  <PersonName name={invoice.customerName} erased={invoice.customerErased} />
                  {invoice.requestNo ? (
                    <>
                      {invoice.customerName || invoice.customerErased ? <span aria-hidden="true">–</span> : null}
                      <Ltr>{invoice.requestNo}</Ltr>
                    </>
                  ) : null}
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">
                {invoice.issuedAt ? t('my.invoices.issuedOn', { date: formatDate(invoice.issuedAt) }) : null}
                {invoice.dueAt ? (
                  <>
                    <span aria-hidden="true"> – </span>
                    {t('my.invoices.dueOn', { date: formatDate(invoice.dueAt) })}
                  </>
                ) : null}
              </p>
            </div>
            <p className="text-xl font-semibold">
              <Money amount={invoice.balanceDue} currency={invoice.currency} />
            </p>
            <div className="no-print flex w-full gap-2 sm:w-auto">
              <Button asChild variant="outline" className="flex-1 sm:flex-none">
                <Link href={`${ROUTES.invoices}/${invoice.id}`}>{t('common.view')}</Link>
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
  );
}

// ---------------------------------------------------------------- every invoice

function AllInvoices() {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const pdf = usePdfDownload();
  const pastDue = usePastDue();
  const columns = React.useMemo<Array<DataTableColumn<InvoiceRow>>>(
    () => [
      { id: 'number', header: t('my.invoices.columns.number'), mobile: 'title', className: 'whitespace-nowrap', cell: (i) => <Ltr>{i.invoiceNo}</Ltr> },
      {
        id: 'status',
        header: t('my.requests.columns.status'),
        mobile: 'badge',
        cell: (i) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="invoice" status={i.status} />
            {isPayable(i) && pastDue(i) ? <Badge tone="danger">{t('my.invoices.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'person', header: t('my.requests.columns.person'), cell: (i) => (i.customer ? <PersonName name={i.customer.fullName} erased={i.customer.erased} /> : null) },
      { id: 'request', header: t('my.approvals.columns.request'), className: 'whitespace-nowrap', cell: (i) => (i.request ? <Ltr>{i.request.requestNo}</Ltr> : null) },
      { id: 'issued', header: t('my.invoices.issued'), className: 'whitespace-nowrap', cell: (i) => (i.issuedAt ? formatDate(i.issuedAt) : null) },
      { id: 'due', header: t('my.invoices.due'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (i) => (i.dueAt && isPayable(i) ? formatDate(i.dueAt) : null) },
      { id: 'total', header: t('my.fees.total'), align: 'end', className: 'whitespace-nowrap', cell: (i) => <Money amount={i.total} currency={i.currency} /> },
      {
        id: 'balance',
        header: t('my.invoices.toPay'),
        align: 'end',
        className: 'whitespace-nowrap',
        cell: (i) => (i.status === 'VOID' || Number(i.balanceDue) === 0 ? null : <Money amount={i.balanceDue} currency={i.currency} className="font-medium" />),
      },
    ],
    [t, formatDate, pastDue],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('my.requests.columns.status'), options: INVOICE_STATUSES.map((s) => ({ value: s, label: t(`my.invoices.status.${s}`) })) },
      { id: 'issued', type: 'dateRange', label: t('my.invoices.issued'), fromKey: 'from', toKey: 'to' },
    ],
    [t],
  );
  const rowActions = React.useMemo<Array<RowAction<InvoiceRow>>>(
    () => [{ id: 'pdf', label: t('my.common.pdf'), icon: <Download aria-hidden="true" />, onSelect: (i) => void pdf.save(`/invoices/${i.id}/pdf`, `${i.invoiceNo}.pdf`) }],
    [t, pdf],
  );
  return (
    <DataTable<InvoiceRow>
      caption={t('my.invoices.tabs.all')}
      queryKey={keys.invoices.all}
      queryFn={(params, signal) => api.invoices(params, signal)}
      columns={columns}
      rowKey={(i) => i.id}
      rowHref={(i) => `${ROUTES.invoices}/${i.id}`}
      rowActions={rowActions}
      filters={filters}
      syncUrl={false}
      searchPlaceholder={t('my.invoices.search')}
      defaultSort="createdAt:desc"
      empty={{ icon: <ReceiptText />, title: t('my.invoices.emptyTitle'), description: t('my.invoices.emptyText') }}
    />
  );
}
