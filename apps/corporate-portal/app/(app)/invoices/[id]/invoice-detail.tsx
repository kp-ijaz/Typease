'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download, Receipt, Store } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, DescriptionList, PageHeader, StatusBadge, useBranding, useI18n } from '@typease/ui';
import { FeeLines } from '@/components/portal/fee-lines';
import { PayInvoiceButton } from '@/components/portal/pay';
import { DetailSkeleton, Gate, isForbidden, isNotFound, LoadError, Ltr, Money, NoAccess, NotFoundCard, PersonName, retryUnlessFinal, SectionTitle, useBranchName, usePastDue, usePdfDownload, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import { isPayable } from '../invoices';

export function InvoiceDetail({ id }: { id: string }) {
  return (
    <Gate anyOf={['corp.invoices.read']}>
      <Detail id={id} />
    </Gate>
  );
}

/** One invoice of the company: what it is for, what is still open and until when, how to pay it, and the payments so far. */
function Detail({ id }: { id: string }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = usePortalApi();
  const { name } = useBranding();
  const role = useRole();
  const pdf = usePdfDownload();
  const pastDue = usePastDue();
  const branchName = useBranchName();
  const query = useQuery({ queryKey: keys.invoices.detail(id), queryFn: () => api.invoice(id), retry: retryUnlessFinal });

  const crumbs = [{ label: t('nav.invoices'), href: ROUTES.invoices }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.invoiceDetail')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.invoiceDetail')} />
        {isNotFound(query.error) ? (
          <NotFoundCard title={t('my.invoices.notFoundTitle')} text={t('my.invoices.notFoundText')} backHref={ROUTES.invoices} backLabel={t('nav.invoices')} />
        ) : isForbidden(query.error) ? (
          <NoAccess />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const invoice = query.data;
  const payable = isPayable(invoice);
  const late = payable && pastDue(invoice);
  const pdfPath = `/invoices/${invoice.id}/pdf`;
  const received = invoice.payments.filter((p) => p.status !== 'PENDING' && p.status !== 'FAILED' && p.status !== 'CANCELLED');

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <>
            {t('titles.invoiceDetail')} <Ltr>{invoice.invoiceNo}</Ltr>
          </>
        }
        meta={
          <>
            <StatusBadge kind="invoice" status={invoice.status} className="px-3 py-1 text-sm" />
            {late ? <Badge tone="danger">{t('my.invoices.overdue')}</Badge> : null}
          </>
        }
        secondary={
          <Button variant="outline" loading={pdf.busy === pdfPath} loadingText={t('common.loading')} onClick={() => void pdf.save(pdfPath, `${invoice.invoiceNo}.pdf`)} data-action="invoice-pdf">
            <Download aria-hidden="true" />
            {t('my.common.pdf')}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-5">
          {payable ? (
            <Card className={late ? 'border-destructive/40 bg-destructive-soft/40' : 'border-warning/60 bg-warning-soft/50'} data-pay-card>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{t('my.invoices.toPay')}</p>
                    <p className="text-3xl font-semibold text-foreground">
                      <Money amount={invoice.balanceDue} currency={invoice.currency} />
                    </p>
                    {invoice.dueAt ? <p className="mt-0.5 text-sm text-muted-foreground">{t('my.invoices.dueOn', { date: formatDate(invoice.dueAt) })}</p> : null}
                  </div>
                  <PayInvoiceButton size="lg" variant="accent" className="w-full sm:w-auto" invoice={invoice} />
                </div>
                <p className="flex gap-2 text-sm text-muted-foreground">
                  <Store className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {t('my.invoices.payOtherwise', { centre: name })}
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
                    <dt>{t('my.invoices.toPay')}</dt>
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
                            {t(`my.invoices.methods.${p.method}`)}
                            <span aria-hidden="true"> – </span>
                            {formatDateTime(p.receivedAt)}
                            {p.receiptNo ? (
                              <>
                                <span aria-hidden="true"> – </span>
                                <Ltr>{p.receiptNo}</Ltr>
                              </>
                            ) : null}
                          </p>
                        </div>
                        {p.receiptNo ? (
                          <Button size="sm" variant="outline" loading={pdf.busy === receiptPath} loadingText={t('common.loading')} onClick={() => void pdf.save(receiptPath, `${p.receiptNo}.pdf`)}>
                            <Receipt aria-hidden="true" />
                            {t('my.invoices.receipt')}
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
                            <Ltr>{note.creditNoteNo}</Ltr>
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
                  ...(invoice.customer ? [{ label: t('my.requests.columns.person'), value: <PersonName name={invoice.customer.fullName} erased={invoice.customer.erased} /> }] : []),
                  { label: t('my.invoices.issued'), value: invoice.issuedAt ? formatDate(invoice.issuedAt) : null },
                  ...(invoice.dueAt && invoice.status !== 'PAID' && invoice.status !== 'VOID' ? [{ label: t('my.invoices.due'), value: formatDate(invoice.dueAt) }] : []),
                  ...(invoice.request
                    ? [
                        {
                          label: t('my.approvals.columns.request'),
                          value: (
                            <Link href={`${ROUTES.requests}/${invoice.request.id}`} className="font-medium text-secondary-text hover:underline">
                              <Ltr>{invoice.request.requestNo}</Ltr>
                            </Link>
                          ),
                        },
                      ]
                    : []),
                  ...(invoice.quotation
                    ? [
                        {
                          label: t('titles.quotationDetail'),
                          value: role.canApprove ? (
                            <Link href={`${ROUTES.approvals}/${invoice.quotation.id}`} className="font-medium text-secondary-text hover:underline">
                              <Ltr>{invoice.quotation.quotationNo}</Ltr>
                            </Link>
                          ) : (
                            <Ltr>{invoice.quotation.quotationNo}</Ltr>
                          ),
                        },
                      ]
                    : []),
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
