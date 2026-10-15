'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { quotationRejectSchema } from '@typease/validation';
import {
  Alert, Button, Card, CardContent, ConfirmDialog, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError,
  FormField, PageHeader, StatusBadge, Textarea, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { FeeLines } from '@/components/portal/fee-lines';
import { DetailSkeleton, LoadError, NotFoundCard, isNotFound, usePdfDownload } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { QuotationDetail as Quotation } from '@/lib/types';
import { quotationStatus } from '../quotations-list';

/** One quotation: what it covers, what it costs, and the customer's decision (approve, or decline with a reason). */
export function QuotationDetail({ id }: { id: string }) {
  const { t, formatDate, formatMoney } = useI18n();
  const api = usePortalApi();
  const router = useRouter();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const pdf = usePdfDownload();
  const query = useQuery({ queryKey: keys.quotations.detail(id), queryFn: () => api.quotation(id), retry: (count, error) => !isNotFound(error) && count < 2 });
  const [approveOpen, setApproveOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);

  const crumbs = [{ label: t('nav.quotations'), href: '/quotations' }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('account.titles.quotationDetail')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('account.titles.quotationDetail')} />
        {isNotFound(query.error) ? (
          <NotFoundCard title={t('my.quotations.notFoundTitle')} text={t('my.quotations.notFoundText')} backHref="/quotations" backLabel={t('nav.quotations')} />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const q = query.data;
  const status = quotationStatus(q);
  const open = status === 'SENT';
  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.quotations.all }),
      queryClient.invalidateQueries({ queryKey: keys.invoices.all }),
      queryClient.invalidateQueries({ queryKey: keys.requests.all }),
      queryClient.invalidateQueries({ queryKey: keys.notifications.all }),
    ]);

  const approve = async () => {
    try {
      const result = await api.approveQuotation(q.id);
      await refreshAll();
      toasts.success(t('my.quotations.approved', { number: q.quotationNo }), result.invoice ? t('my.quotations.approvedInvoice', { number: result.invoice.invoiceNo }) : undefined);
      // The next thing to do is to pay: go straight to the invoice the approval created.
      if (result.invoice && Number(result.invoice.balanceDue) > 0) router.push(`/invoices/${result.invoice.id}`);
    } catch (error) {
      if (isApiError(error) && (error.code === 'QUOTATION_EXPIRED' || error.code === 'QUOTATION_NOT_OPEN')) await refreshAll();
      toasts.error(error);
      throw error;
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <>
            {t('account.titles.quotationDetail')} <span className="tabular ltr-value">{q.quotationNo}</span>
          </>
        }
        meta={<StatusBadge kind="quotation" status={status} label={open ? { en: t('my.quotations.waiting'), ar: t('my.quotations.waiting') } : undefined} className="px-3 py-1 text-sm" />}
        description={open ? t('my.quotations.openText') : undefined}
        secondary={
          <Button variant="outline" loading={pdf.busy === `/quotations/${q.id}/pdf`} loadingText={t('common.loading')} onClick={() => void pdf.save(`/quotations/${q.id}/pdf`, `${q.quotationNo}.pdf`)}>
            <Download aria-hidden="true" />
            {t('my.common.pdf')}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <Card className="min-w-0">
          <CardContent className="space-y-5">
            <FeeLines lines={q.quotationItems} totals={q} />
            {q.notes ? (
              <div>
                <p className="text-sm font-medium text-muted-foreground">{t('my.quotations.notes')}</p>
                <p className="mt-1 whitespace-pre-wrap text-base" dir="auto">
                  {q.notes}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <aside className="flex flex-col gap-4">
          <Card>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  ...(q.request ? [{ label: t('my.quotations.columns.request'), value: <Link href={`/requests/${q.request.id}`} className="tabular ltr-value font-medium text-secondary-text hover:underline">{q.request.requestNo}</Link> }] : []),
                  { label: t('my.quotations.columns.sent'), value: formatDate(q.sentAt ?? q.createdAt) },
                  { label: t('my.quotations.columns.validUntil'), value: q.validUntil ? formatDate(q.validUntil) : null },
                  ...(q.decidedAt ? [{ label: t('my.quotations.decided'), value: formatDate(q.decidedAt) }] : []),
                ]}
              />
            </CardContent>
          </Card>

          {open ? (
            // On a phone the decision comes right after the fees, before the dates.
            <div className="order-first space-y-2 lg:order-none">
              <Button size="lg" className="w-full" onClick={() => setApproveOpen(true)} data-action="approve">
                <Check aria-hidden="true" />
                {t('my.quotations.approve')}
              </Button>
              <Button variant="outline" className="w-full" onClick={() => setRejectOpen(true)} data-action="reject">
                {t('my.quotations.reject')}
              </Button>
              <p className="text-sm text-muted-foreground">{t('my.quotations.approveHint')}</p>
            </div>
          ) : null}
          {status === 'EXPIRED' ? <Alert tone="warning">{t('my.quotations.expiredText')}</Alert> : null}
          {status === 'SUPERSEDED' ? <Alert tone="info">{t('my.quotations.supersededText')}</Alert> : null}
          {status === 'CANCELLED' ? <Alert tone="info">{t('my.quotations.cancelledText')}</Alert> : null}
          {status === 'REJECTED' ? (
            <Alert tone="info" title={t('my.quotations.rejectedTitle')}>
              {q.rejectionReason ? <span dir="auto">{q.rejectionReason}</span> : null}
            </Alert>
          ) : null}
          {status === 'APPROVED' && q.invoice ? (
            <Alert
              tone={Number(q.invoice.balanceDue) > 0 ? 'warning' : 'success'}
              title={t('my.quotations.invoiceTitle', { number: q.invoice.invoiceNo })}
              action={
                <Button asChild size="sm" variant={Number(q.invoice.balanceDue) > 0 ? 'default' : 'outline'}>
                  <Link href={`/invoices/${q.invoice.id}`}>{Number(q.invoice.balanceDue) > 0 ? t('my.pay.pay') : t('my.quotations.openInvoice')}</Link>
                </Button>
              }
            >
              {Number(q.invoice.balanceDue) > 0 ? t('my.quotations.invoiceDue', { amount: formatMoney(q.invoice.balanceDue, q.invoice.currency) }) : t('my.quotations.invoicePaid')}
            </Alert>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        tone="default"
        title={t('my.quotations.approveTitle')}
        description={t('my.quotations.approveText', { amount: formatMoney(q.total, q.currency) })}
        confirmLabel={t('my.quotations.approve')}
        onConfirm={approve}
      />
      {rejectOpen ? <RejectDialog quotation={q} onClose={() => setRejectOpen(false)} onRejected={refreshAll} /> : null}
    </>
  );
}

function RejectDialog({ quotation, onClose, onRejected }: { quotation: Quotation; onClose: () => void; onRejected: () => Promise<unknown> }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const form = useZodForm(quotationRejectSchema, { defaultValues: { reason: '' } });
  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async ({ reason }) => {
            await api.rejectQuotation(quotation.id, reason);
            await onRejected();
            toasts.success(t('my.quotations.rejected', { number: quotation.quotationNo }));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('my.quotations.rejectTitle')}</DialogTitle>
            <DialogDescription>{t('my.quotations.rejectText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <FormField name="reason" label={t('my.quotations.rejectReason')} required hint={t('my.quotations.rejectReasonHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={500} autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('my.quotations.reject')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
