'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus, Receipt } from 'lucide-react';
import type { Page } from '@typease/types';
import type { RequestListItem } from '@typease/api-client';
import { Badge, Button, DataTable, EmptyState, PermissionGate, Skeleton, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn, useApi, useI18n, useSession, type DataTableColumn } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, RecordLink, Section, isErasedName } from '../shared';
import type { CorporateAccountDetail, CorporateStatement, InvoiceRow } from '../types';

/**
 * The employee a request or an invoice is for. A person whose data was erased keeps the requests and invoices
 * (as figures), but the record no longer opens: a placeholder without a link.
 */
function PersonCell({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  if (isErasedName(name)) return <span className="text-muted-foreground">{t('people.common.erasedCustomer')}</span>;
  return (
    <RecordLink href={`/customers/${id}`} className="relative z-10 font-normal">
      {name}
    </RecordLink>
  );
}

/** Requests filed for the company (the requests list filtered by `corporateAccountId`). Read-only. */
export function CorporateRequestsTab({ account }: { account: CorporateAccountDetail }) {
  const { t, pick, formatDate } = useI18n();
  const api = useApi();
  const columns = React.useMemo<Array<DataTableColumn<RequestListItem>>>(
    () => [
      { id: 'number', header: t('requests.columns.number'), mobile: 'title', className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.requestNo}</span> },
      { id: 'customer', header: t('people.corporate.records.employee'), cell: (r) => <PersonCell id={r.customer.id} name={r.customerName} /> },
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
      { id: 'submitted', header: t('requests.columns.submitted'), className: 'whitespace-nowrap tabular', cell: (r) => (r.submittedAt ? formatDate(r.submittedAt) : <span className="text-muted-foreground">{t('requests.notSubmitted')}</span>) },
      { id: 'target', header: t('requests.columns.target'), className: 'whitespace-nowrap tabular', cell: (r) => (r.targetDate ? formatDate(r.targetDate) : null) },
    ],
    [t, pick, formatDate],
  );
  const newRequest =
    account.status === 'ACTIVE' ? (
      <PermissionGate permission="request.create">
        <Button asChild variant="outline">
          <Link href={`/requests/new?corporateAccountId=${account.id}`}>
            <Plus aria-hidden="true" />
            {t('requests.new')}
          </Link>
        </Button>
      </PermissionGate>
    ) : null;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('people.corporate.records.requestsText')}</p>
        {newRequest}
      </div>
      <DataTable<RequestListItem>
        caption={t('people.corporate.tabs.requests')}
        queryKey={peopleKeys.corporate.tab(account.id, 'requests')}
        queryFn={(params, signal) => api.requests.list(params, signal)}
        fixedParams={{ corporateAccountId: account.id }}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/requests/${r.id}`}
        defaultSort="createdAt:desc"
        defaultPageSize={10}
        searchable={false}
        syncUrl={false}
        empty={{ icon: <ClipboardList />, title: t('people.corporate.records.requestsEmpty'), description: t('people.corporate.records.requestsEmptyText'), action: newRequest }}
      />
    </>
  );
}

const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'] as const;

/**
 * Invoices and statement, read-only: what the company owes by age (GET /finance/corporate-accounts/:id/statement,
 * all amounts computed by the API), the open invoices, and every invoice of the company.
 */
export function CorporateInvoicesTab({ account }: { account: CorporateAccountDetail }) {
  const { t, tn, formatDate, formatDateTime, formatMoney } = useI18n();
  const api = useApi();
  const session = useSession();
  const canStatement = session.hasAnyPermission(['invoice.read', 'report.financial']);
  const statement = useQuery({
    queryKey: peopleKeys.corporate.statement(account.id),
    queryFn: () => api.client.get<CorporateStatement>(`/finance/corporate-accounts/${account.id}/statement`),
    enabled: canStatement,
  });

  const columns = React.useMemo<Array<DataTableColumn<InvoiceRow>>>(
    () => [
      { id: 'number', header: t('people.customer.tabs.invoiceNo'), mobile: 'title', className: 'whitespace-nowrap', cell: (i) => <span className="tabular">{i.invoiceNo}</span> },
      {
        id: 'status',
        header: t('requests.columns.status'),
        mobile: 'badge',
        cell: (i) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="invoice" status={i.status} />
            {i.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'customer', header: t('people.corporate.records.employee'), cell: (i) => (i.customer ? <PersonCell id={i.customer.id} name={i.customer.fullName} /> : null) },
      { id: 'request', header: t('people.customer.tabs.request'), className: 'whitespace-nowrap', cell: (i) => (i.request ? <RecordLink href={`/requests/${i.request.id}`} className="tabular relative z-10 font-normal">{i.request.requestNo}</RecordLink> : null) },
      { id: 'issued', header: t('people.customer.tabs.issued'), className: 'whitespace-nowrap tabular', cell: (i) => (i.issuedAt ? formatDate(i.issuedAt) : null) },
      { id: 'due', header: t('people.customer.tabs.due'), className: 'whitespace-nowrap tabular', cell: (i) => (i.dueAt ? formatDate(i.dueAt) : null) },
      { id: 'total', header: t('people.customer.tabs.total'), align: 'end', className: 'whitespace-nowrap tabular', cell: (i) => formatMoney(i.total, i.currency) },
      { id: 'balance', header: t('people.customer.tabs.balance'), align: 'end', className: 'whitespace-nowrap tabular', cell: (i) => (Number(i.balanceDue) === 0 ? null : <span className="font-medium text-foreground">{formatMoney(i.balanceDue, i.currency)}</span>) },
    ],
    [t, formatDate, formatMoney],
  );

  const s = statement.data;
  return (
    <div className="space-y-6">
      {canStatement ? (
        <Section title={t('people.corporate.statement.title')} description={s ? t('people.corporate.statement.asOf', { when: formatDateTime(s.asOf) }) : t('people.corporate.statement.description')}>
          {statement.isPending ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" role="status" aria-label={t('common.loading')}>
              {BUCKETS.map((b) => (
                <Skeleton key={b} className="h-20" />
              ))}
            </div>
          ) : statement.isError || !s ? (
            <LoadError error={statement.error} onRetry={() => void statement.refetch()} />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
                <p>
                  <span className="block text-sm text-muted-foreground">{t('people.corporate.statement.openBalance')}</span>
                  <span className="tabular text-2xl font-semibold text-foreground">{formatMoney(s.openBalance, s.currency)}</span>
                </p>
                <p>
                  <span className="block text-sm text-muted-foreground">{t('people.corporate.statement.availableCredit')}</span>
                  <span className="tabular text-lg font-medium text-foreground">{s.availableCredit === null ? t('people.corporate.statement.noCredit') : formatMoney(s.availableCredit, s.currency)}</span>
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {BUCKETS.map((bucket) => {
                  const amount = s.ageing[bucket];
                  const late = bucket !== 'current' && Number(amount) > 0;
                  return (
                    <div key={bucket} className={cn('rounded-lg border p-3', late ? 'border-destructive/25 bg-destructive-soft/60' : 'bg-muted/40')}>
                      <dt className="text-sm text-muted-foreground">{t(`people.corporate.statement.buckets.${bucket}`)}</dt>
                      <dd className={cn('tabular mt-0.5 text-md font-semibold', late ? 'text-destructive-text' : 'text-foreground')}>{formatMoney(amount, s.currency)}</dd>
                    </div>
                  );
                })}
              </dl>

              <h3 className="mb-2 mt-6 text-sm font-semibold text-muted-foreground">{tn('people.corporate.statement.openInvoices', s.invoices.length)}</h3>
              {s.invoices.length === 0 ? (
                <p className="text-base text-muted-foreground">{t('people.corporate.statement.nothingOpen')}</p>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <caption className="sr-only">{t('people.corporate.statement.title')}</caption>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{t('people.customer.tabs.invoiceNo')}</TableHead>
                        <TableHead>{t('people.customer.tabs.due')}</TableHead>
                        <TableHead>{t('people.corporate.statement.age')}</TableHead>
                        <TableHead className="text-end">{t('people.customer.tabs.total')}</TableHead>
                        <TableHead className="text-end">{t('people.customer.tabs.balance')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.invoices.map((invoice) => (
                        <TableRow key={invoice.id}>
                          <TableCell className="whitespace-nowrap">
                            <RecordLink href={`/invoices/${invoice.id}`} className="tabular">
                              {invoice.invoiceNo}
                            </RecordLink>
                          </TableCell>
                          <TableCell className="tabular whitespace-nowrap">{invoice.dueAt ? formatDate(invoice.dueAt) : '–'}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {invoice.daysOverdue > 0 ? <Badge tone="danger">{tn('people.corporate.statement.daysOverdue', invoice.daysOverdue)}</Badge> : <span className="text-muted-foreground">{t('people.corporate.statement.buckets.current')}</span>}
                          </TableCell>
                          <TableCell className="tabular whitespace-nowrap text-end">{formatMoney(invoice.total, invoice.currency)}</TableCell>
                          <TableCell className="tabular whitespace-nowrap text-end font-medium text-foreground">{formatMoney(invoice.balanceDue, invoice.currency)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </Section>
      ) : null}

      {session.hasPermission('invoice.read') ? (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-md font-semibold text-foreground">{t('people.corporate.records.allInvoices')}</h2>
            <PermissionGate permission="invoice.manage">
              {account.status === 'ACTIVE' ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/invoices/new">
                    <Plus aria-hidden="true" />
                    {t('people.customer.tabs.newInvoice')}
                  </Link>
                </Button>
              ) : null}
            </PermissionGate>
          </div>
          <DataTable<InvoiceRow>
            caption={t('people.corporate.records.allInvoices')}
            queryKey={peopleKeys.corporate.tab(account.id, 'invoices')}
            queryFn={(params, signal) => api.client.get<Page<InvoiceRow>>('/invoices', { query: params, signal })}
            fixedParams={{ corporateAccountId: account.id }}
            columns={columns}
            rowKey={(i) => i.id}
            rowHref={(i) => `/invoices/${i.id}`}
            defaultSort="createdAt:desc"
            defaultPageSize={10}
            searchable={false}
            syncUrl={false}
            empty={{ icon: <Receipt />, title: t('people.corporate.records.invoicesEmpty'), description: t('people.corporate.records.invoicesEmptyText') }}
          />
        </section>
      ) : !canStatement ? (
        <EmptyState icon={<Receipt />} title={t('session.noPermissionTitle')} description={t('session.noPermissionDescription')} />
      ) : null}
    </div>
  );
}
