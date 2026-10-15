'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Banknote, FileDown, RefreshCw, XCircle } from 'lucide-react';
import { approveRefundSchema, completeRefundSchema, z } from '@typease/validation';
import {
  Alert, Button, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, PageHeader,
  RequirePermission, StatusBadge, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { ChargeChoice } from '@/components/fin/charge-choice';
import { DetailSkeleton, LoadError, Money, ReasonDialog, Section, TextLink, useApprovers, useDownload, useStaffDirectory } from '@/components/fin/shared';
import type { RefundRow } from '@/components/fin/types';
import { MONEY_RESOURCES, finKeys } from '@/lib/keys/fin';

type DialogKind = 'approve' | 'reject' | 'complete' | null;

export function RefundDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['refund.request', 'refund.approve']}>
      <RefundDetailInner id={id} />
    </RequirePermission>
  );
}

function RefundDetailInner({ id }: { id: string }) {
  const { t, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const staff = useStaffDirectory();
  const download = useDownload();
  const refund = useQuery({ queryKey: finKeys.refunds.detail(id), queryFn: ({ signal }) => api.refunds.get(id, signal) });
  const approvers = useApprovers('refund.approve', refund.data?.requestedById);
  const [dialog, setDialog] = React.useState<DialogKind>(null);
  const [busy, setBusy] = React.useState(false);

  const cancelled = !!refund.data?.breakdown?.cancelCharge;
  const invoiceId = refund.data?.invoiceId ?? null;
  // A completed refund that cancelled the charge issued a credit note in the same transaction ("Refund RFD-...: reason").
  const creditNotes = useQuery({
    queryKey: finKeys.creditNotes.ofInvoice(invoiceId ?? ''),
    queryFn: ({ signal }) => api.creditNotes.list({ invoiceId, pageSize: 50 }, signal),
    enabled: !!invoiceId && refund.data?.status === 'COMPLETED' && cancelled && session.hasAnyPermission(['invoice.read', 'creditnote.manage']),
  });

  const refresh = async () => {
    await Promise.all(MONEY_RESOURCES.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  if (refund.isPending) return <DetailSkeleton />;
  if (refund.isError) {
    return (
      <>
        <PageHeader title={t('fin.refunds.detail.title')} breadcrumbs={[{ label: t('fin.refunds.title'), href: '/refunds' }]} />
        <LoadError error={refund.error} onRetry={() => void refund.refetch()} />
      </>
    );
  }

  const r = refund.data;
  const canApprove = session.hasPermission('refund.approve');
  const iRequested = staff.isMe(r.requestedById);
  const mayDecide = canApprove && !iRequested;
  const online = r.payment.method === 'ONLINE_GATEWAY';
  const creditNote = creditNotes.data?.data.find((cn) => cn.reason.startsWith(`Refund ${r.refundNo}:`));
  const breakdown = r.breakdown ?? {};
  const parts = (
    [
      ['SERVICE_FEE', t('fin.breakdown.serviceFee')],
      ['GOVERNMENT_FEE', t('fin.breakdown.governmentFee')],
      ['THIRD_PARTY_FEE', t('fin.breakdown.thirdParty')],
      ['TAX', t('fin.breakdown.tax')],
    ] as const
  ).filter(([key]) => breakdown[key] !== undefined);

  const process = async () => {
    setBusy(true);
    try {
      const next = await api.refunds.process(r.id);
      if (next.status === 'COMPLETED') toasts.success(t('fin.refunds.detail.completedToast', { number: r.refundNo }));
      else if (next.status === 'FAILED') toasts.error(next.rejectionReason ?? t('fin.refunds.detail.failedToast'));
      else toasts.info(t('fin.refunds.detail.processingToast'));
      await refresh();
    } catch (error) {
      toasts.error(error);
    } finally {
      setBusy(false);
    }
  };

  const primary =
    r.status === 'REQUESTED' && mayDecide ? (
      <Button variant="accent" onClick={() => setDialog('approve')}>
        <BadgeCheck aria-hidden="true" />
        {t('fin.refunds.detail.approve')}
      </Button>
    ) : r.status === 'APPROVED' && mayDecide && !online ? (
      <Button variant="accent" onClick={() => setDialog('complete')}>
        <Banknote aria-hidden="true" />
        {t('fin.refunds.detail.complete')}
      </Button>
    ) : (r.status === 'APPROVED' || r.status === 'FAILED' || r.status === 'PROCESSING') && mayDecide && online ? (
      <Button variant="accent" onClick={() => void process()} loading={busy} loadingText={t('common.loading')}>
        <RefreshCw aria-hidden="true" />
        {r.status === 'PROCESSING' ? t('fin.refunds.detail.check') : t('fin.refunds.detail.retry')}
      </Button>
    ) : null;

  return (
    <>
      <PageHeader
        title={<span className="tabular">{r.refundNo}</span>}
        breadcrumbs={[{ label: t('fin.refunds.title'), href: '/refunds' }]}
        meta={<StatusBadge kind="refund" status={r.status} />}
        description={t('fin.refunds.detail.description', { payment: r.payment.paymentNo })}
        action={primary}
        secondary={
          <>
            {r.status === 'REQUESTED' && mayDecide ? (
              <Button variant="outline" onClick={() => setDialog('reject')}>
                <XCircle aria-hidden="true" />
                {t('fin.refunds.detail.reject')}
              </Button>
            ) : null}
            {r.status === 'FAILED' && mayDecide ? (
              <Button variant="outline" onClick={() => setDialog('complete')}>
                {t('fin.refunds.detail.completeManually')}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-6 space-y-3 empty:hidden">
        {r.status === 'REQUESTED' ? (
          <Alert tone="warning" title={t('fin.refunds.detail.waitingTitle')}>
            <p>{iRequested ? t('fin.refunds.detail.waitingOwn') : canApprove ? t('fin.refunds.detail.waitingCanApprove') : t('fin.refunds.detail.waitingText')}</p>
            {approvers !== null ? <p className="mt-1">{approvers.length ? t('fin.refunds.approvers', { names: approvers.join(', ') }) : t('fin.refunds.approversNone')}</p> : null}
          </Alert>
        ) : null}
        {r.status === 'APPROVED' ? (
          <Alert tone="info" title={t('fin.refunds.detail.approvedTitle')}>
            {online ? t('fin.refunds.detail.approvedOnline') : iRequested ? t('fin.refunds.detail.approvedOwn') : t('fin.refunds.detail.approvedManual')}
          </Alert>
        ) : null}
        {r.status === 'PROCESSING' ? <Alert tone="info">{t('fin.refunds.detail.processingText')}</Alert> : null}
        {r.status === 'FAILED' ? (
          <Alert tone="danger" title={t('fin.refunds.detail.failedTitle')}>
            {r.rejectionReason ? <span dir="auto">{r.rejectionReason} </span> : null}
            {t('fin.refunds.detail.failedText')}
          </Alert>
        ) : null}
        {r.status === 'REJECTED' ? (
          <Alert tone="danger" title={t('fin.refunds.detail.rejectedTitle')}>
            {r.rejectionReason ? <span dir="auto">{r.rejectionReason}</span> : null}
          </Alert>
        ) : null}
        {r.status === 'COMPLETED' ? (
          <Alert
            tone="success"
            title={t('fin.refunds.detail.completedTitle', { date: formatDateTime(r.processedAt) })}
            action={
              creditNote ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={download.busy === creditNote.id}
                  onClick={() => void download.save(creditNote.id, api.creditNotes.pdfPath(creditNote.id), { fallbackFilename: `${creditNote.creditNoteNo}.pdf` })}
                >
                  <FileDown aria-hidden="true" />
                  {t('fin.refunds.detail.creditNotePdf', { number: creditNote.creditNoteNo })}
                </Button>
              ) : undefined
            }
          >
            {cancelled ? (creditNote ? t('fin.refunds.detail.completedCancelled', { number: creditNote.creditNoteNo }) : t('fin.refunds.detail.completedCancelledNoNumber')) : t('fin.refunds.detail.completedKept')}{' '}
            {r.invoice ? <TextLink href={`/invoices/${r.invoice.id}`}>{t('fin.refunds.detail.openInvoice', { number: r.invoice.invoiceNo })}</TextLink> : null}
          </Alert>
        ) : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title={t('fin.refunds.detail.summary')}>
            <DescriptionList
              columns={3}
              items={[
                {
                  label: t('fin.common.payment'),
                  value: (
                    <>
                      <TextLink href={`/payments/${r.payment.id}`} className="tabular">
                        {r.payment.paymentNo}
                      </TextLink>
                      <span className="block text-sm text-muted-foreground">{t(`fin.methods.${r.payment.method}`)}</span>
                    </>
                  ),
                },
                {
                  label: t('fin.common.invoice'),
                  value: r.invoice ? (
                    <>
                      <TextLink href={`/invoices/${r.invoice.id}`} className="tabular">
                        {r.invoice.invoiceNo}
                      </TextLink>
                      <span className="ms-2 inline-flex align-middle">
                        <StatusBadge kind="invoice" status={r.invoice.status} />
                      </span>
                    </>
                  ) : null,
                },
                { label: t('fin.common.request'), value: r.requestId ? <TextLink href={`/requests/${r.requestId}`}>{t('fin.common.openRequest')}</TextLink> : null },
                { label: t('fin.refunds.detail.requestedBy'), value: (iRequested ? t('fin.common.you') : staff.nameOf(r.requestedById)) ?? t('fin.refunds.detail.aStaffMember') },
                { label: t('fin.refunds.columns.requested'), value: formatDateTime(r.createdAt) },
                ...(r.decidedAt ? [{ label: r.status === 'REJECTED' ? t('fin.refunds.detail.rejectedBy') : t('fin.refunds.detail.approvedBy'), value: `${(staff.isMe(r.decidedById) ? t('fin.common.you') : staff.nameOf(r.decidedById)) ?? t('fin.refunds.detail.aStaffMember')} · ${formatDateTime(r.decidedAt)}` }] : []),
                ...(r.gatewayRefundRef ? [{ label: online ? t('fin.refunds.detail.gatewayRef') : t('fin.refunds.detail.payoutRef'), value: <span dir="auto">{r.gatewayRefundRef}</span> }] : []),
                { label: t('fin.common.reason'), value: <span dir="auto">{r.reason}</span>, wide: true },
              ]}
            />
          </Section>

          <Section title={t('fin.refunds.charge.label')}>
            {r.invoice ? (
              <>
                <p className="font-medium text-foreground">{t(cancelled ? 'fin.refunds.charge.cancel.label' : 'fin.refunds.charge.keep.label')}</p>
                <p className="mt-1 text-base text-muted-foreground">{t(cancelled ? 'fin.refunds.charge.cancel.text' : 'fin.refunds.charge.keep.text')}</p>
              </>
            ) : (
              <p className="text-base text-muted-foreground">{t('fin.refunds.charge.noInvoice')}</p>
            )}
          </Section>
        </div>

        <Section title={t('fin.breakdown.title')}>
          <dl className="space-y-2 text-base">
            <div className="flex items-baseline justify-between gap-4">
              <dt>{t('fin.refunds.detail.amount')}</dt>
              <dd className="text-xl font-semibold">
                <Money amount={r.amount} currency={r.currency} />
              </dd>
            </div>
            {parts.length ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm text-muted-foreground">{breakdown.explicit ? t('fin.refunds.detail.splitExplicit') : t('fin.refunds.detail.splitProportional')}</p>
                {parts.map(([key, label]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>
                      <Money amount={breakdown[key]} currency={r.currency} />
                    </dd>
                  </div>
                ))}
                <p className="text-sm text-muted-foreground">{t('fin.refunds.detail.splitNote')}</p>
              </div>
            ) : (
              <p className="border-t pt-3 text-sm text-muted-foreground">{t('fin.refunds.detail.splitLater')}</p>
            )}
          </dl>
        </Section>
      </div>

      <ApproveDialog open={dialog === 'approve'} onOpenChange={(open) => setDialog(open ? 'approve' : null)} refund={r} onDone={refresh} />
      <ReasonDialog
        open={dialog === 'reject'}
        onOpenChange={(open) => setDialog(open ? 'reject' : null)}
        title={t('fin.refunds.detail.rejectTitle', { number: r.refundNo })}
        description={t('fin.refunds.detail.rejectText')}
        label={t('fin.common.reason')}
        hint={t('fin.refunds.detail.rejectHint')}
        submitLabel={t('fin.refunds.detail.reject')}
        submitVariant="destructive"
        onSubmit={async (reason) => {
          await api.refunds.reject(r.id, { reason });
          toasts.success(t('fin.refunds.detail.rejectedToast', { number: r.refundNo }));
          await refresh();
        }}
      />
      <CompleteDialog open={dialog === 'complete'} onOpenChange={(open) => setDialog(open ? 'complete' : null)} refund={r} onDone={refresh} />
    </>
  );
}

// ---------------------------------------------------------------- approve

const approveSchema = approveRefundSchema.pick({ reference: true }).extend({ charge: z.enum(['cancel', 'keep']) });

function ApproveDialog({ open, onOpenChange, refund, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; refund: RefundRow; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const online = refund.payment.method === 'ONLINE_GATEWAY';
  const requested = refund.breakdown?.cancelCharge ? 'cancel' : 'keep';
  const form = useZodForm(approveSchema, { defaultValues: { reference: '', charge: requested } });
  React.useEffect(() => {
    if (open) form.reset({ reference: '', charge: requested });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const result = await api.refunds.approve(refund.id, {
              ...(refund.invoiceId && values.charge !== requested ? { cancelCharge: values.charge === 'cancel' } : {}),
              ...(!online && values.reference ? { reference: values.reference } : {}),
            });
            if (result.status === 'COMPLETED') toasts.success(t('fin.refunds.detail.completedToast', { number: refund.refundNo }));
            else if (result.status === 'FAILED') toasts.warning(t('fin.refunds.detail.approvedButFailed'), result.rejectionReason ?? undefined);
            else toasts.success(t('fin.refunds.detail.approvedToast', { number: refund.refundNo }), online ? undefined : t('fin.refunds.detail.approvedNext'));
            await onDone();
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.refunds.detail.approveTitle', { number: refund.refundNo })}</DialogTitle>
            <DialogDescription>{online ? t('fin.refunds.detail.approveOnlineText') : t('fin.refunds.detail.approveManualText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
              <span>{t('fin.refunds.detail.amount')}</span>
              <Money amount={refund.amount} currency={refund.currency} className="font-semibold" />
            </div>
            <p className="text-sm text-muted-foreground">
              {t('fin.refunds.detail.reasonGiven')} <span dir="auto">{refund.reason}</span>
            </p>
            {refund.invoiceId ? (
              <FormField name="charge" label={t('fin.refunds.charge.label')} hint={t('fin.refunds.detail.chargeOverride')}>
                {(field) => <ChargeChoice id={field.id} value={field.value} onChange={field.onChange} />}
              </FormField>
            ) : null}
            {!online ? (
              <FormField name="reference" label={t('fin.refunds.detail.payoutRef')} optional hint={t('fin.refunds.detail.payoutRefOptional')}>
                {(field) => <Input {...field} autoComplete="off" maxLength={120} dir="auto" />}
              </FormField>
            ) : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('fin.refunds.detail.approve')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- record the pay-out

function CompleteDialog({ open, onOpenChange, refund, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; refund: RefundRow; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const form = useZodForm(completeRefundSchema, { defaultValues: { reference: '' } });
  React.useEffect(() => {
    if (open) form.reset({ reference: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.refunds.complete(refund.id, { reference: values.reference });
            toasts.success(t('fin.refunds.detail.completedToast', { number: refund.refundNo }));
            await onDone();
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.refunds.detail.completeTitle')}</DialogTitle>
            <DialogDescription>{t('fin.refunds.detail.completeText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
              <span>{t('fin.refunds.detail.amount')}</span>
              <Money amount={refund.amount} currency={refund.currency} className="font-semibold" />
            </div>
            <FormField name="reference" label={t('fin.refunds.detail.payoutRef')} required hint={t('fin.refunds.detail.payoutRefHint')}>
              {(field) => <Input {...field} autoComplete="off" maxLength={120} dir="auto" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('fin.refunds.detail.complete')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
