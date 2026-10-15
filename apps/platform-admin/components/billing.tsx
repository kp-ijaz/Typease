'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { CalendarPlus, Download, FileX2, HandCoins, Repeat2, TicketPercent } from 'lucide-react';
import { saveBlob } from '@typease/api-client';
import { applyCouponSchema, offlineSubscriptionPaymentSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Checkbox, ChoiceLabel, DatePicker, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError,
  FormField, Input, Label, STATUS_META, Select, StatusBadge, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Timeline, useApiClient, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { BillingCycle, BillingHistory, CouponRef, PlanChangeResult, SubscriptionEvent, SubscriptionInvoice, SubscriptionStatus } from '@/lib/types';
import { ConfirmReasonDialog, LoadError, Money, RowsSkeleton, Section } from './shared';

/** What the billing dialogs need to know about a centre's subscription. */
export interface BillingSubject {
  tenantId: string;
  tenantName: string;
  planKey?: string;
  planName?: string;
  cycle?: BillingCycle;
  status?: SubscriptionStatus;
  trialEndsAt?: string | null;
}

/** Refreshes everything a billing change touches: the subscription, the centre (its status follows billing) and the figures. */
export function useBillingRefresh() {
  const queryClient = useQueryClient();
  return React.useCallback(() => Promise.all([keys.billing.all, keys.tenants.all, keys.dashboard.all, keys.coupons.all].map((queryKey) => queryClient.invalidateQueries({ queryKey }))), [queryClient]);
}

/** "20% off" or "AED 50.00 off": the discount of a coupon. */
export function CouponDiscount({ coupon }: { coupon: Pick<CouponRef, 'percentOff' | 'amountOff' | 'currency'> }) {
  const { t, formatNumber, formatMoney } = useI18n();
  if (coupon.percentOff) return <span className="tabular">{t('billing.coupon.percentOff', { percent: formatNumber(coupon.percentOff, { maximumFractionDigits: 2 }) })}</span>;
  if (coupon.amountOff) return <span className="tabular">{t('billing.coupon.amountOff', { amount: formatMoney(coupon.amountOff, coupon.currency) })}</span>;
  return null;
}

// ---------------------------------------------------------------- change plan

const KEEP = '__keep__';

/** Moves a centre to another plan or billing cycle (POST /platform/billing/tenants/:id/change-plan). */
export function ChangePlanDialog({ subject, open, onOpenChange }: { subject: BillingSubject | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, formatMoney } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const refresh = useBillingRefresh();
  const plans = useQuery({ queryKey: keys.plans.admin, queryFn: ({ signal }) => api.plans.list(signal), enabled: open, staleTime: 60_000 });
  const [planKey, setPlanKey] = React.useState('');
  const [cycle, setCycle] = React.useState<string>(KEEP);
  const [immediate, setImmediate] = React.useState(false);
  const id = React.useId();
  React.useEffect(() => {
    if (open) {
      setPlanKey('');
      setCycle(KEEP);
      setImmediate(false);
    }
  }, [open]);

  const options = [...(plans.data ?? [])]
    .filter((plan) => plan.isActive || plan.key === subject?.planKey)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((plan) => ({
      value: plan.key,
      label: (
        <>
          {plan.name} · <span className="tabular">{formatMoney(plan.monthlyPrice, plan.currency)}</span>
          {plan.isPublic ? '' : ` · ${t('billing.change.private')}`}
          {plan.key === subject?.planKey ? ` · ${t('billing.change.current')}` : ''}
        </>
      ),
    }));

  const announce = (result: PlanChangeResult) => {
    const { kind, effective, amount } = result.change;
    const currency = result.subscription?.plan.currency;
    if (kind === 'WITHDRAWN') return toasts.success(t('billing.change.withdrawn'));
    if (effective === 'NOW') return toasts.success(t('billing.change.doneNow'));
    if (effective === 'AFTER_PAYMENT') return toasts.success(t('billing.change.doneAfterPayment'), amount ? t('billing.change.invoiceIssued', { amount: formatMoney(amount, currency) }) : undefined);
    return toasts.success(t('billing.change.donePeriodEnd'));
  };

  return (
    <ConfirmReasonDialog
      open={open && !!subject}
      onOpenChange={onOpenChange}
      tone="default"
      title={t('billing.change.title', { name: subject?.tenantName ?? '' })}
      description={subject?.planName ? t('billing.change.text', { plan: subject.planName, cycle: t(`pc.cycle.${subject.cycle ?? 'MONTHLY'}`) }) : t('billing.change.textNoPlan')}
      confirmLabel={t('billing.change.action')}
      label={t('pc.reason')}
      hint={t('billing.reasonHint')}
      minLength={3}
      maxLength={300}
      onConfirm={async (reason) => {
        if (!planKey) throw new Error(t('billing.change.choosePlan'));
        const result = await api.billing.changePlan(subject!.tenantId, { planKey, billingCycle: cycle === KEEP ? undefined : cycle, immediate, reason });
        await refresh();
        announce(result);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-plan`} required>
          {t('billing.change.newPlan')}
        </Label>
        <Select id={`${id}-plan`} value={planKey} onValueChange={setPlanKey} options={options} placeholder={plans.isPending ? t('common.loading') : t('common.selectPlaceholder')} disabled={plans.isPending} />
        {plans.isError ? <LoadError error={plans.error} onRetry={() => void plans.refetch()} /> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-cycle`}>{t('billing.columns.cycle')}</Label>
        <Select
          id={`${id}-cycle`}
          value={cycle}
          onValueChange={setCycle}
          options={[
            { value: KEEP, label: t('billing.change.keepCycle') },
            { value: 'MONTHLY', label: t('pc.cycle.MONTHLY') },
            { value: 'ANNUAL', label: t('pc.cycle.ANNUAL') },
          ]}
        />
      </div>
      <ChoiceLabel
        htmlFor={`${id}-now`}
        control={<Checkbox id={`${id}-now`} checked={immediate} onCheckedChange={(checked) => setImmediate(checked === true)} />}
        label={t('billing.change.immediate')}
        description={t('billing.change.immediateText')}
      />
    </ConfirmReasonDialog>
  );
}

// ---------------------------------------------------------------- extend trial

/** Gives a centre more trial time (POST /platform/billing/tenants/:id/extend-trial). */
export function ExtendTrialDialog({ subject, open, onOpenChange }: { subject: BillingSubject | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, formatDate } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const refresh = useBillingRefresh();
  const [days, setDays] = React.useState('7');
  const id = React.useId();
  React.useEffect(() => {
    if (open) setDays('7');
  }, [open]);
  return (
    <ConfirmReasonDialog
      open={open && !!subject}
      onOpenChange={onOpenChange}
      tone="default"
      title={t('billing.trial.title', { name: subject?.tenantName ?? '' })}
      description={subject?.status === 'TRIALING' && subject.trialEndsAt ? t('billing.trial.text', { date: formatDate(subject.trialEndsAt) }) : t('billing.trial.textEnded')}
      confirmLabel={t('billing.trial.action')}
      label={t('pc.reason')}
      hint={t('billing.reasonHint')}
      minLength={3}
      maxLength={300}
      onConfirm={async (reason) => {
        const count = Number(days);
        if (!Number.isInteger(count) || count < 1 || count > 180) throw new Error(t('billing.trial.daysInvalid'));
        const result = await api.billing.extendTrial(subject!.tenantId, { days: count, reason });
        await refresh();
        toasts.success(tn('billing.trial.done', count), result.subscription?.trialEndsAt ? t('billing.trial.doneText', { date: formatDate(result.subscription.trialEndsAt) }) : undefined);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-days`} required>
          {t('billing.trial.days')}
        </Label>
        <Input id={`${id}-days`} type="number" inputMode="numeric" dir="ltr" min={1} max={180} step={1} value={days} onChange={(e) => setDays(e.target.value)} className="tabular w-32" />
        <p className="text-sm text-muted-foreground">{t('billing.trial.daysHint')}</p>
      </div>
    </ConfirmReasonDialog>
  );
}

// ---------------------------------------------------------------- coupon

/** Applies a coupon to a centre's subscription (POST /platform/billing/tenants/:id/coupon). */
export function ApplyCouponDialog({ subject, open, onOpenChange }: { subject: BillingSubject | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const refresh = useBillingRefresh();
  const form = useZodForm(applyCouponSchema, { defaultValues: { code: '' } });
  React.useEffect(() => {
    if (open) form.reset({ code: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open && !!subject} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.billing.applyCoupon(subject!.tenantId, values);
            await refresh();
            toasts.success(t('billing.coupon.applied', { code: values.code }));
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('billing.coupon.title', { name: subject?.tenantName ?? '' })}</DialogTitle>
            <DialogDescription>{t('billing.coupon.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="code" label={t('billing.coupon.code')} required>
              {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('billing.coupon.action')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- invoices

const paymentSchema = offlineSubscriptionPaymentSchema.omit({ paidAt: true }).extend({ paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** Records a bank transfer, cheque or cash payment for an open subscription invoice. Same consequences as an online payment. */
function PayOfflineDialog({ invoice, tenantName, onClose }: { invoice: SubscriptionInvoice | null; tenantName: string; onClose: () => void }) {
  const { t, today, formatMoney } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const refresh = useBillingRefresh();
  const form = useZodForm(paymentSchema, { defaultValues: { method: 'BANK_TRANSFER', reference: '', paidOn: '' } });
  React.useEffect(() => {
    if (invoice) form.reset({ method: 'BANK_TRANSFER', reference: '', paidOn: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id]);
  return (
    <Dialog open={!!invoice} onOpenChange={(next) => !next && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async ({ paidOn, ...values }) => {
            // An earlier day is sent as noon in Dubai; today (or nothing) lets the API use the moment of recording.
            await api.billing.payOffline(invoice!.id, { ...values, paidAt: paidOn && paidOn < today() ? `${paidOn}T12:00:00+04:00` : undefined });
            await refresh();
            toasts.success(t('billing.pay.done', { number: invoice!.number }));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('billing.pay.title', { number: invoice?.number ?? '' })}</DialogTitle>
            <DialogDescription>{t('billing.pay.text', { amount: formatMoney(invoice?.total, invoice?.currency), name: tenantName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="method" label={t('billing.pay.method')} required>
                {(field) => <Select {...field} onValueChange={field.onChange} options={(['BANK_TRANSFER', 'CHEQUE', 'CASH'] as const).map((m) => ({ value: m, label: t(`billing.pay.methods.${m}`) }))} />}
              </FormField>
              <FormField name="paidOn" label={t('billing.pay.paidOn')} optional hint={t('billing.pay.paidOnHint')}>
                {(field) => <DatePicker {...field} max={today()} />}
              </FormField>
            </div>
            <FormField name="reference" label={t('billing.pay.reference')} required hint={t('billing.pay.referenceHint')}>
              {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
            </FormField>
            <Alert tone="info">{t('billing.pay.consequence')}</Alert>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('billing.pay.action')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- panel

const EVENT_FIELDS = ['number', 'total', 'planKey', 'pendingPlan', 'from', 'to', 'days', 'code', 'method', 'reference', 'reason', 'error'] as const;

/**
 * SaaS billing of one centre: subscription, invoices and the history of billing events
 * (GET /platform/billing/tenants/:id), with the actions billing staff may take. This is the
 * money between the centre and TypEase, never the centre's own customer payments.
 */
export function BillingPanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const { t, pick, has, formatDate, formatDateTime, formatMoney } = useI18n();
  const api = usePlatformApi();
  const client = useApiClient();
  const toasts = useToast();
  const refresh = useBillingRefresh();
  const history = useQuery({ queryKey: keys.billing.history(tenantId), queryFn: ({ signal }) => api.billing.history(tenantId, signal) });
  // Only for wording: the history stores plan keys, people read plan names.
  const plans = useQuery({ queryKey: keys.plans.admin, queryFn: ({ signal }) => api.plans.list(signal), staleTime: 60_000 });
  const planName = (key: string) => (plans.data ?? []).find((plan) => plan.key === key)?.name;
  const [dialog, setDialog] = React.useState<'plan' | 'trial' | 'coupon' | null>(null);
  const [paying, setPaying] = React.useState<SubscriptionInvoice | null>(null);
  const [voiding, setVoiding] = React.useState<SubscriptionInvoice | null>(null);
  const [downloading, setDownloading] = React.useState<string | null>(null);
  const [allEvents, setAllEvents] = React.useState(false);

  if (history.isPending) return <Section title={t('billing.subscription')} flush><RowsSkeleton rows={5} /></Section>;
  if (history.isError) return <LoadError lead={t('billing.loadError')} error={history.error} onRetry={() => void history.refetch()} />;

  const { subscription: sub, invoices, events } = history.data as BillingHistory;
  const everPaid = invoices.some((invoice) => invoice.status === 'PAID' && Number(invoice.total) > 0);
  const canExtend = !!sub && (sub.status === 'TRIALING' || (!everPaid && !!sub.trialEndsAt && ['PAST_DUE', 'GRACE', 'EXPIRED'].includes(sub.status)));
  const canChange = !!sub && (sub.status === 'TRIALING' || sub.status === 'ACTIVE');
  const subject: BillingSubject = { tenantId, tenantName, planKey: sub?.plan.key, planName: sub?.plan.name, cycle: sub?.billingCycle, status: sub?.status, trialEndsAt: sub?.trialEndsAt };

  const pdf = async (invoice: SubscriptionInvoice) => {
    setDownloading(invoice.id);
    try {
      saveBlob(await client.download(api.billing.invoicePdfPath(tenantId, invoice.id), { fallbackFilename: `${invoice.number}.pdf` }));
    } catch (error) {
      toasts.error(error);
    } finally {
      setDownloading(null);
    }
  };

  const eventDetail = (event: SubscriptionEvent) => {
    const data = event.data ?? {};
    const parts: string[] = [];
    for (const field of EVENT_FIELDS) {
      const value = data[field];
      if (value === null || value === undefined || value === '' || typeof value === 'object') continue;
      const text = String(value);
      // Codes the API stores are shown in words where the console knows them; everything else as recorded.
      const shown =
        field === 'total'
          ? formatMoney(text, sub?.plan.currency)
          : field === 'reason' && has(`billing.invoices.reasons.${text}`)
            ? t(`billing.invoices.reasons.${text}`)
            : (field === 'from' || field === 'to') && text in STATUS_META.subscription
              ? pick(STATUS_META.subscription[text as SubscriptionStatus].en, STATUS_META.subscription[text as SubscriptionStatus].ar)
              : field === 'method'
                ? paymentMethodLabel(text, t, has)
                : (field === 'planKey' || field === 'pendingPlan' || field === 'from' || field === 'to') && planName(text)
                  ? (planName(text) as string)
                  : text;
      parts.push(`${t(`billing.eventFields.${field}`)}: ${shown}`);
    }
    return parts.length ? <span dir="auto">{parts.join(' · ')}</span> : undefined;
  };
  const shownEvents = allEvents ? events : events.slice(0, 10);

  return (
    <div className="space-y-6">
      <Section
        title={t('billing.subscription')}
        action={
          sub ? (
            <div className="flex flex-wrap gap-2">
              {canChange ? (
                <Button size="sm" variant="outline" onClick={() => setDialog('plan')}>
                  <Repeat2 aria-hidden="true" />
                  {t('billing.change.action')}
                </Button>
              ) : null}
              {canExtend ? (
                <Button size="sm" variant="outline" onClick={() => setDialog('trial')}>
                  <CalendarPlus aria-hidden="true" />
                  {t('billing.trial.action')}
                </Button>
              ) : null}
              {!sub.coupon && sub.status !== 'CANCELLED' && sub.status !== 'EXPIRED' ? (
                <Button size="sm" variant="outline" onClick={() => setDialog('coupon')}>
                  <TicketPercent aria-hidden="true" />
                  {t('billing.coupon.action')}
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {sub ? (
          <>
            <DescriptionList
              columns={3}
              className="mt-4"
              items={[
                { label: t('billing.columns.plan'), value: sub.plan.name },
                { label: t('pc.status'), value: <StatusBadge kind="subscription" status={sub.status} /> },
                {
                  label: t('billing.price'),
                  value: (
                    <>
                      <Money amount={sub.billingCycle === 'ANNUAL' ? sub.plan.annualPrice : sub.plan.monthlyPrice} currency={sub.plan.currency} /> · {t(`pc.cycle.${sub.billingCycle}`)}
                    </>
                  ),
                },
                { label: t('billing.period'), value: sub.currentPeriodStart && sub.currentPeriodEnd ? <span className="tabular">{`${formatDate(sub.currentPeriodStart)} – ${formatDate(sub.currentPeriodEnd)}`}</span> : null },
                { label: t('billing.trialEnds'), value: sub.status === 'TRIALING' && sub.trialEndsAt ? <span className="tabular">{formatDate(sub.trialEndsAt)}</span> : null },
                { label: t('billing.graceEnds'), value: sub.graceEndsAt ? <span className="tabular">{formatDate(sub.graceEndsAt)}</span> : null },
                {
                  label: t('billing.columns.coupon'),
                  value: sub.coupon ? (
                    <>
                      <span className="ltr-value tabular font-medium">{sub.coupon.code}</span> · <CouponDiscount coupon={{ ...sub.coupon, currency: sub.plan.currency }} />
                      {sub.couponEndsAt ? <span className="block text-sm text-muted-foreground">{t('billing.coupon.until', { date: formatDate(sub.couponEndsAt) })}</span> : null}
                    </>
                  ) : null,
                },
                {
                  label: t('billing.pending'),
                  value:
                    sub.pendingPlan || sub.pendingCycle ? (
                      <>
                        {sub.pendingPlan?.name ?? sub.plan.name}
                        {sub.pendingCycle ? ` · ${t(`pc.cycle.${sub.pendingCycle}`)}` : ''}
                      </>
                    ) : null,
                },
                {
                  label: t('billing.cancellation'),
                  value: sub.cancelledAt ? (
                    <>
                      <span className="tabular">{formatDate(sub.cancelledAt)}</span>
                      {sub.cancellationReason ? (
                        <span className="block text-sm text-muted-foreground" dir="auto">
                          {sub.cancellationReason}
                        </span>
                      ) : null}
                    </>
                  ) : sub.cancelAtPeriodEnd ? (
                    <Badge tone="warning">{t('billing.cancelAtPeriodEnd')}</Badge>
                  ) : null,
                },
              ]}
            />
            {!canChange ? <p className="mt-4 text-sm text-muted-foreground">{t(`billing.noChange.${sub.status === 'PAST_DUE' || sub.status === 'GRACE' ? 'unpaid' : 'ended'}`)}</p> : null}
          </>
        ) : (
          <EmptyState icon={<Repeat2 />} title={t('billing.noSubscription')} description={t('billing.noSubscriptionText')} />
        )}
      </Section>

      <Section title={t('billing.invoices.title')} description={t('billing.invoices.text')} flush>
        {invoices.length ? (
          <Table>
            <TableCaption className="sr-only">{t('billing.invoices.title')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('billing.invoices.number')}</TableHead>
                <TableHead>{t('billing.invoices.for')}</TableHead>
                <TableHead>{t('pc.status')}</TableHead>
                <TableHead className="text-end">{t('billing.invoices.total')}</TableHead>
                <TableHead>{t('billing.invoices.due')}</TableHead>
                <TableHead>{t('billing.invoices.paid')}</TableHead>
                {/* "relative" keeps the visually hidden label inside the scrolling table: without it the label widens the page on a phone. */}
                <TableHead className="relative">
                  <span className="sr-only">{t('common.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="tabular ltr-value whitespace-nowrap font-medium">{invoice.number}</TableCell>
                  <TableCell className="min-w-44">
                    {has(`billing.invoices.reasons.${invoice.reason}`) ? t(`billing.invoices.reasons.${invoice.reason}`) : invoice.reason}
                    {invoice.periodStart && invoice.periodEnd ? <span className="tabular block text-sm text-muted-foreground">{`${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`}</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="subscriptionInvoice" status={invoice.status} />
                    {invoice.status === 'OPEN' && invoice.attemptCount > 0 ? (
                      <span className="mt-1 block text-xs text-destructive-text" dir="auto">
                        {t('billing.invoices.attempts', { count: invoice.attemptCount })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-end">
                    <Money amount={invoice.total} currency={invoice.currency} className="font-medium" />
                    {Number(invoice.discount) > 0 ? (
                      <span className="block text-sm text-muted-foreground">
                        {t('billing.invoices.discount')} <Money amount={invoice.discount} currency={invoice.currency} />
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap">{formatDate(invoice.dueAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {invoice.paidAt ? (
                      <>
                        <span className="tabular">{formatDate(invoice.paidAt)}</span>
                        {invoice.paymentMethod ? <span className="block text-sm text-muted-foreground">{paymentMethodLabel(invoice.paymentMethod, t, has)}</span> : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="flex justify-end gap-1.5">
                      {invoice.status === 'OPEN' ? (
                        <>
                          <Button size="sm" variant="subtle" onClick={() => setPaying(invoice)}>
                            <HandCoins aria-hidden="true" />
                            {t('billing.pay.action')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setVoiding(invoice)}>
                            <FileX2 aria-hidden="true" />
                            {t('billing.void.action')}
                          </Button>
                        </>
                      ) : null}
                      <Button size="icon-sm" variant="ghost" aria-label={t('billing.invoices.pdf', { number: invoice.number })} title={t('billing.invoices.pdf', { number: invoice.number })} loading={downloading === invoice.id} onClick={() => void pdf(invoice)}>
                        <Download aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title={t('billing.invoices.empty')} description={t('billing.invoices.emptyText')} />
        )}
      </Section>

      <Section title={t('billing.events.title')} description={t('billing.events.text')}>
        {events.length ? (
          <>
            <Timeline
              className="mt-4"
              items={shownEvents.map((event) => ({
                id: event.id,
                title: has(`billing.events.types.${event.type}`) ? t(`billing.events.types.${event.type}`) : event.type,
                time: formatDateTime(event.createdAt),
                description: eventDetail(event),
                tone: /FAILED|SUSPENDED/.test(event.type) ? 'danger' : /CANCEL|VOIDED|(^|_)ENDED$/.test(event.type) ? 'warning' : undefined,
              }))}
            />
            {events.length > shownEvents.length ? (
              <Button variant="link" className="mt-4" onClick={() => setAllEvents(true)}>
                {t('billing.events.showAll', { count: events.length })}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">{t('billing.events.empty')}</p>
        )}
      </Section>

      <ChangePlanDialog subject={subject} open={dialog === 'plan'} onOpenChange={(open) => !open && setDialog(null)} />
      <ExtendTrialDialog subject={subject} open={dialog === 'trial'} onOpenChange={(open) => !open && setDialog(null)} />
      <ApplyCouponDialog subject={subject} open={dialog === 'coupon'} onOpenChange={(open) => !open && setDialog(null)} />
      <PayOfflineDialog invoice={paying} tenantName={tenantName} onClose={() => setPaying(null)} />
      <ConfirmReasonDialog
        open={!!voiding}
        onOpenChange={(open) => !open && setVoiding(null)}
        title={t('billing.void.title', { number: voiding?.number ?? '' })}
        description={t('billing.void.text')}
        confirmLabel={t('billing.void.action')}
        label={t('pc.reason')}
        hint={t('billing.reasonHint')}
        minLength={3}
        maxLength={300}
        onConfirm={async (reason) => {
          await api.billing.voidInvoice(voiding!.id, { reason });
          await refresh();
          toasts.success(t('billing.void.done', { number: voiding!.number }));
        }}
      />
    </div>
  );
}

/** "ONLINE:sandbox" -> "Online (sandbox)", "BANK_TRANSFER" -> "Bank transfer". */
export function paymentMethodLabel(method: string, t: (key: string, vars?: Record<string, string>) => string, has: (key: string) => boolean): string {
  const [kind, detail] = method.split(':');
  const label = has(`billing.pay.methods.${kind}`) ? t(`billing.pay.methods.${kind}`) : kind;
  return detail ? `${label} (${detail})` : label;
}
