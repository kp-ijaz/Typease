'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Building2, Eye, FileText, Lock, MessageSquare, Pencil, Receipt, ScrollText, Send, UserCheck, UserCog, Wand2 } from 'lucide-react';
import { REQUEST_STATUS_META } from '@typease/types';
import { formFields } from '@typease/validation';
import {
  Alert, Avatar, Badge, Button, Card, CardContent, CardHeader, CardTitle, ChoiceLabel, DescriptionList, EmptyState, PermissionGate, Skeleton, StatusBadge, Switch, Table,
  TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, Timeline, cn, countryName, useI18n, useSession, useToast, type DescriptionItem, type TimelineItem,
} from '@typease/ui';
import { caseKeys } from '@/lib/keys/cases';
import { useCasesApi } from '@/components/cases/api';
import { DynamicForm, SourceBadge, checkForm, displayFormValue, fieldsPayload, formErrorsOf, type FormErrors, type FormValuesState } from '@/components/cases/dynamic-form';
import { SourceLabel, blockedText, externalStatusText, isClosed, useCaseError, useNewerWorkflow } from '@/components/cases/shared';
import type { CaseApproval, FeeTotals, InvoiceRow, QuotationRow } from '@/components/cases/types';
import { useCaseContext } from './case-context';

// ---------------------------------------------------------------- overview

export function OverviewTab() {
  const i18n = useI18n();
  const { t, pick, formatDateTime, formatDate, formatNumber, has } = i18n;
  const { view, open, can } = useCaseContext();
  const { workflow } = view;
  const newerWorkflow = useNewerWorkflow(view);

  const steps: TimelineItem[] = workflow.steps.map((step) => {
    const state = step.status === 'COMPLETED' ? 'done' : step.status === 'ACTIVE' ? 'current' : 'upcoming';
    const extra = step.status === 'SKIPPED' || step.status === 'CANCELLED' || step.status === 'FAILED';
    return {
      id: `${step.key}-${step.position}`,
      state,
      tone: step.status === 'FAILED' ? 'danger' : step.status === 'ACTIVE' && (step.escalatedAt || step.blocked) ? 'warning' : undefined,
      title: (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{pick(step.name, step.nameAr)}</span>
          {extra ? <Badge tone={step.status === 'FAILED' ? 'danger' : 'neutral'}>{t(`cases.overview.stepStatus.${step.status}`)}</Badge> : null}
          {step.status === 'ACTIVE' ? <Badge tone="brand">{t('cases.overview.stepStatus.ACTIVE')}</Badge> : null}
          {step.attempt > 1 ? <Badge tone="outline">{t('cases.overview.attempt', { count: formatNumber(step.attempt) })}</Badge> : null}
        </span>
      ),
      time:
        step.status === 'COMPLETED' && step.completedAt
          ? formatDateTime(step.completedAt)
          : step.status === 'ACTIVE'
            ? [step.startedAt ? t('cases.overview.since', { time: formatDateTime(step.startedAt) }) : '', step.dueAt ? t('cases.overview.due', { time: formatDateTime(step.dueAt) }) : ''].filter(Boolean).join(' · ')
            : undefined,
      description:
        step.blocked || step.note || step.escalatedAt || (step.status === 'ACTIVE' && step.assigneeRoleKey) ? (
          <div className="space-y-1">
            {step.status === 'ACTIVE' && step.assigneeRoleKey ? (
              <p className="text-muted-foreground">{t('cases.overview.doneBy', { role: has(`cases.roles.${step.assigneeRoleKey}`) ? t(`cases.roles.${step.assigneeRoleKey}`) : step.assigneeRoleKey })}</p>
            ) : null}
            {step.blocked ? <p className="text-warning-text">{blockedText(step.blocked, i18n)}</p> : null}
            {step.escalatedAt ? <p className="text-warning-text">{t('cases.overview.escalated', { time: formatDateTime(step.escalatedAt) })}</p> : null}
            {step.note ? (
              <p>
                <bdi>{step.note}</bdi>
              </p>
            ) : null}
          </div>
        ) : undefined,
    };
  });

  const lastVisible = [...view.history].reverse().find((h) => h.customerVisible);
  const customerStatus = REQUEST_STATUS_META[view.status];
  const facts: DescriptionItem[] = [
    { label: t('cases.overview.source'), value: t(`cases.sources.${view.source}`) },
    { label: t('cases.overview.created'), value: formatDateTime(view.createdAt) },
    { label: t('cases.overview.submitted'), value: view.submittedAt ? formatDateTime(view.submittedAt) : t('requests.notSubmitted') },
    ...(view.completedAt ? [{ label: t('cases.overview.completed'), value: formatDateTime(view.completedAt) }] : []),
    ...(view.cancelledAt ? [{ label: t('cases.overview.cancelled'), value: formatDateTime(view.cancelledAt) }] : []),
    ...(view.cancellationReason ? [{ label: t('cases.overview.cancellationReason'), value: <span dir="auto">{view.cancellationReason}</span> }] : []),
    ...(view.duplicateOfId
      ? [{ label: t('cases.overview.duplicateOf'), value: <Link href={`/requests/${view.duplicateOfId}`} className="font-medium text-secondary-text underline-offset-4 hover:underline">{t('cases.overview.openOriginal')}</Link> }]
      : []),
    { label: t('cases.overview.capability'), value: t(`cases.capability.${view.service.complianceCapability}`) },
    { label: t('cases.overview.review'), value: view.service.requiresApproval ? t('cases.overview.reviewYes') : t('cases.overview.reviewNo') },
    { label: t('cases.overview.paymentPolicy'), value: t(`cases.paymentPolicy.${view.service.paymentPolicy}`) },
    ...(view.corporateAccount ? [{ label: t('cases.overview.billedTo'), value: <Link href={`/corporate/${view.corporateAccount.id}`} className="font-medium text-secondary-text underline-offset-4 hover:underline">{pick(view.corporateAccount.companyName, view.corporateAccount.companyNameAr)}</Link> }] : []),
    ...(view.reopenedCount > 0 ? [{ label: t('cases.overview.reopened'), value: formatNumber(view.reopenedCount) }] : []),
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader className="items-center pb-4">
          <div>
            <CardTitle>{t('cases.overview.progress')}</CardTitle>
            {workflow.definition ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('cases.overview.workflow', { name: workflow.definition.name, version: formatNumber(workflow.version ?? 1) })}
                {workflow.migratedFromVersionId ? ` · ${t('cases.overview.migrated')}` : ''}
              </p>
            ) : null}
          </div>
          {newerWorkflow.available ? (
            <Button variant="ghost" size="sm" onClick={() => open({ type: 'migrate' })}>
              <Wand2 aria-hidden="true" />
              {t('cases.actions.migrateTitle')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="border-t">
          {workflow.status === 'NOT_STARTED' && view.status === 'DRAFT' ? (
            <Alert tone="info" className="mb-5">
              {t('cases.overview.notStarted')}
            </Alert>
          ) : null}
          {steps.length ? <Timeline items={steps} /> : <p className="text-sm text-muted-foreground">{t('cases.overview.noSteps')}</p>}
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>{t('cases.overview.customerSees')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 border-t">
            <p className="flex flex-wrap items-center gap-2">
              <Eye className="size-4 text-muted-foreground" aria-hidden="true" />
              <Badge tone={customerStatus.tone}>{pick(customerStatus.customerEn, customerStatus.customerAr)}</Badge>
            </p>
            <p className="text-base text-foreground/90">{pick(view.nextStep.text.en, view.nextStep.text.ar)}</p>
            {lastVisible?.customerMessage && ![customerStatus.customerEn, view.nextStep.text.en, view.nextStep.text.ar].includes(lastVisible.customerMessage) ? (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground/90">
                <bdi>{lastVisible.customerMessage}</bdi>
                <span className="mt-0.5 block text-xs text-muted-foreground">{formatDateTime(lastVisible.at)}</span>
              </p>
            ) : null}
            {view.externalStatus ? (
              <div className="space-y-1.5 rounded-md border px-3 py-2.5">
                <p className="text-sm text-muted-foreground">{t('cases.overview.externalStatus')}</p>
                <p className="text-base text-foreground">
                  <bdi>{externalStatusText(view.externalStatus.status, t)}</bdi>
                </p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <SourceLabel source={view.externalStatus.source} label={view.externalStatus.sourceLabel} />
                  {formatDate(view.externalStatus.at)}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="items-center pb-4">
            <CardTitle>{t('cases.fields.instructions')}</CardTitle>
            {can('edit_details') ? (
              <Button variant="ghost" size="sm" onClick={() => open({ type: 'details' })}>
                <Pencil aria-hidden="true" />
                {t('common.edit')}
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="border-t">
            {view.customerInstructions ? (
              <p className="whitespace-pre-wrap text-base text-foreground" dir="auto">
                {view.customerInstructions}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('cases.overview.noInstructions')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>{t('cases.overview.facts')}</CardTitle>
          </CardHeader>
          <CardContent className="border-t">
            <DescriptionList items={facts} columns={1} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- details (the service's form)

export function DetailsTab() {
  const i18n = useI18n();
  const { t, pick, locale } = i18n;
  const { view, apply, can } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const describe = useCaseError();
  const schema = view.form.schema;
  const [editing, setEditing] = React.useState(false);
  const [values, setValues] = React.useState<FormValuesState>(view.form.values);
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const fields = schema ? formFields(schema) : [];
  if (!schema || fields.length === 0) {
    return (
      <Card>
        <EmptyState icon={<FileText />} title={t('cases.details.noFormTitle')} description={t('cases.details.noFormText')} />
      </Card>
    );
  }

  const start = () => {
    setValues(view.form.values);
    setErrors({});
    setFailure(null);
    setEditing(true);
  };
  const save = async () => {
    // A draft may be half-filled; after submission the whole form has to stay valid (the API applies the same rule).
    const check = checkForm(schema, values, view.status === 'DRAFT', i18n);
    setErrors(check.errors);
    setFailure(null);
    if (!check.ok) return;
    setSaving(true);
    try {
      apply(await api.saveFields(view.id, fieldsPayload(schema, values, view.form.values)));
      toasts.success(t('cases.details.saved'), view.requestNo);
      setEditing(false);
    } catch (error) {
      const fieldErrors = formErrorsOf(error, schema, i18n);
      setErrors(fieldErrors);
      setFailure(Object.keys(fieldErrors).length ? t('form.checkFields') : describe(error));
    } finally {
      setSaving(false);
    }
  };

  const sourceOf = new Map(view.form.fields.map((f) => [f.key, f]));
  const visible = new Set(view.form.visibleFields);
  return (
    <Card>
      <CardHeader className="items-center pb-4">
        <div>
          <CardTitle>{t('cases.details.title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{editing ? t('cases.details.editingText') : t('cases.details.text')}</p>
        </div>
        {!editing && can('edit_fields') ? (
          <Button variant="outline" size="sm" onClick={start}>
            <Pencil aria-hidden="true" />
            {t('cases.details.edit')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="border-t">
        {editing ? (
          <div className="space-y-6">
            <DynamicForm
              schema={schema}
              values={values}
              errors={errors}
              sources={view.form.fields}
              disabled={saving}
              onChange={(key, value) => {
                setValues((s) => ({ ...s, [key]: value }));
                setErrors((s) => {
                  if (!(key in s)) return s;
                  const { [key]: _removed, ...rest } = s;
                  return rest;
                });
              }}
            />
            {failure ? (
              <Alert tone="danger" live>
                {failure}
              </Alert>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void save()} loading={saving} loadingText={t('common.saving')}>
                {t('common.saveChanges')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {schema.steps.map((step) => {
              const shown = step.fields.filter((f) => visible.has(f.key));
              if (!shown.length) return null;
              return (
                <section key={step.key} className="space-y-4">
                  {step.title ? <h3 className="text-md font-semibold text-foreground">{pick(step.title, step.titleAr)}</h3> : null}
                  <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                    {shown.map((field) => {
                      const stored = sourceOf.get(field.key);
                      const text = displayFormValue(field, view.form.values[field.key], i18n, (code) => countryName(code, locale) || code);
                      return (
                        <div key={field.key} className={cn('min-w-0', field.type === 'textarea' && 'sm:col-span-full')}>
                          <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                            <span>{pick(field.label, field.labelAr)}</span>
                            {stored && text ? <SourceBadge source={stored.source} /> : null}
                          </dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-base text-foreground">
                            {text ? <bdi>{text}</bdi> : <span className="text-muted-foreground">{field.required ? t('cases.details.missing') : '–'}</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- money (read side; the forms live in the finance screens)

function FeeBreakdown({ doc, invoice }: { doc: FeeTotals; invoice?: InvoiceRow }) {
  const { t, formatMoney } = useI18n();
  const money = (amount: string) => formatMoney(amount, doc.currency);
  const row = (label: string, amount: string, strong = false, negative = false) => (
    <div className={cn('flex items-baseline justify-between gap-4 py-1.5', strong && 'border-t font-semibold text-foreground')}>
      <dt className={strong ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular whitespace-nowrap">{negative && Number(amount) > 0 ? `− ${money(amount)}` : money(amount)}</dd>
    </div>
  );
  return (
    <dl className="text-base">
      {row(t('cases.money.serviceFee'), doc.subtotalServiceFee)}
      {row(t('cases.money.governmentFee'), doc.subtotalGovernmentFee)}
      {row(t('cases.money.thirdPartyFee'), doc.subtotalThirdParty)}
      {Number(doc.discountTotal) > 0 ? row(t('cases.money.discount'), doc.discountTotal, false, true) : null}
      {row(t('cases.money.tax'), doc.taxTotal)}
      {row(t('cases.money.total'), doc.total, true)}
      {invoice ? (
        <>
          {row(t('cases.money.paid'), invoice.amountPaid)}
          {Number(invoice.amountCredited) > 0 ? row(t('cases.money.credited'), invoice.amountCredited) : null}
          {Number(invoice.amountRefunded) > 0 ? row(t('cases.money.refunded'), invoice.amountRefunded) : null}
          {row(t('cases.money.balance'), invoice.balanceDue, true)}
        </>
      ) : null}
    </dl>
  );
}

export function MoneyTab() {
  const { t, formatMoney, formatDate } = useI18n();
  const { view } = useCaseContext();
  const session = useSession();
  const api = useCasesApi();
  const describe = useCaseError();
  const finance = view.finance;
  const canQuotations = session.hasPermission('quotation.read');
  const canInvoices = session.hasPermission('invoice.read');
  const quotations = useQuery({ queryKey: caseKeys.quotations(view.id), queryFn: () => api.quotations(view.id), enabled: canQuotations });
  const invoices = useQuery({ queryKey: caseKeys.invoices(view.id), queryFn: () => api.invoices(view.id), enabled: canInvoices });
  if (!finance) return null;

  const currency = finance.quotation?.currency ?? finance.invoices[0]?.currency;
  const quotationRows: QuotationRow[] = quotations.data?.data ?? [];
  const invoiceRows: InvoiceRow[] = invoices.data?.data ?? [];
  const nothing = !finance.quotation && finance.invoices.length === 0;
  const newQuotation = `/quotations/new?requestId=${view.id}&customerId=${view.customer.id}`;

  return (
    <div className="space-y-5">
      {finance.totals && !nothing ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {(
            [
              ['invoiced', finance.totals.invoiced],
              ['paid', finance.totals.paid],
              ['refunded', finance.totals.refunded],
              ['balance', finance.totals.balance],
            ] as const
          ).map(([key, amount]) => (
            <div key={key} className={cn('rounded-lg border bg-card p-4', key === 'balance' && Number(amount) > 0 && 'border-warning/40 bg-warning-soft/70')}>
              <p className="text-sm text-muted-foreground">{t(`cases.money.totals.${key}`)}</p>
              <p className="tabular mt-1 text-xl font-semibold text-foreground">{formatMoney(amount, currency)}</p>
            </div>
          ))}
        </div>
      ) : null}

      {nothing ? (
        <Card>
          <EmptyState
            icon={<Receipt />}
            title={t('cases.money.emptyTitle')}
            description={t('cases.money.emptyText')}
            action={
              !isClosed(view.status) && view.status !== 'DRAFT' ? (
                <PermissionGate permission="quotation.manage">
                  <Button asChild>
                    <Link href={newQuotation}>{t('cases.money.newQuotation')}</Link>
                  </Button>
                </PermissionGate>
              ) : undefined
            }
          />
        </Card>
      ) : null}

      {quotations.isError || invoices.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => { void quotations.refetch(); void invoices.refetch(); }}>{t('common.retry')}</Button>}>
          {describe(quotations.error ?? invoices.error)}
        </Alert>
      ) : null}

      {finance.quotation || quotationRows.length ? (
        <Card>
          <CardHeader className="items-center pb-4">
            <CardTitle>{t('cases.money.quotations')}</CardTitle>
            {!isClosed(view.status) ? (
              <PermissionGate permission="quotation.manage">
                <Button asChild variant="outline" size="sm">
                  <Link href={newQuotation}>{t('cases.money.newQuotation')}</Link>
                </Button>
              </PermissionGate>
            ) : null}
          </CardHeader>
          <div className="divide-y border-t">
            {canQuotations && quotations.isPending ? (
              <div className="p-5">
                <Skeleton className="h-32 w-full" />
              </div>
            ) : quotationRows.length ? (
              quotationRows.map((q) => (
                <div key={q.id} className="grid gap-x-8 gap-y-4 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                  <div className="space-y-2">
                    <p className="flex flex-wrap items-center gap-2.5">
                      <Link href={`/quotations/${q.id}`} className="tabular text-md font-semibold text-secondary-text underline-offset-4 hover:underline">
                        {q.quotationNo}
                      </Link>
                      <StatusBadge kind="quotation" status={q.status} />
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {q.sentAt ? t('cases.money.sentOn', { date: formatDate(q.sentAt) }) : t('cases.money.notSent')}
                      {q.validUntil ? ` · ${t('cases.money.validUntil', { date: formatDate(q.validUntil) })}` : ''}
                    </p>
                    <Button asChild variant="subtle" size="sm">
                      <Link href={`/quotations/${q.id}`}>{t('cases.money.openQuotation')}</Link>
                    </Button>
                  </div>
                  <FeeBreakdown doc={q} />
                </div>
              ))
            ) : finance.quotation ? (
              // Without access to the quotation list: the summary the case itself carries.
              <div className="flex flex-wrap items-center justify-between gap-3 p-5">
                <p className="flex flex-wrap items-center gap-2.5">
                  <span className="tabular text-md font-semibold text-foreground">{finance.quotation.quotationNo}</span>
                  <StatusBadge kind="quotation" status={finance.quotation.status} />
                </p>
                <p className="tabular text-md font-semibold text-foreground">{formatMoney(finance.quotation.total, finance.quotation.currency)}</p>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {finance.invoices.length || invoiceRows.length ? (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>{t('cases.money.invoices')}</CardTitle>
          </CardHeader>
          <div className="divide-y border-t">
            {canInvoices && invoices.isPending ? (
              <div className="p-5">
                <Skeleton className="h-32 w-full" />
              </div>
            ) : invoiceRows.length ? (
              invoiceRows.map((inv) => (
                <div key={inv.id} className="grid gap-x-8 gap-y-4 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                  <div className="space-y-2">
                    <p className="flex flex-wrap items-center gap-2.5">
                      <Link href={`/invoices/${inv.id}`} className="tabular text-md font-semibold text-secondary-text underline-offset-4 hover:underline">
                        {inv.invoiceNo}
                      </Link>
                      <StatusBadge kind="invoice" status={inv.status} />
                      {inv.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {inv.issuedAt ? t('cases.money.issuedOn', { date: formatDate(inv.issuedAt) }) : t('cases.money.notIssued')}
                      {inv.dueAt ? ` · ${t('cases.money.dueOn', { date: formatDate(inv.dueAt) })}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="subtle" size="sm">
                        <Link href={`/invoices/${inv.id}`}>{t('cases.money.openInvoice')}</Link>
                      </Button>
                      {Number(inv.balanceDue) > 0 && inv.status !== 'VOID' && inv.status !== 'DRAFT' ? (
                        <PermissionGate permission="payment.record">
                          <Button asChild size="sm">
                            <Link href={`/payments/new?invoiceId=${inv.id}&customerId=${view.customer.id}`}>{t('cases.money.recordPayment')}</Link>
                          </Button>
                        </PermissionGate>
                      ) : null}
                    </div>
                  </div>
                  <FeeBreakdown doc={inv} invoice={inv} />
                </div>
              ))
            ) : (
              finance.invoices.map((inv) => (
                <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
                  <p className="flex flex-wrap items-center gap-2.5">
                    <span className="tabular text-md font-semibold text-foreground">{inv.invoiceNo}</span>
                    <StatusBadge kind="invoice" status={inv.status} />
                  </p>
                  <p className="tabular text-base text-foreground">
                    {t('cases.money.paidOf', { paid: formatMoney(inv.amountPaid, inv.currency), total: formatMoney(inv.total, inv.currency) })}
                  </p>
                </div>
              ))
            )}
          </div>
        </Card>
      ) : null}

      <p className="text-sm text-muted-foreground">{t('cases.money.note')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- assignment and review

function approvalTone(approval: CaseApproval): 'warning' | 'success' | 'danger' | 'neutral' {
  if (approval.superseded) return 'neutral';
  return approval.status === 'PENDING' ? 'warning' : approval.status === 'APPROVED' ? 'success' : approval.status === 'REJECTED' ? 'danger' : 'neutral';
}

export function TeamTab() {
  const { t, has, formatDateTime } = useI18n();
  const { view, open, can, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const describe = useCaseError();
  const [auto, setAuto] = React.useState(false);
  const roleName = (key: string | null) => (key ? (has(`cases.roles.${key}`) ? t(`cases.roles.${key}`) : key) : '');

  const autoAssign = async () => {
    setAuto(true);
    try {
      const next = await api.autoAssign(view.id);
      apply(next);
      toasts.success(t('cases.team.assigned'), next.assignee?.name);
    } catch (error) {
      toasts.error(describe(error));
    } finally {
      setAuto(false);
    }
  };

  const person = (role: 'OPERATOR' | 'REVIEWER') => {
    const current = role === 'OPERATOR' ? view.assignee : view.reviewer;
    const Icon = role === 'OPERATOR' ? UserCog : UserCheck;
    return (
      <Card key={role}>
        <CardContent className="flex flex-wrap items-center gap-4">
          {current ? <Avatar name={current.name} /> : <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-5" /></span>}
          <div className="min-w-0 flex-1 basis-40">
            <p className="text-sm text-muted-foreground">{t(`cases.team.roles.${role}`)}</p>
            <p className="truncate text-md font-semibold text-foreground">{current ? current.name : t(`cases.team.none.${role}`)}</p>
            {current?.roleKey ? <p className="text-sm text-muted-foreground">{roleName(current.roleKey)}</p> : null}
          </div>
          {can('assign') ? (
            <div className="flex flex-wrap gap-2">
              <Button variant={current ? 'outline' : 'default'} size="sm" onClick={() => open({ type: 'assign', role })}>
                {current ? t('cases.team.change') : t(`cases.team.assign.${role}`)}
              </Button>
              {role === 'OPERATOR' && !current && can('auto_assign') ? (
                <Button variant="outline" size="sm" onClick={() => void autoAssign()} loading={auto} loadingText={t('common.loading')}>
                  <Wand2 aria-hidden="true" />
                  {t('cases.team.auto')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  };

  const pending = view.approvals.filter((a) => a.status === 'PENDING' && !a.superseded);
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">{(['OPERATOR', 'REVIEWER'] as const).map(person)}</div>

      <Card>
        <CardHeader className="pb-4">
          <div>
            <CardTitle>{t('cases.approvals.title')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{view.service.requiresApproval ? t('cases.approvals.textRequired') : t('cases.approvals.textOptional')}</p>
          </div>
        </CardHeader>
        {view.approvals.length ? (
          <ul className="divide-y border-t">
            {[...view.approvals].reverse().map((approval) => (
              <li key={approval.id} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4" data-approval={approval.status}>
                <div className="min-w-0 flex-1 basis-64 space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={approvalTone(approval)}>{approval.superseded ? t('cases.approvals.status.SUPERSEDED') : t(`cases.approvals.status.${approval.status}`)}</Badge>
                    <span className="text-sm text-muted-foreground">{formatDateTime(approval.createdAt)}</span>
                  </p>
                  <p className="text-base text-foreground">{approval.requestedByName ? t('cases.approvals.preparedBy', { name: approval.requestedByName }) : t('cases.approvals.preparedUnknown')}</p>
                  {approval.decidedByName ? (
                    <p className="text-sm text-muted-foreground">{t('cases.approvals.decidedBy', { name: approval.decidedByName, time: formatDateTime(approval.decidedAt) })}</p>
                  ) : null}
                  {approval.comment ? (
                    <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground/90">
                      <bdi>{approval.comment}</bdi>
                    </p>
                  ) : null}
                </div>
                {approval.status === 'PENDING' && !approval.superseded && can('decide_approval') ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => open({ type: 'approval', approval, decision: 'APPROVED' })}>
                      {t('cases.approvals.decisions.APPROVED')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => open({ type: 'approval', approval, decision: 'REJECTED' })}>
                      {t('cases.approvals.decisions.REJECTED')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t px-5 py-4 text-sm text-muted-foreground">{t('cases.approvals.empty')}</p>
        )}
        {pending.length && !can('decide_approval') ? <p className="border-t px-5 py-3 text-sm text-muted-foreground">{t('cases.approvals.waitingReviewer')}</p> : null}
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>{t('cases.team.history')}</CardTitle>
        </CardHeader>
        {view.assignments.length ? (
          <Table containerClassName="border-t">
            <TableHeader>
              <TableRow>
                <TableHead>{t('cases.team.columns.role')}</TableHead>
                <TableHead>{t('cases.team.columns.person')}</TableHead>
                <TableHead>{t('cases.team.columns.from')}</TableHead>
                <TableHead>{t('cases.team.columns.until')}</TableHead>
                <TableHead>{t('cases.team.columns.how')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...view.assignments].reverse().map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap">{t(`cases.team.roles.${a.role}`)}</TableCell>
                  <TableCell className="whitespace-nowrap font-medium text-foreground">{a.assigneeName}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">{formatDateTime(a.assignedAt)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">{a.unassignedAt ? formatDateTime(a.unassignedAt) : <Badge tone="success">{t('cases.team.current')}</Badge>}</TableCell>
                  <TableCell className="min-w-48">
                    {a.method === 'AUTO' ? t('cases.team.methodAuto') : t('cases.team.methodManual')}
                    {a.reason ? (
                      <span className="block text-sm text-muted-foreground">
                        <bdi>{a.reason}</bdi>
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="border-t px-5 py-4 text-sm text-muted-foreground">{t('cases.team.historyEmpty')}</p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- external processing

export function ExternalTab() {
  const { t, formatDateTime } = useI18n();
  const { view, open, can } = useCaseContext();
  const permitted = view.service.permittedChannels ?? [];
  const references = [...view.externalReferences].reverse();
  return (
    <div className="space-y-5">
      <Alert tone={permitted.length ? 'info' : 'warning'} title={t(`cases.capability.${view.service.complianceCapability}`)}>
        {t(`cases.external.capabilityText.${view.service.complianceCapability}`)}
      </Alert>

      <Card>
        <CardHeader className="items-center pb-4">
          <div>
            <CardTitle>{t('cases.external.title')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{t('cases.external.text')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {can('record_external_result') && references.some((r) => !r.result) ? (
              <Button variant="outline" size="sm" onClick={() => open({ type: 'externalResult' })}>
                {t('cases.external.resultTitle')}
              </Button>
            ) : null}
            {can('record_submission') ? (
              <Button size="sm" variant={references.length ? 'outline' : 'default'} onClick={() => open({ type: 'submission' })}>
                <Send className="rtl-mirror" aria-hidden="true" />
                {t('cases.external.recordTitle')}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        {references.length ? (
          <ul className="divide-y border-t">
            {references.map((reference) => (
              <li key={reference.id} className="space-y-3 px-5 py-4" data-external-reference={reference.id}>
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2.5">
                      <span className="ltr-value tabular text-md font-semibold text-foreground">{reference.referenceNo}</span>
                      <Badge tone="outline">{t(`cases.external.channels.${reference.channel}`)}</Badge>
                      {reference.result ? <Badge tone={reference.result === 'COMPLETED' ? 'success' : reference.result === 'REJECTED' ? 'danger' : 'warning'}>{t(`cases.external.outcomes.${reference.result}`)}</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {[reference.authorityName, reference.partnerName ? t('cases.external.viaPartner', { name: reference.partnerName }) : null, t('cases.external.recordedOn', { time: formatDateTime(reference.recordedAt) })].filter(Boolean).join(' · ')}
                    </p>
                    {reference.partnerReference ? (
                      <p className="text-sm text-muted-foreground">
                        {t('cases.external.partnerReference')}: <span className="ltr-value tabular">{reference.partnerReference}</span>
                      </p>
                    ) : null}
                  </div>
                  {can('update_external_status') && !reference.result ? (
                    <Button variant="outline" size="sm" onClick={() => open({ type: 'externalStatus', reference })}>
                      {t('cases.external.statusTitle')}
                    </Button>
                  ) : null}
                </div>
                {/* An external status is never shown without where it comes from (spec section 31). */}
                <div className="space-y-1.5 rounded-md border bg-muted/40 px-3 py-2.5">
                  <p className="text-sm text-muted-foreground">{t('cases.external.statusField')}</p>
                  <p className="text-base text-foreground">
                    <bdi>{reference.status ? externalStatusText(reference.status, t) : t('cases.external.noStatus')}</bdi>
                  </p>
                  <SourceLabel source={reference.statusSource} label={reference.statusSourceLabel} />
                </div>
                {reference.notes ? (
                  <p className="text-sm text-foreground/85">
                    <span className="font-medium">{t('cases.external.notes')}:</span> <bdi>{reference.notes}</bdi>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            className="border-t"
            icon={<Building2 />}
            title={t('cases.external.emptyTitle')}
            description={permitted.length ? t('cases.external.emptyText') : t('cases.external.emptyTextNone')}
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- messages

export function MessagesTab() {
  const { t, formatDateTime } = useI18n();
  const { view, apply, can } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const describe = useCaseError();
  const mayInternal = can('comment_internal');
  const mayCustomer = can('comment');
  // Staff write internal notes unless they deliberately switch to "visible to the customer".
  const [toCustomer, setToCustomer] = React.useState(!mayInternal && mayCustomer);
  const [body, setBody] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const switchId = React.useId();
  const fieldId = React.useId();
  const comments = [...view.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const send = async () => {
    const text = body.trim();
    if (!text) {
      setError(t('validation.required'));
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api.addComment(view.id, { body: text, visibility: toCustomer ? 'CUSTOMER' : 'INTERNAL' });
      toasts.success(toCustomer ? t('cases.messages.sent') : t('cases.messages.noteAdded'));
      setBody('');
      // Back to the safe default: the next text is an internal note unless the switch is turned on again.
      if (mayInternal) setToCustomer(false);
      apply();
    } catch (e) {
      setError(describe(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader className="pb-4">
          <div>
            <CardTitle>{t('cases.messages.title')}</CardTitle>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2.5 rounded-full bg-warning" />
                {t('cases.messages.legendInternal')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2.5 rounded-full bg-info" />
                {t('cases.messages.legendCustomer')}
              </span>
            </p>
          </div>
        </CardHeader>
        {comments.length ? (
          <ol className="space-y-3 border-t p-5">
            {comments.map((comment) => {
              const internal = comment.visibility === 'INTERNAL';
              const fromCustomer = comment.authorType !== 'STAFF' && comment.authorType !== 'SYSTEM';
              return (
                <li
                  key={comment.id}
                  data-visibility={comment.visibility}
                  className={cn('max-w-[min(100%,42rem)] rounded-lg border p-3.5', internal ? 'border-warning/40 bg-warning-soft' : 'border-info/25 bg-info-soft', fromCustomer && 'ms-auto')}
                >
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <Badge tone={internal ? 'warning' : 'info'} icon={internal ? <Lock /> : <Eye />}>
                      {internal ? t('cases.messages.internal') : fromCustomer ? t('cases.messages.fromCustomer') : t('cases.messages.toCustomer')}
                    </Badge>
                    <span className="font-medium text-foreground">{comment.authorName ?? t('cases.messages.unknownAuthor')}</span>
                    <span className="text-muted-foreground">{formatDateTime(comment.createdAt)}</span>
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-base text-foreground" dir="auto">
                    {comment.body}
                  </p>
                </li>
              );
            })}
          </ol>
        ) : (
          <EmptyState className="border-t" icon={<MessageSquare />} title={t('cases.messages.emptyTitle')} description={t('cases.messages.emptyText')} />
        )}
      </Card>

      {mayInternal || mayCustomer ? (
        <Card className={cn('self-start', toCustomer ? 'border-info/40' : 'border-warning/50')}>
          <CardHeader className="pb-4">
            <CardTitle>{toCustomer ? t('cases.messages.composeCustomer') : t('cases.messages.composeInternal')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 border-t">
            {mayInternal && mayCustomer ? (
              <ChoiceLabel
                htmlFor={switchId}
                control={<Switch id={switchId} checked={toCustomer} onCheckedChange={setToCustomer} />}
                label={t('cases.messages.visibleSwitch')}
                description={toCustomer ? t('cases.messages.visibleOn') : t('cases.messages.visibleOff')}
              />
            ) : (
              <Alert tone={toCustomer ? 'info' : 'warning'}>{toCustomer ? t('cases.messages.visibleOn') : t('cases.messages.visibleOff')}</Alert>
            )}
            <div className="space-y-1.5">
              <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
                {toCustomer ? t('cases.messages.fieldCustomer') : t('cases.messages.fieldInternal')}
              </label>
              <Textarea
                id={fieldId}
                rows={4}
                dir="auto"
                maxLength={4000}
                value={body}
                aria-invalid={!!error}
                onChange={(e) => {
                  setBody(e.target.value);
                  setError(null);
                }}
              />
              {error ? (
                <p role="alert" className="text-sm text-destructive-text">
                  {error}
                </p>
              ) : null}
            </div>
            <Button className="w-full sm:w-auto" variant={toCustomer ? 'secondary' : 'default'} onClick={() => void send()} loading={sending} loadingText={t('common.saving')}>
              {toCustomer ? <Send className="rtl-mirror" aria-hidden="true" /> : <Lock aria-hidden="true" />}
              {toCustomer ? t('cases.messages.send') : t('cases.messages.addNote')}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- history

export function HistoryTab() {
  const { t, pick, formatDateTime, formatMoney, has } = useI18n();
  const { view } = useCaseContext();
  const entries = [...view.history].reverse();
  const actor = (type: string, name: string | null) => {
    const kind = has(`cases.history.actors.${type}`) ? t(`cases.history.actors.${type}`) : type;
    return name ? `${name} (${kind})` : kind;
  };
  // The API stores the standard customer wording of a status in English: show it in the reader's language.
  const customerWording = (status: keyof typeof REQUEST_STATUS_META, message: string) => {
    const standard = REQUEST_STATUS_META[status];
    return standard && message === standard.customerEn ? pick(standard.customerEn, standard.customerAr) : message;
  };
  const items: TimelineItem[] = entries.map((entry, index) => {
    const meta = entry.meta ?? {};
    const informational = entry.from === entry.to;
    return {
      id: entry.id,
      state: index === 0 ? 'current' : 'done',
      tone: entry.to === 'CANCELLED' || entry.to === 'REJECTED' ? 'danger' : entry.to === 'AWAITING_CUSTOMER' || entry.to === 'RETURNED' ? 'warning' : undefined,
      title: (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{informational ? t('cases.history.note') : pick(entry.toLabel.en, entry.toLabel.ar)}</span>
          {entry.customerVisible ? (
            <Badge tone="info" icon={<Eye />}>
              {t('cases.history.customerVisible')}
            </Badge>
          ) : (
            <Badge tone="neutral" icon={<Lock />}>
              {t('cases.history.internalOnly')}
            </Badge>
          )}
        </span>
      ),
      time: `${formatDateTime(entry.at)} · ${actor(entry.actorType, entry.actorName)}`,
      description:
        entry.reason || (entry.customerVisible && entry.customerMessage) || meta.refundReviewNeeded ? (
          <div className="space-y-1">
            {entry.reason ? (
              <p>
                <span className="font-medium">{t('cases.history.reason')}</span> <bdi>{entry.reason}</bdi>
              </p>
            ) : null}
            {entry.customerVisible && entry.customerMessage ? (
              <p className="text-muted-foreground">
                <span className="font-medium">{t('cases.history.customerMessage')}</span> <bdi>{customerWording(entry.to, entry.customerMessage)}</bdi>
              </p>
            ) : null}
            {meta.refundReviewNeeded ? (
              <p className="text-warning-text">{t('cases.history.refundReview', { amount: formatMoney(typeof meta.amountHeld === 'string' || typeof meta.amountHeld === 'number' ? meta.amountHeld : null) })}</p>
            ) : null}
          </div>
        ) : undefined,
    };
  });
  return (
    <Card>
      <CardHeader className="items-center pb-4">
        <div>
          <CardTitle>{t('cases.history.title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('cases.history.text')}</p>
        </div>
        <PermissionGate permission="audit.read">
          <Button asChild variant="outline" size="sm">
            <Link href={`/audit-log?resourceType=ServiceRequest&resourceId=${view.id}`}>
              <ScrollText aria-hidden="true" />
              {t('cases.history.audit')}
            </Link>
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent className="border-t">{items.length ? <Timeline items={items} /> : <p className="text-sm text-muted-foreground">{t('cases.history.empty')}</p>}</CardContent>
    </Card>
  );
}

