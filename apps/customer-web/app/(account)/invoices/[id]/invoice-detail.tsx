'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download, Receipt, Store } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, DescriptionList, PageHeader, StatusBadge, useBranding, useI18n } from '@typease/ui';
import { FeeLines } from '@/components/portal/fee-lines';
import { PayInvoiceButton } from '@/components/portal/pay';
import { DetailSkeleton, LoadError, Money, NotFoundCard, SectionTitle, isNotFound, useBranchName, usePastDue, usePdfDownload } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';

export const isPayable = (invoice: { status: string; balanceDue: string }) => (invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID') && Number(invoice.balanceDue) > 0;

/** One invoice: what it is for, what is still to pay, how to pay it, and the payments made so far. */
export function InvoiceDetail({ id }: { id: string }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = usePortalApi();
  const { name } = useBranding();
  const pdf = usePdfDownload();
  const pastDue = usePastDue();
  const branchName = useBranchName();
  const query = useQuery({ queryKey: keys.invoices.detail(id), queryFn: () => api.invoice(id), retry: (count, error) => !isNotFound(error) && count < 2 });

  const crumbs = [{ label: t('nav.payments'), href: '/payments' }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('account.titles.invoiceDetail')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('account.titles.invoiceDetail')} />
        {isNotFound(query.error) ? (
          <NotFoundCard title={t('my.invoices.notFoundTitle')} text={t('my.invoices.notFoundText')} backHref="/payments" backLabel={t('nav.payments')} />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const invoice = query.data;
  const payable = isPayable(invoice);
  const pdfPath = `/invoices/${invoice.id}/pdf`;
  const received = invoice.payments.filter((p) => p.status !== 'PENDING' && p.status !== 'FAILED' && p.status !== 'CANCELLED');

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <>
            {t('account.titles.invoiceDetail')} <span className="tabular ltr-value">{invoice.invoiceNo}</span>
          </>
        }
        meta={
          <>
            <StatusBadge kind="invoice" status={invoice.status} className="px-3 py-1 text-sm" />
            {pastDue(invoice) && payable ? <Badge tone="danger">{t('my.invoices.overdue')}</Badge> : null}
          </>
        }
        secondary={
          <Button variant="outline" loading={pdf.busy === pdfPath} loadingText={t('common.loading')} onClick={() => void pdf.save(pdfPath, `${invoice.invoiceNo}.pdf`)}>
            <Download aria-hidden="true" />
            {t('my.common.pdf')}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-5">
          {payable ? (
            <Card className="border-warning/60 bg-warning-soft/50" data-pay-card>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{t('my.payments.toPay')}</p>
                    <p className="text-3xl font-semibold text-foreground">
                      <Money amount={invoice.balanceDue} currency={invoice.currency} />
                    </p>
                    {invoice.dueAt ? <p className="mt-0.5 text-sm text-muted-foreground">{t('my.invoices.dueOn', { date: formatDate(invoice.dueAt) })}</p> : null}
                  </div>
                  <PayInvoiceButton size="lg" variant="accent" className="w-full sm:w-auto" invoice={invoice} />
                </div>
                <p className="flex gap-2 text-sm text-muted-foreground">
                  <Store className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {t('my.invoices.payAtCentre', { centre: name })}
                </p>
              </CardContent>
            </Card>
          ) : null}
          {invoice.status === 'VOID' ? <Alert tone="info">{t('my.invoices.voidText')}</Alert> : null}

          <Card>
            <CardContent>
              <FeeLines lines={invoice.invoiceItems} totals={invoice}>
                {Number(invoice.amountCredited) > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('my.invoices.credited')}</dt>
                    <dd>
                      − <Money amount={invoice.amountCredited} currency={invoice.currency} />
                    </dd>
                  </div>
                ) : null}
                {Number(invoice.amountPaid) > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('my.request.money.paid')}</dt>
                    <dd>
                      − <Money amount={invoice.amountPaid} currency={invoice.currency} />
                    </dd>
                  </div>
                ) : null}
                {Number(invoice.amountRefunded) > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('my.invoices.refunded')}</dt>
                    <dd>
                      <Money amount={invoice.amountRefunded} currency={invoice.currency} />
                    </dd>
                  </div>
                ) : null}
                {invoice.status !== 'VOID' ? (
                  <div className="flex justify-between gap-4 border-t pt-2 text-md font-semibold" data-balance={invoice.balanceDue}>
                    <dt>{t('my.payments.toPay')}</dt>
                    <dd>
                      <Money amount={invoice.balanceDue} currency={invoice.currency} />
                    </dd>
                  </div>
                ) : null}
              </FeeLines>
              {invoice.notes ? (
                <p className="mt-4 whitespace-pre-wrap border-t pt-4 text-base text-foreground/85" dir="auto">
                  {invoice.notes}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4">
              <SectionTitle>{t('my.invoices.history')}</SectionTitle>
              {received.length === 0 && invoice.creditNotes.length === 0 ? (
                <p className="text-base text-muted-foreground">{t('my.invoices.noPayments')}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {received.map((p) => {
                    const receiptPath = `/payments/${p.id}/receipt/pdf`;
                    return (
                      <li key={p.allocationId} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3.5">
                        <div className="min-w-0 flex-1 basis-44">
                          <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                            <Money amount={p.allocated} currency={invoice.currency} />
                            <StatusBadge kind="payment" status={p.status} />
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {t(`my.payments.methods.${p.method}`)}
                            <span aria-hidden="true"> – </span>
                            {formatDateTime(p.receivedAt)}
                            {p.receiptNo ? (
                              <>
                                <span aria-hidden="true"> – </span>
                                <span className="tabular ltr-value">{p.receiptNo}</span>
                              </>
                            ) : null}
                          </p>
                        </div>
                        {p.receiptNo ? (
                          <Button size="sm" variant="outline" loading={pdf.busy === receiptPath} loadingText={t('common.loading')} onClick={() => void pdf.save(receiptPath, `${p.receiptNo}.pdf`)}>
                            <Receipt aria-hidden="true" />
                            {t('my.payments.receipt')}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                  {invoice.creditNotes.map((note) => {
                    const notePath = `/credit-notes/${note.id}/pdf`;
                    return (
                      <li key={note.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3.5">
                        <div className="min-w-0 flex-1 basis-44">
                          <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                            <Money amount={note.amount} currency={invoice.currency} />
                            <Badge tone="info">{t('my.invoices.creditNote')}</Badge>
                          </p>
                          <p className="text-sm text-muted-foreground">
                            <span className="tabular ltr-value">{note.creditNoteNo}</span>
                            <span aria-hidden="true"> – </span>
                            {formatDate(note.issuedAt)}
                            {note.reason ? (
                              <>
                                <span aria-hidden="true"> – </span>
                                <span dir="auto">{note.reason}</span>
                              </>
                            ) : null}
                          </p>
                        </div>
                        <Button size="sm" variant="outline" loading={pdf.busy === notePath} loadingText={t('common.loading')} onClick={() => void pdf.save(notePath, `${note.creditNoteNo}.pdf`)}>
                          <Download aria-hidden="true" />
                          {t('my.common.pdf')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <aside>
          <Card>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('my.invoices.issued'), value: invoice.issuedAt ? formatDate(invoice.issuedAt) : null },
                  ...(invoice.dueAt && invoice.status !== 'PAID' && invoice.status !== 'VOID' ? [{ label: t('my.invoices.due'), value: formatDate(invoice.dueAt) }] : []),
                  ...(invoice.request ? [{ label: t('my.quotations.columns.request'), value: <Link href={`/requests/${invoice.request.id}`} className="tabular ltr-value font-medium text-secondary-text hover:underline">{invoice.request.requestNo}</Link> }] : []),
                  ...(invoice.quotation ? [{ label: t('account.titles.quotationDetail'), value: <Link href={`/quotations/${invoice.quotation.id}`} className="tabular ltr-value font-medium text-secondary-text hover:underline">{invoice.quotation.quotationNo}</Link> }] : []),
                  ...(invoice.branch ? [{ label: t('my.wizard.service.branch'), value: branchName(invoice.branch) }] : []),
                ]}
              />
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
