'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { FileDown, Printer, Undo2 } from 'lucide-react';
import { Alert, Badge, Button, DescriptionList, EmptyState, PageHeader, RequirePermission, StatusBadge, subtractMoney, useI18n, useSession } from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { sumAmounts } from '@/components/fin/calc';
import { DetailSkeleton, ImmutableNote, LoadError, Money, PdfDialog, Section, TextLink, useDownload, useStaffDirectory } from '@/components/fin/shared';
import { finKeys } from '@/lib/keys/fin';

const OPEN_REFUND = new Set(['REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED']);

export function PaymentDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['payment.read', 'payment.record']}>
      <PaymentDetailInner id={id} />
    </RequirePermission>
  );
}

function PaymentDetailInner({ id }: { id: string }) {
  const { t, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const staff = useStaffDirectory();
  const download = useDownload();
  const payment = useQuery({ queryKey: finKeys.payments.detail(id), queryFn: ({ signal }) => api.payments.get(id, signal) });
  const [receiptOpen, setReceiptOpen] = React.useState(false);
  const [justRecorded, setJustRecorded] = React.useState(false);
  React.useEffect(() => {
    setJustRecorded(new URLSearchParams(window.location.search).get('recorded') === '1');
  }, []);

  if (payment.isPending) return <DetailSkeleton />;
  if (payment.isError) {
    return (
      <>
        <PageHeader title={t('fin.payments.detail.title')} breadcrumbs={[{ label: t('fin.payments.title'), href: '/payments' }]} />
        <LoadError error={payment.error} onRetry={() => void payment.refetch()} />
      </>
    );
  }

  const p = payment.data;
  const hasReceipt = !!p.receiptNo;
  const waiting = sumAmounts(p.refunds.filter((r) => OPEN_REFUND.has(r.status)).map((r) => r.amount));
  const refundable = subtractMoney(subtractMoney(p.amount, p.refundedAmount), waiting);
  const canRefund = session.hasPermission('refund.request') && (p.status === 'COMPLETED' || p.status === 'PARTIALLY_REFUNDED') && Number(refundable) > 0;
  const receiptPath = api.payments.receiptPath(p.id);
  const receiptName = `${p.receiptNo ?? p.paymentNo}.pdf`;
  const recordedBy = staff.nameOf(p.receivedById);

  return (
    <>
      <PageHeader
        title={<span className="tabular">{p.paymentNo}</span>}
        breadcrumbs={[{ label: t('fin.payments.title'), href: '/payments' }]}
        meta={<StatusBadge kind="payment" status={p.status} />}
        description={p.customer ? t('fin.payments.detail.description', { customer: p.customer.fullName }) : undefined}
        action={
          hasReceipt ? (
            <Button variant="accent" onClick={() => setReceiptOpen(true)}>
              <Printer aria-hidden="true" />
              {t('fin.payments.printReceipt')}
            </Button>
          ) : null
        }
        secondary={
          <>
            {hasReceipt ? (
              <Button variant="outline" loading={download.busy === 'receipt'} loadingText={t('common.loading')} onClick={() => void download.save('receipt', receiptPath, { fallbackFilename: receiptName })}>
                <FileDown aria-hidden="true" />
                {t('fin.payments.downloadReceipt')}
              </Button>
            ) : null}
            {canRefund ? (
              <Button asChild variant="outline">
                <Link href={`/refunds/new?paymentId=${p.id}`}>
                  <Undo2 aria-hidden="true" />
                  {t('fin.payments.requestRefund')}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {justRecorded && hasReceipt ? (
        <Alert tone="success" className="mb-6" title={t('fin.payments.detail.recordedTitle', { receipt: p.receiptNo ?? '' })}>
          {t('fin.payments.detail.recordedText')}
        </Alert>
      ) : null}
      {p.status === 'PENDING' ? (
        <Alert tone="info" className="mb-6">
          {t('fin.payments.detail.pendingText')}
        </Alert>
      ) : null}
      {p.status === 'FAILED' ? (
        <Alert tone="danger" className="mb-6" title={t('fin.payments.detail.failedTitle')}>
          {p.failureReason ? <span dir="auto">{p.failureReason}</span> : null}
        </Alert>
      ) : null}
      {Number(p.unallocatedAmount) > 0 && p.status !== 'PENDING' && p.status !== 'FAILED' ? (
        <Alert tone="warning" className="mb-6" title={t('fin.payments.detail.unallocatedTitle')}>
          {t('fin.payments.detail.unallocatedText')} <Money amount={p.unallocatedAmount} currency={p.currency} className="font-semibold" />
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title={t('fin.payments.detail.allocations')} description={t('fin.payments.detail.allocationsHint')} flush>
            {p.paymentAllocations.length === 0 ? (
              <EmptyState title={t('fin.payments.detail.noAllocations')} />
            ) : (
              <ul className="divide-y">
                {p.paymentAllocations.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5">
                    <div className="min-w-0">
                      <TextLink href={`/invoices/${a.invoiceId}`} className="tabular">
                        {a.invoice.invoiceNo}
                      </TextLink>
                      <span className="ms-2 inline-flex align-middle">
                        <StatusBadge kind="invoice" status={a.invoice.status} />
                      </span>
                      <p className="text-sm text-muted-foreground">
                        {t('fin.payments.detail.invoiceBalance')} <Money amount={a.invoice.balanceDue} currency={p.currency} />
                        {a.invoice.requestId ? (
                          <>
                            {' · '}
                            <TextLink href={`/requests/${a.invoice.requestId}`} className="font-normal">
                              {t('fin.common.openRequest')}
                            </TextLink>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <Money amount={a.amount} currency={p.currency} className="font-semibold" />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('fin.payments.detail.refunds')} flush>
            {p.refunds.length === 0 ? (
              <EmptyState title={t('fin.payments.detail.noRefunds')} description={canRefund ? t('fin.payments.detail.noRefundsText') : undefined} />
            ) : (
              <ul className="divide-y">
                {p.refunds.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5">
                    <div className="min-w-0 flex-1 basis-64">
                      <TextLink href={`/refunds/${r.id}`} className="tabular">
                        {r.refundNo}
                      </TextLink>
                      <span className="ms-2 inline-flex align-middle">
                        <StatusBadge kind="refund" status={r.status} />
                      </span>
                      <p className="text-sm text-muted-foreground">
                        {formatDateTime(r.processedAt ?? r.createdAt)} · <span dir="auto">{r.reason}</span>
                      </p>
                    </div>
                    <Money amount={r.amount} currency={p.currency} className="font-semibold" />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Section title={t('fin.payments.detail.summary')}>
            <dl className="mb-4 space-y-1 border-b pb-4">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-base">{t('fin.payments.detail.received')}</dt>
                <dd className="text-xl font-semibold">
                  <Money amount={p.amount} currency={p.currency} />
                </dd>
              </div>
              {Number(p.refundedAmount) > 0 ? (
                <div className="flex items-baseline justify-between gap-4 text-muted-foreground">
                  <dt>{t('fin.payments.detail.refunded')}</dt>
                  <dd>
                    − <Money amount={p.refundedAmount} currency={p.currency} />
                  </dd>
                </div>
              ) : null}
              {Number(waiting) > 0 ? (
                <div className="flex items-baseline justify-between gap-4 text-muted-foreground">
                  <dt>{t('fin.payments.detail.refundWaiting')}</dt>
                  <dd>
                    <Money amount={waiting} currency={p.currency} />
                  </dd>
                </div>
              ) : null}
            </dl>
            <DescriptionList
              columns={1}
              items={[
                { label: t('fin.common.customer'), value: p.customer ? <TextLink href={`/customers/${p.customer.id}`}>{p.customer.fullName}</TextLink> : null },
                { label: t('fin.payments.columns.method'), value: t(`fin.methods.${p.method}`) },
                ...(p.gateway ? [{ label: t('fin.payments.detail.gateway'), value: <span className="ltr-value">{p.gateway}{p.gatewayPaymentRef ? ` · ${p.gatewayPaymentRef}` : ''}</span> }] : []),
                { label: t('fin.payments.detail.reference'), value: p.reference ? <span dir="auto">{p.reference}</span> : null },
                { label: t('fin.payments.detail.receipt'), value: p.receiptNo ? <span className="tabular">{p.receiptNo}</span> : null },
                { label: t('fin.payments.columns.received'), value: p.receivedAt ? formatDateTime(p.receivedAt) : null },
                { label: t('fin.common.branch'), value: p.branch.name },
                ...(recordedBy ? [{ label: t('fin.payments.detail.recordedBy'), value: recordedBy }] : []),
                {
                  label: t('fin.payments.columns.reconciled'),
                  value: p.reconciledAt ? (
                    <>
                      <Badge tone="success">{t('fin.payments.reconciled.yes')}</Badge>
                      {p.reconciliationId && session.hasPermission('payment.reconcile') ? (
                        <TextLink href={`/finance/reconciliation/${p.reconciliationId}`} className="ms-2 text-sm">
                          {t('fin.payments.detail.openReconciliation')}
                        </TextLink>
                      ) : null}
                    </>
                  ) : (
                    <Badge tone="neutral">{t('fin.payments.reconciled.no')}</Badge>
                  ),
                },
                ...(p.notes ? [{ label: t('fin.payments.form.notes'), value: <span dir="auto">{p.notes}</span> }] : []),
              ]}
            />
            <ImmutableNote className="mt-4">{t('fin.payments.immutable')}</ImmutableNote>
          </Section>
        </div>
      </div>

      {hasReceipt ? (
        <PdfDialog open={receiptOpen} onOpenChange={setReceiptOpen} path={receiptPath} title={t('fin.payments.receiptTitle', { number: p.receiptNo ?? p.paymentNo })} fallbackFilename={receiptName} />
      ) : null}
    </>
  );
}
