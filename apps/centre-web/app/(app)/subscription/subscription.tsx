'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CreditCard, FileDown, Minus, ReceiptText, TicketPercent } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import type { PublicPlan } from '@typease/api-client';
import { PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS, type BillingCycle } from '@typease/types';
import { applyCouponSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, ConfirmDialog, DataTable, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form,
  FormError, FormField, Input, PageHeader, RequirePermission, Skeleton, StatusBadge, cn, compareMoney, useApi, useApiClient, useI18n, useToast, useZodForm, type DataTableColumn,
  type RowAction,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { LoadError, Money, ReasonDialog, Section, useDownload } from '@/components/fin/shared';
import type { SubscriptionCheckout, SubscriptionInvoiceRow, SubscriptionOpenInvoice, SubscriptionView } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

/**
 * The centre's own TypEase subscription (spec section 9). Everything on this page uses
 * endpoints that stay available while the centre is suspended for non-payment, so the
 * owner can always see what is owed and pay it.
 */
export function SubscriptionPage() {
  return (
    <RequirePermission anyOf={['subscription.manage']}>
      <SubscriptionInner />
    </RequirePermission>
  );
}

type PlanChange = { plan: PublicPlan; cycle: BillingCycle; kind: 'upgrade' | 'downgrade' | 'cycle' | 'restart' };
type Blocked = { plan: string; exceeded: Array<{ metric: string; used: number; limit: number }> };

const priceOf = (plan: { monthlyPrice: string; annualPrice: string }, cycle: BillingCycle) => (cycle === 'ANNUAL' ? plan.annualPrice : plan.monthlyPrice);

function SubscriptionInner() {
  const { t, formatDate, formatMoney } = useI18n();
  const api = useFinApi();
  const publicApi = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();

  const current = useQuery({ queryKey: finKeys.subscription.current, queryFn: ({ signal }) => api.subscription.get(signal) });
  const plans = useQuery({ queryKey: finKeys.subscription.plans, queryFn: () => publicApi.public.plans(), staleTime: 10 * 60_000 });

  const [viewCycle, setViewCycle] = React.useState<BillingCycle | null>(null);
  const [change, setChange] = React.useState<PlanChange | null>(null);
  const [blocked, setBlocked] = React.useState<Blocked | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [checkout, setCheckout] = React.useState<{ invoice: Pick<SubscriptionOpenInvoice, 'id' | 'number' | 'total' | 'currency'>; session?: SubscriptionCheckout; missing?: boolean } | null>(null);
  const [paying, setPaying] = React.useState<string | null>(null);
  const [returned, setReturned] = React.useState<string | null>(null);

  // Back from the payment provider: /subscription?invoice=...&result=success|cancelled|failed
  React.useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('result');
    if (result) {
      setReturned(result);
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: finKeys.subscription.all });
  };

  const pay = async (invoice: Pick<SubscriptionOpenInvoice, 'id' | 'number' | 'total' | 'currency'>) => {
    setPaying(invoice.id);
    try {
      setCheckout({ invoice, session: await api.subscription.pay(invoice.id) });
    } catch (error) {
      if (isApiError(error) && error.code === 'INTEGRATION_NOT_CONFIGURED') setCheckout({ invoice, missing: true });
      else toasts.error(error);
    } finally {
      setPaying(null);
    }
  };

  if (current.isPending) {
    return (
      <div className="space-y-6" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (current.isError) {
    return (
      <>
        <PageHeader title={t('fin.subscription.title')} description={t('fin.subscription.description')} />
        <LoadError error={current.error} onRetry={() => void current.refetch()} />
      </>
    );
  }

  const view = current.data;
  const sub = view.subscription;
  const plan = view.plan;
  const cycle: BillingCycle = viewCycle ?? sub?.billingCycle ?? 'MONTHLY';
  const ended = !sub || sub.status === 'CANCELLED' || sub.status === 'EXPIRED';
  const suspended = view.suspendedForNonPayment || view.tenantStatus === 'SUSPENDED';
  const firstOpen = view.openInvoices[0] ?? null;

  const choose = (target: PublicPlan) => {
    setBlocked(null);
    if (ended) return setChange({ plan: target, cycle, kind: 'restart' });
    if (plan && target.key === plan.key) return setChange({ plan: target, cycle, kind: 'cycle' });
    // The API classifies a change by the price at the CURRENT billing cycle.
    const currentCycle = sub?.billingCycle ?? 'MONTHLY';
    const higher = plan ? compareMoney(priceOf(target, currentCycle), priceOf(plan, currentCycle)) > 0 : true;
    setChange({ plan: target, cycle, kind: higher ? 'upgrade' : 'downgrade' });
  };

  const confirmChange = async () => {
    if (!change) return;
    try {
      if (change.kind === 'restart') {
        const started = await api.subscription.restart({ planKey: change.plan.key, billingCycle: change.cycle });
        toasts.success(t('fin.subscription.change.restarted', { plan: change.plan.name }));
        queryClient.setQueryData(finKeys.subscription.current, started);
      } else {
        const result = await api.subscription.changePlan({ planKey: change.plan.key, ...(change.cycle !== sub?.billingCycle ? { billingCycle: change.cycle } : {}) });
        queryClient.setQueryData(finKeys.subscription.current, result);
        const kind = result.change.kind;
        if (kind === 'UPGRADE' && result.change.amount && Number(result.change.amount) > 0) {
          // The invoice appears under "Invoices to pay" and the pending change in the plan card: one place each.
          toasts.success(t('fin.subscription.change.upgradeQuoted', { plan: change.plan.name }), t('fin.subscription.change.upgradeQuotedText', { amount: formatMoney(result.change.amount, change.plan.currency) }));
        }
        else if (kind === 'UPGRADE') toasts.success(t('fin.subscription.change.upgradedNow', { plan: change.plan.name }));
        else if (kind === 'WITHDRAWN') toasts.success(t('fin.subscription.change.withdrawn'));
        else toasts.success(t('fin.subscription.change.scheduled'), result.pendingChange?.effectiveAt ? t('fin.subscription.change.scheduledDescription', { date: formatDate(result.pendingChange.effectiveAt) }) : undefined);
      }
      await refresh();
    } catch (error) {
      if (isApiError(error) && error.code === 'DOWNGRADE_BLOCKED_BY_USAGE') {
        setBlocked({ plan: change.plan.name, exceeded: (error.details as { exceeded?: Blocked['exceeded'] } | undefined)?.exceeded ?? [] });
        return; // the confirm dialog closes; the explanation appears above the plans
      }
      toasts.error(error);
      throw error;
    }
  };

  const withdraw = async () => {
    if (!plan) return;
    setWithdrawing(true);
    try {
      queryClient.setQueryData(finKeys.subscription.current, await api.subscription.changePlan({ planKey: plan.key }));
      toasts.success(t('fin.subscription.change.withdrawn'));
      await refresh();
    } catch (error) {
      toasts.error(error);
    } finally {
      setWithdrawing(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    try {
      queryClient.setQueryData(finKeys.subscription.current, await api.subscription.resume());
      toasts.success(t('fin.subscription.cancel.resumed'));
    } catch (error) {
      toasts.error(error);
    } finally {
      setResuming(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('fin.subscription.title')}
        description={t('fin.subscription.description')}
        action={
          firstOpen ? (
            <Button variant="accent" onClick={() => void pay(firstOpen)} loading={paying === firstOpen.id} loadingText={t('common.loading')}>
              <CreditCard aria-hidden="true" />
              {t('fin.subscription.payNow')}
            </Button>
          ) : null
        }
      />

      <div className="mb-6 space-y-3 empty:hidden">
        {returned === 'success' ? (
          <Alert tone="success" live title={t('fin.subscription.returned.successTitle')}>
            {t('fin.subscription.returned.successText')}
          </Alert>
        ) : returned ? (
          <Alert tone="warning" live title={t('fin.subscription.returned.failedTitle')}>
            {t('fin.subscription.returned.failedText')}
          </Alert>
        ) : null}
        {suspended ? (
          <Alert tone="danger" title={t('fin.subscription.suspended.title')}>
            {view.suspendedForNonPayment ? t('fin.subscription.suspended.unpaid') : t('fin.subscription.suspended.other')}
          </Alert>
        ) : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <CurrentPlan view={view} onResume={() => void resume()} resuming={resuming} onCancel={() => setCancelling(true)} onWithdraw={() => void withdraw()} withdrawing={withdrawing} />

          {view.openInvoices.length ? (
            <Section title={t('fin.subscription.open.title')} description={t('fin.subscription.open.text')} flush>
              <ul className="divide-y">
                {view.openInvoices.map((invoice) => (
                  <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="tabular font-medium text-foreground">
                        {invoice.number}
                        {invoice.overdue && invoice.reason !== 'UPGRADE' ? (
                          <Badge tone="danger" className="ms-2 align-middle">
                            {t('fin.invoices.overdue')}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t(`fin.subscription.reasons.${reasonKey(invoice.reason)}`)} · {t('fin.subscription.open.due', { date: formatDate(invoice.dueAt) })}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <Money amount={invoice.total} currency={invoice.currency} className="text-md font-semibold" />
                      <Button onClick={() => void pay(invoice)} loading={paying === invoice.id} loadingText={t('common.loading')}>
                        {t('fin.subscription.payNow')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          <Usage view={view} />
          <CouponCard view={view} onApplied={(next) => queryClient.setQueryData(finKeys.subscription.current, next)} />
        </div>
      </div>

      {/* Plans */}
      <section aria-labelledby="plans-heading" className="mt-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="plans-heading" className="text-lg font-semibold text-foreground">
              {ended ? t('fin.subscription.plans.titleRestart') : t('fin.subscription.plans.title')}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{ended ? t('fin.subscription.plans.textRestart') : t('fin.subscription.plans.text')}</p>
          </div>
          <div role="group" aria-label={t('fin.subscription.cycle.label')} className="inline-flex rounded-md border bg-card p-0.5">
            {(['MONTHLY', 'ANNUAL'] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cycle === c}
                onClick={() => setViewCycle(c)}
                className={cn('h-9 rounded-[0.3rem] px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', cycle === c ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {t(`fin.subscription.cycle.${c}`)}
              </button>
            ))}
          </div>
        </div>

        {blocked ? (
          <Alert tone="danger" live className="mb-4" title={t('fin.subscription.blocked.title', { plan: blocked.plan })}>
            <p>{t('fin.subscription.blocked.text')}</p>
            <ul className="mt-2 list-disc space-y-0.5 ps-5">
              {blocked.exceeded.map((e) => (
                <li key={e.metric}>{t('fin.subscription.blocked.line', { metric: metricLabel(t, e.metric), used: e.used, limit: e.limit })}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {plans.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-96" />
            ))}
          </div>
        ) : plans.isError ? (
          <LoadError error={plans.error} onRetry={() => void plans.refetch()} />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[...plans.data].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => (
              <li key={p.key}>
                <PlanCard plan={p} cycle={cycle} view={view} ended={ended} onChoose={() => choose(p)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <InvoicesTable onPay={(invoice) => void pay(invoice)} />

      {/* ---- dialogs */}
      <ConfirmDialog
        open={!!change}
        onOpenChange={(open) => !open && setChange(null)}
        tone="default"
        title={change ? t(`fin.subscription.change.${change.kind}.title`, { plan: change.plan.name, cycle: t(`fin.subscription.cycle.${change.cycle}`) }) : ''}
        description={change ? <ChangeExplanation change={change} view={view} /> : null}
        confirmLabel={change ? t(`fin.subscription.change.${change.kind}.confirm`) : ''}
        onConfirm={confirmChange}
      />

      <ReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('fin.subscription.cancel.title')}
        description={sub ? t('fin.subscription.cancel.text', { date: formatDate(sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd) }) : undefined}
        label={t('fin.subscription.cancel.reason')}
        hint={t('fin.subscription.cancel.reasonHint')}
        submitLabel={t('fin.subscription.cancel.submit')}
        submitVariant="destructive"
        onSubmit={async (reason) => {
          queryClient.setQueryData(finKeys.subscription.current, await api.subscription.cancel({ reason }));
          toasts.success(t('fin.subscription.cancel.done'));
          await refresh();
        }}
      />

      {checkout ? <CheckoutDialog state={checkout} onClose={() => setCheckout(null)} onPaid={refresh} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- helpers

const REASONS = new Set(['FIRST_PERIOD', 'RENEWAL', 'UPGRADE', 'RESTART']);
const reasonKey = (reason: string) => (REASONS.has(reason) ? reason : 'OTHER');
const LIMIT_SET = new Set<string>(PLAN_LIMIT_KEYS);
function metricLabel(t: (key: string) => string, metric: string) {
  return LIMIT_SET.has(metric) ? t(`fin.subscription.limits.${metric}`) : metric;
}
/** "10 GB" kept together and left-to-right inside Arabic text (Unicode isolates). */
const gigabytes = (amount: string) => `\u2066${amount} GB\u2069`;
const formatLimit = (t: (key: string) => string, formatNumber: (n: number) => string, key: string, value: number) =>
  value < 0 ? t('fin.subscription.unlimited') : value === 0 ? t('fin.subscription.notIncluded') : key === 'storageMb' ? gigabytes(formatNumber(Math.round((value / 1024) * 10) / 10)) : formatNumber(value);

// ---------------------------------------------------------------- current plan

function CurrentPlan({ view, onResume, resuming, onCancel, onWithdraw, withdrawing }: { view: SubscriptionView; onResume: () => void; resuming: boolean; onCancel: () => void; onWithdraw: () => void; withdrawing: boolean }) {
  const { t, tn, formatDate } = useI18n();
  const sub = view.subscription;
  const plan = view.plan;
  if (!sub || !plan) {
    return (
      <Card>
        <CardContent>
          <Alert tone="info" title={t('fin.subscription.none.title')}>
            {t('fin.subscription.none.text')}
          </Alert>
        </CardContent>
      </Card>
    );
  }
  const status = sub.status;
  const explanation =
    status === 'TRIALING'
      ? sub.cancelAtPeriodEnd
        ? t('fin.subscription.status.trialCancelling', { date: formatDate(sub.trialEndsAt) })
        : `${tn('fin.subscription.status.trialDays', sub.trialDaysLeft ?? 0)} ${t('fin.subscription.status.trial', { date: formatDate(sub.trialEndsAt) })}`
      : status === 'ACTIVE'
        ? sub.cancelAtPeriodEnd
          ? t('fin.subscription.status.cancelling', { date: formatDate(sub.currentPeriodEnd) })
          : t('fin.subscription.status.active', { date: formatDate(sub.currentPeriodEnd) })
        : status === 'PAST_DUE'
          ? t('fin.subscription.status.pastDue')
          : status === 'GRACE'
            ? t('fin.subscription.status.grace', { date: formatDate(sub.graceEndsAt) })
            : status === 'CANCELLED'
              ? t('fin.subscription.status.cancelled', { date: formatDate(sub.cancelledAt ?? sub.currentPeriodEnd) })
              : t('fin.subscription.status.expired');
  const tone = status === 'PAST_DUE' || status === 'EXPIRED' ? 'danger' : status === 'GRACE' || sub.cancelAtPeriodEnd ? 'warning' : status === 'CANCELLED' ? 'warning' : 'info';
  const running = status === 'TRIALING' || status === 'ACTIVE' || status === 'PAST_DUE' || status === 'GRACE';

  return (
    <Section
      title={t('fin.subscription.current.title')}
      action={
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge kind="subscription" status={status} />
          {sub.cancelAtPeriodEnd && running ? <Badge tone="warning">{t('fin.subscription.current.cancelsBadge')}</Badge> : null}
        </span>
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-2xl font-semibold text-foreground">{plan.name}</p>
        <p className="text-base text-muted-foreground">
          <Money amount={sub.price} currency={plan.currency} className="text-lg font-semibold text-foreground" /> {t(`fin.subscription.per.${sub.billingCycle}`)}
        </p>
      </div>
      {plan.description ? <p className="mt-1 text-sm text-muted-foreground" dir="auto">{plan.description}</p> : null}

      <Alert tone={tone} className="mt-4">
        {explanation}
      </Alert>

      <DescriptionList
        className="mt-5"
        columns={3}
        items={[
          { label: t('fin.subscription.current.cycle'), value: t(`fin.subscription.cycle.${sub.billingCycle}`) },
          status === 'TRIALING'
            ? { label: t('fin.subscription.current.trialEnds'), value: formatDate(sub.trialEndsAt) }
            : { label: t('fin.subscription.current.period'), value: `${formatDate(sub.currentPeriodStart)} – ${formatDate(sub.currentPeriodEnd)}` },
          ...(running && !sub.cancelAtPeriodEnd && status !== 'TRIALING' ? [{ label: t('fin.subscription.current.renews'), value: formatDate(sub.currentPeriodEnd) }] : []),
          ...(sub.graceEndsAt && status === 'GRACE' ? [{ label: t('fin.subscription.current.graceEnds'), value: formatDate(sub.graceEndsAt) }] : []),
          ...(sub.cancellationReason ? [{ label: t('fin.subscription.cancel.reason'), value: <span dir="auto">{sub.cancellationReason}</span>, wide: true }] : []),
        ]}
      />

      {view.pendingChange ? (
        <Alert
          tone="info"
          className="mt-4"
          title={t('fin.subscription.pending.title')}
          action={
            <Button size="sm" variant="outline" onClick={onWithdraw} loading={withdrawing}>
              {t('fin.subscription.change.withdraw')}
            </Button>
          }
        >
          {view.pendingChange.plan ? t('fin.subscription.pending.plan', { plan: view.pendingChange.plan.name }) : ''}
          {view.pendingChange.plan && view.pendingChange.billingCycle ? ' ' : ''}
          {view.pendingChange.billingCycle ? t('fin.subscription.pending.cycle', { cycle: t(`fin.subscription.cycle.${view.pendingChange.billingCycle}`) }) : ''}{' '}
          {view.pendingChange.effective === 'AFTER_PAYMENT' ? t('fin.subscription.pending.afterPayment') : view.pendingChange.effectiveAt ? t('fin.subscription.pending.atDate', { date: formatDate(view.pendingChange.effectiveAt) }) : ''}
        </Alert>
      ) : null}

      {running ? (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t pt-4">
          <Button asChild variant="outline">
            <a href="#plans-heading">
              {t('fin.subscription.current.changePlan')}
              <ArrowRight className="rtl-mirror" aria-hidden="true" />
            </a>
          </Button>
          {sub.cancelAtPeriodEnd ? (
            <Button onClick={onResume} loading={resuming} loadingText={t('common.saving')}>
              {t('fin.subscription.cancel.resume')}
            </Button>
          ) : (
            <Button variant="ghost" className="text-destructive-text hover:bg-destructive-soft" onClick={onCancel}>
              {t('fin.subscription.cancel.open')}
            </Button>
          )}
        </div>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------- usage

function Usage({ view }: { view: SubscriptionView }) {
  const { t, formatNumber } = useI18n();
  if (!view.usage.length) return null;
  return (
    <Section title={t('fin.subscription.usage.title')} description={t('fin.subscription.usage.text')}>
      <ul className="space-y-4">
        {view.usage.map((u) => {
          const unlimited = u.limit < 0;
          const excluded = u.limit === 0;
          const ratio = unlimited || excluded ? 0 : Math.min(1, u.used / u.limit);
          const over = !unlimited && !excluded && u.used >= u.limit;
          const near = !over && ratio >= 0.8;
          const show = (n: number) => (u.metric === 'storageMb' ? gigabytes(formatNumber(Math.round((n / 1024) * 100) / 100)) : formatNumber(n));
          return (
            <li key={u.metric}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium text-foreground">{metricLabel(t, u.metric)}</span>
                <span className="tabular text-muted-foreground">{unlimited ? `${show(u.used)} · ${t('fin.subscription.unlimited')}` : excluded ? t('fin.subscription.notIncluded') : t('fin.subscription.usage.of', { used: show(u.used), limit: show(u.limit) })}</span>
              </div>
              {!unlimited && !excluded ? (
                <div
                  role="progressbar"
                  aria-label={metricLabel(t, u.metric)}
                  aria-valuemin={0}
                  aria-valuemax={u.limit}
                  aria-valuenow={Math.min(u.used, u.limit)}
                  className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div className={cn('h-full rounded-full', over ? 'bg-destructive' : near ? 'bg-warning' : 'bg-secondary')} style={{ width: `${Math.max(u.used > 0 ? 2 : 0, ratio * 100)}%` }} />
                </div>
              ) : null}
              {over ? <p className="mt-1 text-xs font-medium text-destructive-text">{t('fin.subscription.usage.reached')}</p> : near ? <p className="mt-1 text-xs font-medium text-warning-text">{t('fin.subscription.usage.near')}</p> : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------- coupon

function CouponCard({ view, onApplied }: { view: SubscriptionView; onApplied: (next: SubscriptionView) => void }) {
  const { t, formatDate, formatNumber } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const form = useZodForm(applyCouponSchema, { defaultValues: { code: '' } });
  const coupon = view.coupon;
  return (
    <Section title={t('fin.subscription.coupon.title')}>
      {coupon ? (
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-success-soft text-success-text">
            <TicketPercent className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="ltr-value font-semibold text-foreground">{coupon.code}</p>
            <p className="text-sm text-muted-foreground">
              {coupon.percentOff ? t('fin.subscription.coupon.percent', { percent: formatNumber(coupon.percentOff, { maximumFractionDigits: 2 }) }) : null}
              {coupon.amountOff ? (
                <>
                  {t('fin.subscription.coupon.amount')} <Money amount={coupon.amountOff} currency={view.plan?.currency} />
                </>
              ) : null}
              {' · '}
              {coupon.endsAt ? t('fin.subscription.coupon.until', { date: formatDate(coupon.endsAt) }) : t('fin.subscription.coupon.forever')}
            </p>
          </div>
        </div>
      ) : (
        <Form
          form={form}
          className="space-y-3"
          onSubmit={async (values) => {
            const next = await api.subscription.coupon({ code: values.code });
            toasts.success(t('fin.subscription.coupon.applied', { code: next.coupon?.code ?? values.code }));
            form.reset({ code: '' });
            onApplied(next);
          }}
        >
          <FormField name="code" label={t('fin.subscription.coupon.code')} hint={t('fin.subscription.coupon.hint')}>
            {(field) => <Input {...field} dir="ltr" autoComplete="off" autoCapitalize="characters" spellCheck={false} className="uppercase" />}
          </FormField>
          <FormError />
          <Button type="submit" variant="outline" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {t('fin.subscription.coupon.apply')}
          </Button>
        </Form>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- plan card

function PlanCard({ plan, cycle, view, ended, onChoose }: { plan: PublicPlan; cycle: BillingCycle; view: SubscriptionView; ended: boolean; onChoose: () => void }) {
  const { t, formatNumber } = useI18n();
  const current = view.plan;
  const sub = view.subscription;
  const isCurrent = !ended && current?.key === plan.key;
  const sameCycle = sub?.billingCycle === cycle;
  const pending = view.pendingChange?.plan?.key === plan.key;
  const higher = current && sub ? compareMoney(priceOf(plan, sub.billingCycle), priceOf(current, sub.billingCycle)) > 0 : true;
  const label = ended
    ? t('fin.subscription.plans.subscribe')
    : isCurrent
      ? sameCycle
        ? null
        : t('fin.subscription.plans.switchCycle', { cycle: t(`fin.subscription.cycle.${cycle}`) })
      : higher
        ? t('fin.subscription.plans.upgrade')
        : t('fin.subscription.plans.downgrade');
  return (
    <Card className={cn('flex h-full flex-col p-5', isCurrent && 'border-secondary ring-1 ring-secondary')}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-md font-semibold text-foreground">{plan.name}</h3>
        {isCurrent ? <Badge tone="brand">{t('fin.subscription.plans.current')}</Badge> : pending ? <Badge tone="info">{t('fin.subscription.plans.pending')}</Badge> : null}
      </div>
      {plan.description ? <p className="mt-1 min-h-10 text-sm text-muted-foreground" dir="auto">{plan.description}</p> : null}
      <p className="mt-3">
        <Money amount={priceOf(plan, cycle)} currency={plan.currency} className="text-2xl font-semibold text-foreground" />
        <span className="ms-1.5 text-sm text-muted-foreground">{t(`fin.subscription.per.${cycle}`)}</span>
      </p>
      <p className="min-h-5 text-xs text-muted-foreground">
        {cycle === 'ANNUAL' && Number(plan.annualSaving) > 0 ? (
          <>
            {t('fin.subscription.plans.saving')} <Money amount={plan.annualSaving} currency={plan.currency} />
          </>
        ) : null}
      </p>
      <dl className="mt-4 space-y-1.5 border-t pt-4 text-sm">
        {PLAN_LIMIT_KEYS.map((key) => (
          <div key={key} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{t(`fin.subscription.limits.${key}`)}</dt>
            <dd className={cn('tabular text-end', plan.limits[key] === 0 ? 'text-muted-foreground' : 'font-medium text-foreground')}>{formatLimit(t, (n) => formatNumber(n), key, plan.limits[key])}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-4 space-y-1.5 border-t pt-4 text-sm">
        {PLAN_FEATURE_KEYS.map((key) => (
          <li key={key} className={cn('flex items-center gap-2', plan.features[key] ? 'text-foreground' : 'text-muted-foreground')}>
            {plan.features[key] ? <Check className="size-4 shrink-0 text-success-text" aria-hidden="true" /> : <Minus className="size-4 shrink-0" aria-hidden="true" />}
            <span>{t(`fin.subscription.features.${key}`)}</span>
            <span className="sr-only">{plan.features[key] ? t('fin.subscription.plans.included') : t('fin.subscription.plans.notIncluded')}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-5">
        {label ? (
          <Button className="w-full" variant={isCurrent || (!higher && !ended) ? 'outline' : 'default'} onClick={onChoose}>
            {label}
          </Button>
        ) : (
          <p className="flex h-10 items-center justify-center text-sm font-medium text-muted-foreground">{t('fin.subscription.plans.yourPlan')}</p>
        )}
      </div>
    </Card>
  );
}

/** What exactly will happen, in the confirmation of a plan change. */
function ChangeExplanation({ change, view }: { change: PlanChange; view: SubscriptionView }) {
  const { t, formatDate } = useI18n();
  const sub = view.subscription;
  const price = <Money amount={priceOf(change.plan, change.cycle)} currency={change.plan.currency} className="font-medium text-foreground" />;
  const end = sub ? formatDate(sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd) : '';
  const cycleChanges = !!sub && change.cycle !== sub.billingCycle;
  return (
    <div className="space-y-2">
      {change.kind === 'upgrade' ? (
        <>
          <p>{sub?.status === 'TRIALING' ? t('fin.subscription.change.upgrade.trial') : t('fin.subscription.change.upgrade.text', { date: end })}</p>
          {cycleChanges ? <p>{t('fin.subscription.change.upgrade.cycleLater', { cycle: t(`fin.subscription.cycle.${change.cycle}`), date: end })}</p> : null}
        </>
      ) : null}
      {change.kind === 'downgrade' ? <p>{t('fin.subscription.change.downgrade.text', { date: end })}</p> : null}
      {change.kind === 'cycle' ? <p>{t('fin.subscription.change.cycle.text', { date: end })}</p> : null}
      {change.kind === 'restart' ? <p>{t('fin.subscription.change.restart.text')}</p> : null}
      <p>
        {t('fin.subscription.change.newPrice')} {price} {t(`fin.subscription.per.${change.cycle}`)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- checkout

function CheckoutDialog({ state, onClose, onPaid }: { state: { invoice: Pick<SubscriptionOpenInvoice, 'id' | 'number' | 'total' | 'currency'>; session?: SubscriptionCheckout; missing?: boolean }; onClose: () => void; onPaid: () => Promise<void> }) {
  const { t, formatDateTime } = useI18n();
  const client = useApiClient();
  const toasts = useToast();
  const [busy, setBusy] = React.useState(false);
  const session = state.session;
  const sandbox = session?.gateway === 'sandbox' && session.testMode;

  /** The test gateway has no payment page of its own: completing the session makes it send its signed webhook, exactly like a real payment. */
  const completeTest = async () => {
    if (!session || !session.checkoutUrl.startsWith(client.baseUrl)) return;
    setBusy(true);
    try {
      await client.post(`${session.checkoutUrl.slice(client.baseUrl.length)}/complete`, undefined, { auth: false });
      toasts.success(t('fin.subscription.checkout.testPaid', { number: state.invoice.number }));
      await onPaid();
      onClose();
    } catch (error) {
      toasts.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fin.subscription.checkout.title', { number: state.invoice.number })}</DialogTitle>
          <DialogDescription>{state.missing ? t('fin.subscription.checkout.missingLead') : t('fin.subscription.checkout.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
            <span>{t('fin.subscription.checkout.amount')}</span>
            <Money amount={session?.amount ?? state.invoice.total} currency={session?.currency ?? state.invoice.currency} className="font-semibold" />
          </div>
          {state.missing ? (
            <Alert tone="warning" live title={t('fin.subscription.checkout.missingTitle')}>
              {t('fin.subscription.checkout.missingText', { number: state.invoice.number })}
            </Alert>
          ) : null}
          {sandbox ? <Alert tone="warning">{t('fin.subscription.checkout.testMode')}</Alert> : null}
          {session && !sandbox ? <p className="text-sm text-muted-foreground">{t('fin.subscription.checkout.leave', { time: formatDateTime(session.expiresAt) })}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {state.missing ? t('common.close') : t('common.cancel')}
          </Button>
          {state.missing ? (
            <Button asChild>
              <Link href="/support">{t('fin.subscription.checkout.contact')}</Link>
            </Button>
          ) : sandbox ? (
            <Button onClick={() => void completeTest()} loading={busy} loadingText={t('common.loading')}>
              {t('fin.subscription.checkout.completeTest')}
            </Button>
          ) : session ? (
            <Button asChild>
              <a href={session.checkoutUrl}>
                {t('fin.subscription.checkout.continue')}
                <ArrowRight className="rtl-mirror" aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- invoices

function InvoicesTable({ onPay }: { onPay: (invoice: Pick<SubscriptionOpenInvoice, 'id' | 'number' | 'total' | 'currency'>) => void }) {
  const { t, formatDate } = useI18n();
  const api = useFinApi();
  const download = useDownload();

  const columns = React.useMemo<Array<DataTableColumn<SubscriptionInvoiceRow>>>(
    () => [
      { id: 'number', header: t('fin.subscription.invoices.number'), sortField: 'number', mobile: 'title', className: 'whitespace-nowrap', cell: (i) => <span className="tabular">{i.number}</span> },
      { id: 'status', header: t('fin.common.status'), mobile: 'badge', cell: (i) => <Badge tone={i.status === 'PAID' ? 'success' : i.status === 'OPEN' ? 'warning' : 'neutral'}>{t(`fin.subscription.invoices.status.${i.status}`)}</Badge> },
      {
        id: 'what',
        header: t('fin.subscription.invoices.what'),
        cell: (i) => (
          <>
            <span className="block">{t(`fin.subscription.reasons.${reasonKey(i.reason)}`)}</span>
            <span className="tabular block text-sm text-muted-foreground">
              {formatDate(i.periodStart)} – {formatDate(i.periodEnd)}
            </span>
          </>
        ),
      },
      { id: 'due', header: t('fin.subscription.invoices.due'), sortField: 'dueAt', className: 'whitespace-nowrap tabular', cell: (i) => formatDate(i.dueAt) },
      { id: 'paid', header: t('fin.subscription.invoices.paid'), className: 'whitespace-nowrap tabular', cell: (i) => (i.paidAt ? formatDate(i.paidAt) : null) },
      {
        id: 'total',
        header: t('fin.common.total'),
        sortField: 'total',
        align: 'end',
        cell: (i) => (
          <>
            <Money amount={i.total} currency={i.currency} className="font-medium" />
            {Number(i.discount) > 0 ? (
              <span className="block text-sm text-muted-foreground">
                {t('fin.subscription.invoices.discount')} <Money amount={i.discount} currency={i.currency} />
              </span>
            ) : null}
          </>
        ),
      },
    ],
    [t, formatDate],
  );

  const rowActions = React.useMemo<Array<RowAction<SubscriptionInvoiceRow>>>(
    () => [
      { id: 'pdf', label: t('fin.common.downloadPdf'), icon: <FileDown aria-hidden="true" />, onSelect: (i) => void download.save(i.id, api.subscription.invoicePdfPath(i.id), { fallbackFilename: `${i.number}.pdf` }) },
      { id: 'pay', label: t('fin.subscription.payNow'), icon: <CreditCard aria-hidden="true" />, onSelect: (i) => onPay(i), hidden: (i) => i.status !== 'OPEN' },
    ],
    [t, download, api, onPay],
  );

  return (
    <section aria-labelledby="sub-invoices" className="mt-8">
      <h2 id="sub-invoices" className="mb-1 text-lg font-semibold text-foreground">
        {t('fin.subscription.invoices.title')}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('fin.subscription.invoices.text')}</p>
      <DataTable<SubscriptionInvoiceRow>
        caption={t('fin.subscription.invoices.title')}
        queryKey={finKeys.subscription.invoices}
        queryFn={(params, signal) => api.subscription.invoices(params, signal)}
        columns={columns}
        rowKey={(i) => i.id}
        rowActions={rowActions}
        searchable={false}
        syncUrl={false}
        defaultSort="createdAt:desc"
        defaultPageSize={10}
        empty={{ icon: <ReceiptText />, title: t('fin.subscription.invoices.emptyTitle'), description: t('fin.subscription.invoices.emptyText') }}
      />
    </section>
  );
}
