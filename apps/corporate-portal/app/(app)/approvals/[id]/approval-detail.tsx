'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { quotationRejectSchema } from '@typease/validation';
import {
  Alert, Button, Card, CardContent, ConfirmDialog, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError,
  FormField, PageHeader, StatusBadge, Textarea, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { FeeLines } from '@/components/portal/fee-lines';
import { DetailSkeleton, Gate, isForbidden, isNotFound, LoadError, Ltr, NoAccess, NotFoundCard, PersonName, retryUnlessFinal, usePdfDownload, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { QuotationApproval, QuotationDetail as Quotation } from '@/lib/types';
import { quotationStatus } from '../approvals';

export function ApprovalDetail({ id }: { id: string }) {
  return (
    <Gate anyOf={['corp.requests.approve', 'corp.requests.read', 'corp.invoices.read']}>
      <Detail id={id} />
    </Gate>
  );
}

/** One quotation: what it covers, what it costs, and the company's decision (approve, or decline with a reason). */
function Detail({ id }: { id: string }) {
  const { t, formatDate, formatMoney } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const role = useRole();
  const queryClient = useQueryClient();
  const pdf = usePdfDownload();
  const query = useQuery({ queryKey: keys.quotations.detail(id), queryFn: () => api.quotation(id), retry: retryUnlessFinal });
  const [approveOpen, setApproveOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [approved, setApproved] = React.useState<QuotationApproval['invoice']>(null);

  const crumbs = role.canApprove ? [{ label: t('nav.approvals'), href: ROUTES.approvals }] : [{ label: t('nav.requests'), href: ROUTES.requests }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.quotationDetail')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.quotationDetail')} />
        {isNotFound(query.error) ? (
          <NotFoundCard title={t('my.approvals.notFoundTitle')} text={t('my.approvals.notFoundText')} backHref={crumbs[0].href} backLabel={crumbs[0].label} />
        ) : isForbidden(query.error) ? (
          <NoAccess />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const q = query.data;
  const status = quotationStatus(q);
  const open = status === 'SENT';
  const invoice = q.invoice ?? approved;
  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.quotations.all }),
      queryClient.invalidateQueries({ queryKey: keys.invoices.all }),
      queryClient.invalidateQueries({ queryKey: keys.requests.all }),
      queryClient.invalidateQueries({ queryKey: keys.notifications.all }),
      queryClient.invalidateQueries({ queryKey: keys.account }),
    ]);

  const approve = async () => {
    try {
      const result = await api.approveQuotation(q.id);
      setApproved(result.invoice);
      await refreshAll();
      toasts.success(t('my.approvals.approved', { number: q.quotationNo }), result.invoice ? t('my.approvals.approvedInvoice', { number: result.invoice.invoiceNo }) : undefined);
    } catch (error) {
      // Decided or expired in the meantime (a colleague, the centre): show the quotation as it is now.
      if (isApiError(error) && (error.code === 'QUOTATION_EXPIRED' || error.code === 'QUOTATION_NOT_OPEN')) await refreshAll();
      toasts.error(error);
      throw error;
    }
  };

  const pdfPath = `/quotations/${q.id}/pdf`;
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={
          <>
            {t('titles.quotationDetail')} <Ltr>{q.quotationNo}</Ltr>
          </>
        }
        meta={<StatusBadge kind="quotation" status={status} label={open ? { en: t('my.approvals.waiting'), ar: t('my.approvals.waiting') } : undefined} className="px-3 py-1 text-sm" />}
        description={open && role.canApprove ? t('my.approvals.openText') : undefined}
        secondary={
          <Button variant="outline" loading={pdf.busy === pdfPath} loadingText={t('common.loading')} onClick={() => void pdf.save(pdfPath, `${q.quotationNo}.pdf`)}>
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
                <p className="text-sm font-medium text-muted-foreground">{t('my.approvals.notes')}</p>
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
                  ...(q.customer ? [{ label: t('my.requests.columns.person'), value: <PersonName name={q.customer.fullName} erased={q.customer.erased} /> }] : []),
                  ...(q.request
                    ? [
                        {
                          label: t('my.approvals.columns.request'),
                          value: (
                            <Link href={`${ROUTES.requests}/${q.request.id}`} className="font-medium text-secondary-text hover:underline">
                              <Ltr>{q.request.requestNo}</Ltr>
                            </Link>
                          ),
                        },
                      ]
                    : []),
                  { label: t('my.approvals.columns.sent'), value: formatDate(q.sentAt ?? q.createdAt) },
                  { label: t('my.approvals.columns.validUntil'), value: q.validUntil ? formatDate(q.validUntil) : null },
                  ...(q.decidedAt ? [{ label: t('my.approvals.decided'), value: formatDate(q.decidedAt) }] : []),
                ]}
              />
            </CardContent>
          </Card>

          {open && role.canApprove ? (
            // On a phone the decision comes right after the fees, before the dates.
            <div className="order-first space-y-2 lg:order-none">
              <Button size="lg" className="w-full" onClick={() => setApproveOpen(true)} data-action="approve">
                <Check aria-hidden="true" />
                {t('my.approvals.approve')}
              </Button>
              <Button variant="outline" className="w-full" onClick={() => setRejectOpen(true)} data-action="reject">
                {t('my.approvals.reject')}
              </Button>
              <p className="text-sm text-muted-foreground">{t('my.approvals.approveHint')}</p>
            </div>
          ) : null}
          {open && !role.canApprove ? <Alert tone="info">{t('my.approvals.cannotDecide')}</Alert> : null}
          {status === 'EXPIRED' ? <Alert tone="warning">{t('my.approvals.expiredText')}</Alert> : null}
          {status === 'SUPERSEDED' ? <Alert tone="info">{t('my.approvals.supersededText')}</Alert> : null}
          {status === 'CANCELLED' ? <Alert tone="info">{t('my.approvals.cancelledText')}</Alert> : null}
          {status === 'REJECTED' ? (
            <Alert tone="info" title={t('my.approvals.rejectedTitle')} data-decision="REJECTED">
              {q.rejectionReason ? <span dir="auto">{q.rejectionReason}</span> : null}
            </Alert>
          ) : null}
          {status === 'APPROVED' && invoice ? (
            <Alert
              tone={Number(invoice.balanceDue) > 0 ? 'info' : 'success'}
              title={t('my.approvals.invoiceTitle', { number: invoice.invoiceNo })}
              data-decision="APPROVED"
              action={
                role.canSeeMoney ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`${ROUTES.invoices}/${invoice.id}`}>{t('my.approvals.openInvoice')}</Link>
                  </Button>
                ) : undefined
              }
            >
              {Number(invoice.balanceDue) > 0 ? t('my.approvals.invoiceDue', { amount: formatMoney(invoice.balanceDue, invoice.currency) }) : t('my.approvals.invoicePaid')}
            </Alert>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        tone="default"
        title={t('my.approvals.approveTitle')}
        description={t('my.approvals.approveText', { amount: formatMoney(q.total, q.currency) })}
        confirmLabel={t('my.approvals.approve')}
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
            toasts.success(t('my.approvals.rejected', { number: quotation.quotationNo }));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('my.approvals.rejectTitle')}</DialogTitle>
            <DialogDescription>{t('my.approvals.rejectText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <FormField name="reason" label={t('my.approvals.rejectReason')} required hint={t('my.approvals.rejectReasonHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={500} autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('my.approvals.reject')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
