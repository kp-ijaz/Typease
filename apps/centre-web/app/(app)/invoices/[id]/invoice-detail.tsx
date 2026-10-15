'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Banknote, CheckCircle2, ExternalLink, FileDown, FileMinus2, Link2, MoreHorizontal, Pencil } from 'lucide-react';
import { isApiError, newIdempotencyKey } from '@typease/api-client';
import { createCreditNoteSchema, payInvoiceSchema } from '@typease/validation';
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Form, FormError, FormField, MoneyInput, PageHeader, RequirePermission, StatusBadge, Textarea,
  compareMoney, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { InvoiceRemindersCard } from '@/components/fin/invoice-reminders';
import { DetailSkeleton, FeeBreakdown, ImmutableNote, LinesTable, LoadError, Money, ReasonDialog, Section, TextLink, useDownload } from '@/components/fin/shared';
import type { InvoiceDetail as Invoice, PaymentLink } from '@/components/fin/types';
import { MONEY_RESOURCES, finKeys } from '@/lib/keys/fin';

export function InvoiceDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['invoice.read']}>
      <InvoiceDetailInner id={id} />
    </RequirePermission>
  );
}

function InvoiceDetailInner({ id }: { id: string }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const download = useDownload();

  const invoice = useQuery({ queryKey: finKeys.invoices.detail(id), queryFn: ({ signal }) => api.invoices.get(id, signal) });
  const mayReadRefunds = session.hasAnyPermission(['refund.request', 'refund.approve']);
  const refunds = useQuery({
    queryKey: finKeys.invoices.refunds(id),
    queryFn: ({ signal }) => api.refunds.list({ invoiceId: id, pageSize: 50, sort: 'createdAt:desc' }, signal),
    enabled: mayReadRefunds && !!invoice.data && Number(invoice.data.amountPaid) > 0,
  });
  const companyId = invoice.data?.corporateAccountId ?? null;
  const statement = useQuery({ queryKey: finKeys.corporateStatement(companyId ?? ''), queryFn: ({ signal }) => api.invoices.corporateStatement(companyId as string, signal), enabled: !!companyId });

  const [dialog, setDialog] = React.useState<'issue' | 'void' | 'credit' | 'link' | null>(null);

  const refreshMoney = async () => {
    await Promise.all(MONEY_RESOURCES.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  if (invoice.isPending) return <DetailSkeleton />;
  if (invoice.isError) {
    return (
      <>
        <PageHeader title={t('fin.invoices.detail.title')} breadcrumbs={[{ label: t('fin.invoices.title'), href: '/invoices' }]} />
        <LoadError error={invoice.error} onRetry={() => void invoice.refetch()} />
      </>
    );
  }

  const inv = invoice.data;
  const draft = inv.status === 'DRAFT';
  const payable = inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID';
  const untouched = Number(inv.amountPaid) === 0 && Number(inv.amountCredited) === 0;
  const canManage = session.hasPermission('invoice.manage');
  const canRecord = session.hasPermission('payment.record');
  const canCredit = session.hasPermission('creditnote.manage') && payable && Number(inv.balanceDue) > 0;
  const canVoid = canManage && inv.status === 'ISSUED' && untouched;
  // A draft has a placeholder instead of a number, also after it was discarded (it then stays on file as void).
  const neverIssued = draft || inv.invoiceNo.startsWith('DRAFT-');
  const title = neverIssued ? t('fin.invoices.draftNumber') : inv.invoiceNo;
  const pdf = () => void download.save('pdf', api.invoices.pdfPath(inv.id), { fallbackFilename: `${inv.invoiceNo}.pdf` });

  const issue = async () => {
    try {
      const issued = await api.invoices.issue(inv.id);
      toasts.success(t('fin.invoices.detail.issued'), t('fin.invoices.detail.issuedDescription', { number: issued.invoiceNo }));
      await refreshMoney();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const primary = draft ? (
    canManage ? (
      <Button variant="accent" onClick={() => setDialog('issue')}>
        <CheckCircle2 aria-hidden="true" />
        {t('fin.invoices.detail.issue')}
      </Button>
    ) : null
  ) : payable && canRecord ? (
    <Button asChild variant="accent">
      <Link href={`/payments/new?invoiceId=${inv.id}`}>
        <Banknote aria-hidden="true" />
        {t('fin.invoices.recordPayment')}
      </Link>
    </Button>
  ) : null;

  const menuItems = [
    draft && canManage ? (
      <DropdownMenuItem key="edit" asChild>
        <Link href={`/invoices/${inv.id}/edit`}>
          <Pencil aria-hidden="true" />
          {t('fin.invoices.detail.editDraft')}
        </Link>
      </DropdownMenuItem>
    ) : null,
    payable && canRecord ? (
      <DropdownMenuItem key="link" onSelect={() => setDialog('link')}>
        <Link2 aria-hidden="true" />
        {t('fin.invoices.detail.paymentLink')}
      </DropdownMenuItem>
    ) : null,
    canCredit ? (
      <DropdownMenuItem key="credit" onSelect={() => setDialog('credit')}>
        <FileMinus2 aria-hidden="true" />
        {t('fin.invoices.detail.creditNote')}
      </DropdownMenuItem>
    ) : null,
    (draft && canManage) || canVoid ? <DropdownMenuSeparator key="sep" /> : null,
    (draft && canManage) || canVoid ? (
      <DropdownMenuItem key="void" destructive onSelect={() => setDialog('void')}>
        <Ban aria-hidden="true" />
        {draft ? t('fin.invoices.detail.discard') : t('fin.invoices.detail.void')}
      </DropdownMenuItem>
    ) : null,
  ].filter(Boolean);

  const secondary = (
    <>
      {!neverIssued ? (
        <Button variant="outline" onClick={pdf} loading={download.busy === 'pdf'} loadingText={t('common.loading')}>
          <FileDown aria-hidden="true" />
          {t('fin.common.downloadPdf')}
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
  );

  return (
    <>
      <PageHeader
        title={<span className="tabular">{title}</span>}
        breadcrumbs={[{ label: t('fin.invoices.title'), href: '/invoices' }]}
        meta={
          <>
            <StatusBadge kind="invoice" status={inv.status} />
            {inv.overdue ? <Badge tone="danger">{t('fin.invoices.overdue')}</Badge> : null}
          </>
        }
        description={draft ? t('fin.invoices.detail.draftDescription') : t('fin.invoices.detail.description', { customer: inv.customer.fullName })}
        action={primary}
        secondary={secondary}
      />

      {inv.status === 'VOID' ? (
        <Alert tone="warning" className="mb-6" title={t('fin.invoices.detail.voidedTitle', { date: formatDate(inv.voidedAt) })}>
          {inv.voidReason ? <span dir="auto">{inv.voidReason}</span> : null}
        </Alert>
      ) : null}
      {inv.overdue && payable ? (
        <Alert tone="danger" className="mb-6">
          {t('fin.invoices.detail.overdueText', { date: formatDate(inv.dueAt) })}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title={t('fin.invoices.detail.summary')}>
            <DescriptionList
              columns={3}
              items={[
                {
                  label: t('fin.common.customer'),
                  value: (
                    <>
                      <TextLink href={`/customers/${inv.customer.id}`}>{inv.customer.fullName}</TextLink>
                      <span className="tabular block text-sm text-muted-foreground">{inv.customer.customerNo}</span>
                    </>
                  ),
                },
                { label: t('fin.common.company'), value: inv.corporateAccount ? <TextLink href={`/corporate/${inv.corporateAccount.id}`}>{inv.corporateAccount.companyName}</TextLink> : null },
                { label: t('fin.common.request'), value: inv.request ? <TextLink href={`/requests/${inv.request.id}`} className="tabular">{inv.request.requestNo}</TextLink> : null },
                { label: t('fin.common.quotation'), value: inv.quotation ? <TextLink href={`/quotations/${inv.quotation.id}`} className="tabular">{inv.quotation.quotationNo}</TextLink> : null },
                { label: t('fin.common.branch'), value: inv.branch.name },
                { label: t('fin.invoices.columns.issued'), value: inv.issuedAt ? formatDateTime(inv.issuedAt) : null },
                { label: t('fin.invoices.columns.due'), value: inv.dueAt ? formatDate(inv.dueAt) : null },
                ...(inv.notes ? [{ label: t('fin.invoices.form.notes'), value: <span dir="auto">{inv.notes}</span>, wide: true }] : []),
              ]}
            />
          </Section>

          <Section title={t('fin.lines.title')} flush>
            <LinesTable items={inv.invoiceItems} currency={inv.currency} caption={t('fin.lines.title')} />
          </Section>

          {!draft ? (
            <Section title={t('fin.invoices.detail.payments')} description={t('fin.invoices.detail.paymentsHint')} flush>
              {inv.payments.length === 0 ? (
                <EmptyState
                  icon={<Banknote />}
                  title={t('fin.invoices.detail.noPayments')}
                  description={payable ? t('fin.invoices.detail.noPaymentsText') : undefined}
                  action={
                    payable && canRecord ? (
                      <Button asChild variant="outline">
                        <Link href={`/payments/new?invoiceId=${inv.id}`}>{t('fin.invoices.recordPayment')}</Link>
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="divide-y">
                  {inv.payments.map((p) => (
                    <li key={p.allocationId} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5">
                      <div className="min-w-0">
                        <TextLink href={`/payments/${p.id}`} className="tabular">
                          {p.paymentNo}
                        </TextLink>
                        <span className="ms-2 inline-flex align-middle">
                          <StatusBadge kind="payment" status={p.status} />
                        </span>
                        <p className="text-sm text-muted-foreground">
                          {t(`fin.methods.${p.method}`)} · {formatDateTime(p.receivedAt)}
                          {p.receiptNo ? <span className="tabular"> · {p.receiptNo}</span> : null}
                        </p>
                      </div>
                      <div className="text-end">
                        <Money amount={p.allocated} currency={inv.currency} className="font-semibold" />
                        {compareMoney(p.allocated, p.amount) !== 0 ? (
                          <p className="text-sm text-muted-foreground">
                            {t('fin.invoices.detail.ofPayment')} <Money amount={p.amount} currency={inv.currency} />
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          {inv.creditNotes.length > 0 ? (
            <Section title={t('fin.invoices.detail.creditNotes')} description={t('fin.invoices.detail.creditNotesHint')} flush>
              <ul className="divide-y">
                {inv.creditNotes.map((cn) => (
                  <li key={cn.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="tabular font-medium text-foreground">{cn.creditNoteNo}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(cn.issuedAt)} · <span dir="auto">{cn.reason}</span>
                      </p>
                    </div>
                    <Money amount={cn.amount} currency={inv.currency} className="font-semibold" />
                    <Button
                      variant="subtle"
                      size="sm"
                      loading={download.busy === cn.id}
                      onClick={() => void download.save(cn.id, api.creditNotes.pdfPath(cn.id), { fallbackFilename: `${cn.creditNoteNo}.pdf` })}
                      aria-label={`${t('fin.common.downloadPdf')} ${cn.creditNoteNo}`}
                    >
                      <FileDown aria-hidden="true" />
                      {t('fin.common.pdf')}
                    </Button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {refunds.data && refunds.data.data.length > 0 ? (
            <Section title={t('fin.invoices.detail.refunds')} flush>
              <ul className="divide-y">
                {refunds.data.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5">
                    <div className="min-w-0">
                      <TextLink href={`/refunds/${r.id}`} className="tabular">
                        {r.refundNo}
                      </TextLink>
                      <span className="ms-2 inline-flex align-middle">
                        <StatusBadge kind="refund" status={r.status} />
                      </span>
                      <p className="text-sm text-muted-foreground" dir="auto">
                        {r.reason}
                      </p>
                    </div>
                    <Money amount={r.amount} currency={r.currency} className="font-semibold" />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>

        <div className="space-y-6">
          <Section title={t('fin.breakdown.title')}>
            <FeeBreakdown totals={inv} extras={draft ? undefined : { amountPaid: inv.amountPaid, amountCredited: inv.amountCredited, amountRefunded: inv.amountRefunded, balanceDue: inv.balanceDue }} />
            {draft ? <p className="mt-3 text-sm text-muted-foreground">{t('fin.invoices.detail.draftTotalsNote')}</p> : <ImmutableNote className="mt-4">{t('fin.invoices.immutable')}</ImmutableNote>}
          </Section>

          {draft || inv.status === 'VOID' ? null : <InvoiceRemindersCard invoiceId={inv.id} payable={payable} />}

          {companyId ? (
            <Section title={t('fin.invoices.detail.companyAccount')}>
              {statement.isPending ? (
                <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
              ) : statement.isError ? (
                <LoadError error={statement.error} onRetry={() => void statement.refetch()} />
              ) : (
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('fin.common.company'), value: statement.data.account.companyName },
                    { label: t('fin.invoices.detail.openBalance'), value: <Money amount={statement.data.openBalance} currency={statement.data.currency} /> },
                    ...(statement.data.account.creditApproved && statement.data.availableCredit !== null
                      ? [{ label: t('fin.invoices.detail.availableCredit'), value: <Money amount={statement.data.availableCredit} currency={statement.data.currency} /> }]
                      : []),
                    { label: t('fin.invoices.detail.paymentTerms'), value: t('fin.invoices.detail.paymentTermsDays', { days: statement.data.account.paymentTermsDays }) },
                  ]}
                />
              )}
              <Button asChild variant="link" className="mt-3">
                <Link href={`/corporate/${companyId}?tab=statement`}>
                  {t('fin.invoices.detail.openStatement')}
                  <ExternalLink aria-hidden="true" />
                </Link>
              </Button>
            </Section>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'issue'}
        onOpenChange={(open) => setDialog(open ? 'issue' : null)}
        tone="default"
        title={t('fin.invoices.detail.issueTitle')}
        description={t('fin.invoices.detail.issueText')}
        confirmLabel={t('fin.invoices.detail.issue')}
        onConfirm={issue}
      >
        <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
          <span>{t('fin.breakdown.total')}</span>
          <Money amount={inv.total} currency={inv.currency} className="font-semibold" />
        </div>
      </ConfirmDialog>

      <ReasonDialog
        open={dialog === 'void'}
        onOpenChange={(open) => setDialog(open ? 'void' : null)}
        title={draft ? t('fin.invoices.detail.discardTitle') : t('fin.invoices.detail.voidTitle', { number: inv.invoiceNo })}
        description={draft ? t('fin.invoices.detail.discardText') : t('fin.invoices.detail.voidText')}
        label={t('fin.common.reason')}
        hint={t('fin.common.reasonAudit')}
        submitLabel={draft ? t('fin.invoices.detail.discard') : t('fin.invoices.detail.void')}
        submitVariant="destructive"
        onSubmit={async (reason) => {
          await api.invoices.void(inv.id, { reason });
          toasts.success(draft ? t('fin.invoices.detail.discarded') : t('fin.invoices.detail.voided', { number: inv.invoiceNo }));
          await refreshMoney();
          if (draft) router.push('/invoices');
        }}
      />

      <CreditNoteDialog open={dialog === 'credit'} onOpenChange={(open) => setDialog(open ? 'credit' : null)} invoice={inv} onDone={refreshMoney} />
      <PaymentLinkDialog open={dialog === 'link'} onOpenChange={(open) => setDialog(open ? 'link' : null)} invoice={inv} onCreated={refreshMoney} />
    </>
  );
}

// ---------------------------------------------------------------- credit note

const creditSchema = createCreditNoteSchema.pick({ amount: true, reason: true });

function CreditNoteDialog({ open, onOpenChange, invoice, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; invoice: Invoice; onDone: () => Promise<void> }) {
  const { t, formatMoney } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const form = useZodForm(creditSchema, { defaultValues: { amount: '', reason: '' } });
  React.useEffect(() => {
    if (open) form.reset({ amount: '', reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const max = invoice.balanceDue;
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            if (compareMoney(values.amount, max) > 0) {
              form.setError('amount', { type: 'max', message: t('fin.invoices.credit.tooMuch', { max: formatMoney(max, invoice.currency) }) });
              return;
            }
            const note = await api.creditNotes.create({ invoiceId: invoice.id, amount: values.amount, reason: values.reason });
            toasts.success(t('fin.invoices.credit.done', { number: note.creditNoteNo }), t('fin.invoices.credit.doneDescription', { balance: formatMoney(note.invoiceBalanceDue, invoice.currency) }));
            await onDone();
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.invoices.credit.title', { number: invoice.invoiceNo })}</DialogTitle>
            <DialogDescription>{t('fin.invoices.credit.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="amount" label={t('fin.invoices.credit.amount')} required hint={t('fin.invoices.credit.amountHint', { max: formatMoney(max, invoice.currency) })}>
              {(field) => <MoneyInput {...field} currency={invoice.currency} autoFocus />}
            </FormField>
            <FormField name="reason" label={t('fin.common.reason')} required hint={t('fin.invoices.credit.reasonHint')}>
              {(field) => <Textarea {...field} rows={3} maxLength={500} />}
            </FormField>
            {Number(invoice.amountPaid) > 0 ? <Alert tone="info">{t('fin.invoices.credit.paidNote')}</Alert> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('fin.invoices.credit.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- online payment link

const linkSchema = payInvoiceSchema.pick({ amount: true });

function PaymentLinkDialog({ open, onOpenChange, invoice, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; invoice: Invoice; onCreated: () => Promise<void> }) {
  const { t, formatMoney, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const form = useZodForm(linkSchema, { defaultValues: { amount: invoice.balanceDue } });
  const [link, setLink] = React.useState<PaymentLink | null>(null);
  const [noGateway, setNoGateway] = React.useState(false);
  // One key per opening of the dialog: a double click or a retry returns the same link instead of a second payment.
  const key = React.useRef(newIdempotencyKey());

  const mayManageIntegrations = session.hasPermission('integration.manage');
  // Only people who manage integrations may read them; everyone else learns it from the API's answer.
  const gateways = useQuery({ queryKey: finKeys.gateway, queryFn: ({ signal }) => api.paymentGateways(signal), enabled: open && mayManageIntegrations, staleTime: 60_000 });
  const knownMissing = noGateway || (gateways.data !== undefined && gateways.data.length === 0);

  React.useEffect(() => {
    if (open) {
      key.current = newIdempotencyKey();
      form.reset({ amount: invoice.balanceDue });
      setLink(null);
      setNoGateway(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const amount = values.amount || invoice.balanceDue;
            if (compareMoney(amount, invoice.balanceDue) > 0) {
              form.setError('amount', { type: 'max', message: t('fin.invoices.link.tooMuch', { max: formatMoney(invoice.balanceDue, invoice.currency) }) });
              return;
            }
            try {
              setLink(await api.invoices.pay(invoice.id, { amount }, key.current));
              await onCreated();
            } catch (error) {
              if (isApiError(error) && error.code === 'INTEGRATION_NOT_CONFIGURED') {
                setNoGateway(true);
                return;
              }
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.invoices.link.title')}</DialogTitle>
            <DialogDescription>{t('fin.invoices.link.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {knownMissing ? (
              <Alert
                tone="warning"
                live
                title={t('fin.gateway.missingTitle')}
                action={
                  mayManageIntegrations ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/integrations">{t('fin.gateway.openIntegrations')}</Link>
                    </Button>
                  ) : undefined
                }
              >
                {t('fin.gateway.missingText')}
              </Alert>
            ) : link ? (
              <>
                <Alert tone="success" live title={t('fin.invoices.link.readyTitle', { amount: formatMoney(link.amount, link.currency) })}>
                  {t('fin.invoices.link.readyText', { expires: formatDateTime(link.expiresAt) })}
                </Alert>
                {link.testMode ? <Alert tone="warning">{t('fin.gateway.testMode')}</Alert> : null}
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 ps-3">
                  <span className="ltr-value min-w-0 flex-1 truncate text-sm" title={link.checkoutUrl}>
                    {link.checkoutUrl}
                  </span>
                  <CopyButton value={link.checkoutUrl} label={t('fin.invoices.link.copy')} showLabel variant="outline" />
                </div>
                <p className="text-sm text-muted-foreground">{t('fin.invoices.link.pendingNote', { number: link.paymentNo })}</p>
              </>
            ) : (
              <>
                <FormField name="amount" label={t('fin.invoices.link.amount')} hint={t('fin.invoices.link.amountHint', { max: formatMoney(invoice.balanceDue, invoice.currency) })}>
                  {(field) => <MoneyInput {...field} currency={invoice.currency} />}
                </FormField>
                <FormError />
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {link || knownMissing ? t('common.close') : t('common.cancel')}
            </Button>
            {link ? (
              <Button asChild>
                <a href={link.checkoutUrl} target="_blank" rel="noopener noreferrer">
                  {t('fin.invoices.link.open')}
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            ) : knownMissing ? (
              <Button asChild>
                <Link href={`/payments/new?invoiceId=${invoice.id}`}>{t('fin.invoices.recordPayment')}</Link>
              </Button>
            ) : (
              <Button type="submit" loading={form.formState.isSubmitting || gateways.isLoading} loadingText={t('common.loading')}>
                {t('fin.invoices.link.submit')}
              </Button>
            )}
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
