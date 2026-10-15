'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, BadgeCheck, ClipboardCheck, FileDown, MoreHorizontal, Pencil, Receipt, Send, XCircle } from 'lucide-react';
import { discountRejectSchema, z } from '@typease/validation';
import {
  Alert, Badge, Button, Checkbox, ChoiceLabel, ConfirmDialog, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Form, FormError, FormField, PageHeader, RadioGroup, RadioGroupItem, RequirePermission, StatusBadge,
  Textarea, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { DetailSkeleton, FeeBreakdown, ImmutableNote, LinesTable, LoadError, Money, ReasonDialog, Section, TextLink, useApprovers, useDownload, useStaffDirectory } from '@/components/fin/shared';
import type { QuotationDetail as Quotation } from '@/components/fin/types';
import { MONEY_RESOURCES, finKeys } from '@/lib/keys/fin';

type DialogKind = 'send' | 'approveDiscount' | 'rejectDiscount' | 'decision' | 'cancel' | null;

export function QuotationDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['quotation.read']}>
      <QuotationDetailInner id={id} />
    </RequirePermission>
  );
}

function QuotationDetailInner({ id }: { id: string }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const download = useDownload();
  const staff = useStaffDirectory();
  const quotation = useQuery({ queryKey: finKeys.quotations.detail(id), queryFn: ({ signal }) => api.quotations.get(id, signal) });
  const approvers = useApprovers('discount.approve', quotation.data?.discountRequestedById);
  const [dialog, setDialog] = React.useState<DialogKind>(null);
  const close = (kind: Exclude<DialogKind, null>) => (open: boolean) => setDialog(open ? kind : null);

  const refresh = async () => {
    await Promise.all(MONEY_RESOURCES.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  if (quotation.isPending) return <DetailSkeleton />;
  if (quotation.isError) {
    return (
      <>
        <PageHeader title={t('fin.quotations.detail.title')} breadcrumbs={[{ label: t('fin.quotations.title'), href: '/quotations' }]} />
        <LoadError error={quotation.error} onRetry={() => void quotation.refetch()} />
      </>
    );
  }

  const q = quotation.data;
  const canManage = session.hasPermission('quotation.manage');
  const canApproveDiscount = session.hasPermission('discount.approve');
  const draft = q.status === 'DRAFT';
  const sent = q.status === 'SENT';
  const pending = draft && q.discountApproval === 'PENDING';
  const discountRejected = draft && q.discountApproval === 'REJECTED';
  const sendable = draft && (q.discountApproval === 'NONE' || q.discountApproval === 'APPROVED');
  const iRequested = staff.isMe(q.discountRequestedById);
  // The API lets the requester approve only when nobody else holds the permission (audited as a self-approval).
  const onlyApprover = iRequested && approvers !== null && approvers.length === 0;
  const mayDecideDiscount = pending && canApproveDiscount && (!iRequested || onlyApprover);
  const requester = staff.nameOf(q.discountRequestedById);
  const decider = staff.nameOf(q.discountDecidedById);

  const run = async (action: () => Promise<unknown>, message: string, description?: string) => {
    try {
      await action();
      toasts.success(message, description);
      await refresh();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const primary = q.invoice ? (
    <Button asChild variant="accent">
      <Link href={`/invoices/${q.invoice.id}`}>
        <Receipt aria-hidden="true" />
        {t('fin.quotations.detail.openInvoice', { number: q.invoice.invoiceNo })}
      </Link>
    </Button>
  ) : mayDecideDiscount ? (
    <Button variant="accent" onClick={() => setDialog('approveDiscount')}>
      <BadgeCheck aria-hidden="true" />
      {t('fin.quotations.discount.approve')}
    </Button>
  ) : sendable && canManage ? (
    <Button variant="accent" onClick={() => setDialog('send')}>
      <Send aria-hidden="true" />
      {t('fin.quotations.detail.send')}
    </Button>
  ) : sent && canManage && !q.expired ? (
    <Button variant="accent" onClick={() => setDialog('decision')}>
      <ClipboardCheck aria-hidden="true" />
      {t('fin.quotations.decision.open')}
    </Button>
  ) : null;

  const menuItems = [
    draft && canManage ? (
      <DropdownMenuItem key="edit" asChild>
        <Link href={`/quotations/${q.id}/edit`}>
          <Pencil aria-hidden="true" />
          {t('fin.quotations.detail.edit')}
        </Link>
      </DropdownMenuItem>
    ) : null,
    (draft || sent) && canManage ? <DropdownMenuSeparator key="sep" /> : null,
    (draft || sent) && canManage ? (
      <DropdownMenuItem key="cancel" destructive onSelect={() => setDialog('cancel')}>
        <Ban aria-hidden="true" />
        {t('fin.quotations.detail.cancel')}
      </DropdownMenuItem>
    ) : null,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        title={<span className="tabular">{q.quotationNo}</span>}
        breadcrumbs={[{ label: t('fin.quotations.title'), href: '/quotations' }]}
        meta={
          <>
            <StatusBadge kind="quotation" status={q.status} />
            {pending ? <Badge tone="warning">{t('fin.quotations.discount.badgePending')}</Badge> : null}
            {discountRejected ? <Badge tone="danger">{t('fin.quotations.discount.badgeRejected')}</Badge> : null}
          </>
        }
        description={t('fin.quotations.detail.description', { customer: q.customer.fullName })}
        action={primary}
        secondary={
          <>
            <Button variant="outline" loading={download.busy === 'pdf'} loadingText={t('common.loading')} onClick={() => void download.save('pdf', api.quotations.pdfPath(q.id), { fallbackFilename: `${q.quotationNo}.pdf` })}>
              <FileDown aria-hidden="true" />
              {t('fin.common.downloadPdf')}
            </Button>
            {mayDecideDiscount ? (
              <Button variant="outline" onClick={() => setDialog('rejectDiscount')}>
                <XCircle aria-hidden="true" />
                {t('fin.quotations.discount.reject')}
              </Button>
            ) : null}
            {menuItems.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" aria-label={t('common.moreActions')} className="!flex-none">
                    <MoreHorizontal aria-hidden="true" />
                    <span className="sm:hidden">{t('common.moreActions')}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>{menuItems}</DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {/* What stands between this quotation and the customer, in plain words. */}
      <div className="mb-6 space-y-3 empty:hidden">
        {pending ? (
          <Alert
            tone="warning"
            title={t('fin.quotations.discount.pendingTitle')}
          >
            <p>{onlyApprover ? t('fin.quotations.discount.pendingOnlyApprover') : iRequested ? t('fin.quotations.discount.pendingOwn') : canApproveDiscount ? t('fin.quotations.discount.pendingCanApprove') : t('fin.quotations.discount.pendingText')}</p>
            <p className="mt-1">{approvers === null ? t('fin.quotations.discount.approversUnknown') : approvers.length ? t('fin.quotations.discount.approvers', { names: approvers.join(', ') }) : t('fin.quotations.discount.approversNone')}</p>
          </Alert>
        ) : null}
        {discountRejected ? (
          <Alert tone="danger" title={t('fin.quotations.discount.rejectedTitle')}>
            {t('fin.quotations.discount.rejectedText')}
          </Alert>
        ) : null}
        {sendable ? <Alert tone="info">{q.discountApproval === 'APPROVED' ? t('fin.quotations.detail.readyApproved') : t('fin.quotations.detail.ready')}</Alert> : null}
        {sent && !q.expired ? <Alert tone="info">{t('fin.quotations.detail.sentText', { date: formatDate(q.validUntil) })}</Alert> : null}
        {q.status === 'APPROVED' && q.invoice ? (
          <Alert
            tone="success"
            title={t('fin.quotations.detail.approvedTitle')}
          >
            {t('fin.quotations.detail.approvedText', { number: q.invoice.invoiceNo })} <StatusBadge kind="invoice" status={q.invoice.status} />
          </Alert>
        ) : null}
        {q.status === 'REJECTED' ? (
          <Alert tone="danger" title={t('fin.quotations.detail.rejectedTitle')}>
            {q.rejectionReason ? <span dir="auto">{q.rejectionReason}</span> : null}
          </Alert>
        ) : null}
        {q.status === 'EXPIRED' || (sent && q.expired) ? (
          <Alert
            tone="warning"
            title={t('fin.quotations.detail.expiredTitle', { date: formatDate(q.validUntil) })}
            action={
              canManage ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={q.requestId ? `/quotations/new?requestId=${q.requestId}` : `/quotations/new?customerId=${q.customerId}`}>{t('fin.quotations.new')}</Link>
                </Button>
              ) : undefined
            }
          >
            {t('fin.quotations.detail.expiredText')}
          </Alert>
        ) : null}
        {q.status === 'SUPERSEDED' ? (
          <Alert
            tone="info"
            title={t('fin.quotations.detail.supersededTitle')}
            action={
              q.requestId ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/quotations?requestId=${q.requestId}`}>{t('fin.quotations.detail.supersededLink')}</Link>
                </Button>
              ) : undefined
            }
          >
            {t('fin.quotations.detail.supersededText')}
          </Alert>
        ) : null}
        {q.status === 'CANCELLED' ? <Alert tone="info">{t('fin.quotations.detail.cancelledText')}</Alert> : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title={t('fin.quotations.detail.summary')}>
            <DescriptionList
              columns={3}
              items={[
                {
                  label: t('fin.common.customer'),
                  value: (
                    <>
                      <TextLink href={`/customers/${q.customer.id}`}>{q.customer.fullName}</TextLink>
                      <span className="tabular block text-sm text-muted-foreground">{q.customer.customerNo}</span>
                    </>
                  ),
                },
                { label: t('fin.common.company'), value: q.corporateAccount ? <TextLink href={`/corporate/${q.corporateAccount.id}`}>{q.corporateAccount.companyName}</TextLink> : null },
                { label: t('fin.common.request'), value: q.request ? <TextLink href={`/requests/${q.request.id}`} className="tabular">{q.request.requestNo}</TextLink> : null },
                { label: t('fin.common.branch'), value: q.branch.name },
                { label: t('fin.quotations.columns.validUntil'), value: q.validUntil ? formatDate(q.validUntil) : null },
                { label: t('fin.quotations.detail.sentAt'), value: q.sentAt ? formatDateTime(q.sentAt) : null },
                ...(q.decidedAt
                  ? [
                      {
                        label: t('fin.quotations.detail.decidedAt'),
                        value: (
                          <>
                            {formatDateTime(q.decidedAt)}
                            <span className="block text-sm text-muted-foreground">
                              {q.decidedByType === 'STAFF' ? t('fin.quotations.detail.decidedByStaff', { name: staff.nameOf(q.decidedById) ?? t('fin.quotations.detail.aStaffMember') }) : t('fin.quotations.detail.decidedByCustomer')}
                            </span>
                          </>
                        ),
                      },
                    ]
                  : []),
                ...(q.notes ? [{ label: t('fin.quotations.form.notes'), value: <span dir="auto">{q.notes}</span>, wide: true }] : []),
              ]}
            />
          </Section>

          <Section title={t('fin.lines.title')} flush>
            <LinesTable items={q.quotationItems} currency={q.currency} caption={t('fin.lines.title')} />
          </Section>

          {q.discountApproval !== 'NONE' ? (
            <Section title={t('fin.quotations.discount.title')}>
              <DescriptionList
                columns={3}
                items={[
                  { label: t('fin.common.status'), value: <Badge tone={q.discountApproval === 'APPROVED' ? 'success' : q.discountApproval === 'REJECTED' ? 'danger' : 'warning'}>{t(`fin.quotations.discount.states.${q.discountApproval}`)}</Badge> },
                  { label: t('fin.breakdown.discount'), value: <Money amount={q.discountTotal} currency={q.currency} /> },
                  { label: t('fin.quotations.discount.requestedBy'), value: iRequested ? t('fin.common.you') : requester },
                  ...(q.discountDecidedById ? [{ label: t('fin.quotations.discount.decidedBy'), value: staff.isMe(q.discountDecidedById) ? t('fin.common.you') : decider }] : []),
                  { label: t('fin.common.reason'), value: q.discountReason ? <span dir="auto">{q.discountReason}</span> : null, wide: true },
                ]}
              />
            </Section>
          ) : null}
        </div>

        <div className="space-y-6">
          <Section title={t('fin.breakdown.title')}>
            <FeeBreakdown totals={q} />
            {!draft ? <ImmutableNote className="mt-4">{t('fin.quotations.immutable')}</ImmutableNote> : null}
          </Section>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'send'}
        onOpenChange={close('send')}
        tone="default"
        title={t('fin.quotations.detail.sendTitle')}
        description={t('fin.quotations.detail.sendText')}
        confirmLabel={t('fin.quotations.detail.send')}
        onConfirm={() => run(() => api.quotations.send(q.id), t('fin.quotations.detail.sentToast', { number: q.quotationNo }))}
      />

      <ReasonDialog
        open={dialog === 'approveDiscount'}
        onOpenChange={close('approveDiscount')}
        title={t('fin.quotations.discount.approveTitle')}
        description={t('fin.quotations.discount.approveText')}
        label={t('fin.common.note')}
        hint={t('fin.common.reasonAudit')}
        required={false}
        submitLabel={t('fin.quotations.discount.approve')}
        onSubmit={async (note) => {
          await api.quotations.approveDiscount(q.id, { note: note || null });
          toasts.success(t('fin.quotations.discount.approved'));
          await refresh();
        }}
      >
        <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
          <span>{t('fin.breakdown.discount')}</span>
          <Money amount={q.discountTotal} currency={q.currency} className="font-semibold" />
        </div>
        {q.discountReason ? (
          <p className="text-sm text-muted-foreground">
            {t('fin.quotations.discount.reasonGiven')} <span dir="auto">{q.discountReason}</span>
          </p>
        ) : null}
      </ReasonDialog>

      <RejectDiscountDialog open={dialog === 'rejectDiscount'} onOpenChange={close('rejectDiscount')} quotation={q} onDone={refresh} />
      <DecisionDialog open={dialog === 'decision'} onOpenChange={close('decision')} quotation={q} onDone={refresh} />

      <ReasonDialog
        open={dialog === 'cancel'}
        onOpenChange={close('cancel')}
        title={t('fin.quotations.detail.cancelTitle', { number: q.quotationNo })}
        description={sent ? t('fin.quotations.detail.cancelSentText') : t('fin.quotations.detail.cancelText')}
        label={t('fin.common.reason')}
        hint={t('fin.common.reasonAudit')}
        required={false}
        submitLabel={t('fin.quotations.detail.cancel')}
        submitVariant="destructive"
        onSubmit={async (reason) => {
          await api.quotations.cancel(q.id, { reason: reason || null });
          toasts.success(t('fin.quotations.detail.cancelled', { number: q.quotationNo }));
          await refresh();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- reject a discount

function RejectDiscountDialog({ open, onOpenChange, quotation, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; quotation: Quotation; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const form = useZodForm(discountRejectSchema, { defaultValues: { reason: '', clearDiscounts: true } });
  const clearId = React.useId();
  React.useEffect(() => {
    if (open) form.reset({ reason: '', clearDiscounts: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.quotations.rejectDiscount(quotation.id, { reason: values.reason, clearDiscounts: values.clearDiscounts });
            toasts.success(t('fin.quotations.discount.rejected'), values.clearDiscounts ? t('fin.quotations.discount.rejectedCleared') : undefined);
            await onDone();
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.quotations.discount.rejectTitle')}</DialogTitle>
            <DialogDescription>{t('fin.quotations.discount.rejectText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="reason" label={t('fin.common.reason')} required hint={t('fin.common.reasonAudit')}>
              {(field) => <Textarea {...field} rows={3} maxLength={500} />}
            </FormField>
            <FormField name="clearDiscounts" label={t('fin.quotations.discount.afterReject')} hideLabel>
              {(field) => (
                <ChoiceLabel
                  htmlFor={clearId}
                  control={<Checkbox id={clearId} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />}
                  label={t('fin.quotations.discount.clear')}
                  description={t('fin.quotations.discount.clearHint')}
                />
              )}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('fin.quotations.discount.reject')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the customer's decision, recorded by staff

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(3).max(500) });

function DecisionDialog({ open, onOpenChange, quotation, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; quotation: Quotation; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const form = useZodForm(decisionSchema, { defaultValues: { decision: 'approve', note: '' } });
  const decision = form.watch('decision');
  const id = React.useId();
  React.useEffect(() => {
    if (open) form.reset({ decision: 'approve', note: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            if (values.decision === 'approve') {
              const result = await api.quotations.approve(quotation.id, { note: values.note });
              toasts.success(t('fin.quotations.decision.approved'), t('fin.quotations.decision.approvedDescription', { number: result.invoice.invoiceNo }));
            } else {
              await api.quotations.reject(quotation.id, { reason: values.note });
              toasts.success(t('fin.quotations.decision.rejected'));
            }
            await onDone();
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.quotations.decision.title')}</DialogTitle>
            <DialogDescription>{t('fin.quotations.decision.description', { customer: quotation.customer.fullName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="decision" label={t('fin.quotations.decision.what')} required>
              {(field) => (
                <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('fin.quotations.decision.what')}>
                  <ChoiceLabel htmlFor={`${id}-approve`} control={<RadioGroupItem id={`${id}-approve`} value="approve" />} label={t('fin.quotations.decision.approve')} description={t('fin.quotations.decision.approveHint')} />
                  <ChoiceLabel htmlFor={`${id}-reject`} control={<RadioGroupItem id={`${id}-reject`} value="reject" />} label={t('fin.quotations.decision.reject')} description={t('fin.quotations.decision.rejectHint')} />
                </RadioGroup>
              )}
            </FormField>
            <FormField name="note" label={decision === 'approve' ? t('fin.quotations.decision.noteApprove') : t('fin.quotations.decision.noteReject')} required hint={t('fin.quotations.decision.noteHint')}>
              {(field) => <Textarea {...field} rows={3} maxLength={500} />}
            </FormField>
            {decision === 'approve' ? (
              <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
                <span>{t('fin.quotations.decision.invoiceTotal')}</span>
                <Money amount={quotation.total} currency={quotation.currency} className="font-semibold" />
              </div>
            ) : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={decision === 'approve' ? 'default' : 'destructive'} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {decision === 'approve' ? t('fin.quotations.decision.submitApprove') : t('fin.quotations.decision.submitReject')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
