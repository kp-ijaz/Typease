'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, Receipt } from 'lucide-react';
import { Button, Card, CardContent, DescriptionList, PageHeader, Spinner, StatusBadge, cn, useI18n } from '@typease/ui';
import { LoadError, Money, NotFoundCard, isNotFound, usePdfDownload } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';

/** How long the page keeps asking while the provider's confirmation is on its way. */
const MAX_CHECKS = 20;
const CHECK_EVERY_MS = 2000;

/**
 * Where the payment provider sends the customer back to. The result shown here is
 * ALWAYS what the API says about the payment (GET /payments/:id): the address the
 * provider redirected to proves nothing. `result=cancelled` in the address is used
 * for one thing only: not to keep someone waiting who left the payment page.
 */
export function PaymentReturn({ paymentId, invoiceId }: { paymentId: string; invoiceId: string }) {
  const { t, formatDateTime } = useI18n();
  const api = usePortalApi();
  const queryClient = useQueryClient();
  const pdf = usePdfDownload();
  const search = useSearchParams();
  const leftEarly = search.get('result') === 'cancelled';
  const [checks, setChecks] = React.useState(0);

  const payment = useQuery({
    queryKey: keys.payments.detail(paymentId),
    queryFn: ({ signal }) => api.payment(paymentId, signal),
    enabled: !!paymentId,
    retry: (count, error) => !isNotFound(error) && count < 2,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' && !leftEarly && query.state.dataUpdateCount < MAX_CHECKS ? CHECK_EVERY_MS : false),
  });
  // Every answer counts as one check, also when it says the same as the one before.
  const { dataUpdatedAt } = payment;
  React.useEffect(() => {
    if (dataUpdatedAt) setChecks((n) => n + 1);
  }, [dataUpdatedAt]);

  const status = payment.data?.status;
  // The invoice, the request and the lists show the new state as soon as the payment is settled.
  React.useEffect(() => {
    if (!status || status === 'PENDING') return;
    void queryClient.invalidateQueries({ queryKey: keys.invoices.all });
    void queryClient.invalidateQueries({ queryKey: keys.payments.all, predicate: (q) => q.queryKey[1] !== 'detail' });
    void queryClient.invalidateQueries({ queryKey: keys.requests.all });
    void queryClient.invalidateQueries({ queryKey: keys.notifications.all });
  }, [status, queryClient]);

  const header = <PageHeader breadcrumbs={[{ label: t('nav.payments'), href: '/payments' }]} title={t('my.payReturn.title')} />;

  if (!paymentId) {
    return (
      <>
        {header}
        <NotFoundCard title={t('my.payReturn.noPaymentTitle')} text={t('my.payReturn.noPaymentText')} backHref={invoiceId ? `/invoices/${invoiceId}` : '/payments'} backLabel={invoiceId ? t('my.payReturn.backToInvoice') : t('nav.payments')} />
      </>
    );
  }
  if (payment.isError && !payment.data) {
    return (
      <>
        {header}
        {isNotFound(payment.error) ? (
          <NotFoundCard title={t('my.payReturn.noPaymentTitle')} text={t('my.payReturn.noPaymentText')} backHref={invoiceId ? `/invoices/${invoiceId}` : '/payments'} backLabel={invoiceId ? t('my.payReturn.backToInvoice') : t('nav.payments')} />
        ) : (
          <LoadError error={payment.error} onRetry={() => void payment.refetch()} />
        )}
      </>
    );
  }

  const data = payment.data;
  const allocation = data?.paymentAllocations[0];
  const invoiceHref = allocation ? `/invoices/${allocation.invoiceId}` : invoiceId ? `/invoices/${invoiceId}` : '/payments';
  const requestId = allocation?.invoice?.requestId;
  const waiting = !data || (data.status === 'PENDING' && !leftEarly && checks < MAX_CHECKS);
  const paid = data?.status === 'COMPLETED' || data?.status === 'PARTIALLY_REFUNDED' || data?.status === 'REFUNDED';
  const failed = data?.status === 'FAILED' || data?.status === 'CANCELLED';
  const state = waiting ? 'waiting' : paid ? 'paid' : failed ? 'failed' : leftEarly ? 'left' : 'unconfirmed';
  const receiptPath = data ? `/payments/${data.id}/receipt/pdf` : '';

  return (
    <>
      {header}
      <Card className="mx-auto max-w-xl" data-payment-state={state}>
        <CardContent className="space-y-6 sm:p-8">
          <div className="flex flex-col items-center text-center" role="status" aria-live="polite">
            <span
              className={cn(
                'mb-4 flex size-14 items-center justify-center rounded-full',
                state === 'paid' ? 'bg-success-soft text-success-text' : state === 'failed' ? 'bg-destructive-soft text-destructive-text' : state === 'waiting' ? 'bg-secondary-soft text-secondary-text' : 'bg-warning-soft text-warning-text',
              )}
            >
              {state === 'waiting' ? <Spinner /> : state === 'paid' ? <CircleCheck className="size-8" aria-hidden="true" /> : state === 'failed' ? <CircleX className="size-8" aria-hidden="true" /> : <Clock className="size-8" aria-hidden="true" />}
            </span>
            <h2 className="text-xl font-semibold">{t(`my.payReturn.${state}.title`)}</h2>
            <p className="mt-2 max-w-md text-base text-muted-foreground">
              {state === 'failed' && data?.failureReason ? (
                <>
                  {t('my.payReturn.failed.reason')} <span dir="auto">{data.failureReason}</span>
                </>
              ) : (
                t(`my.payReturn.${state}.text`)
              )}
            </p>
          </div>

          {data && state !== 'waiting' ? (
            <DescriptionList
              items={[
                { label: t('my.pay.amount'), value: <Money amount={data.amount} currency={data.currency} className="font-semibold" /> },
                { label: t('my.requests.columns.status'), value: <StatusBadge kind="payment" status={data.status} /> },
                ...(data.receiptNo ? [{ label: t('my.payments.columns.receipt'), value: <span className="tabular ltr-value">{data.receiptNo}</span> }] : []),
                ...(data.receivedAt ? [{ label: t('my.payments.columns.date'), value: formatDateTime(data.receivedAt) }] : []),
                ...(allocation?.invoice
                  ? [
                      {
                        label: t('account.titles.invoiceDetail'),
                        value: (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span className="tabular ltr-value">{allocation.invoice.invoiceNo}</span>
                            <StatusBadge kind="invoice" status={allocation.invoice.status} />
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          ) : null}

          {state !== 'waiting' ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center [&>*]:w-full sm:[&>*]:w-auto">
              {state === 'paid' && data?.receiptNo ? (
                <Button size="lg" loading={pdf.busy === receiptPath} loadingText={t('common.loading')} onClick={() => void pdf.save(receiptPath, `${data.receiptNo}.pdf`)}>
                  <Receipt aria-hidden="true" />
                  {t('my.payments.downloadReceipt')}
                </Button>
              ) : null}
              {state === 'paid' && requestId ? (
                <Button asChild size="lg" variant="outline">
                  <Link href={`/requests/${requestId}`}>{t('my.wizard.openRequest')}</Link>
                </Button>
              ) : null}
              {state === 'unconfirmed' ? (
                <Button
                  size="lg"
                  loading={payment.isFetching}
                  loadingText={t('common.loading')}
                  onClick={() => void payment.refetch()}
                >
                  {t('my.payReturn.checkAgain')}
                </Button>
              ) : null}
              <Button asChild size="lg" variant={state === 'failed' || state === 'left' ? 'default' : 'outline'}>
                <Link href={invoiceHref}>{state === 'failed' || state === 'left' ? t('my.payReturn.tryAgain') : t('my.payReturn.backToInvoice')}</Link>
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
