'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, CreditCard, ExternalLink, Receipt, Repeat2, TicketPercent } from 'lucide-react';
import { Badge, DataTable, PageHeader, RequirePermission, STATUS_META, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { ApplyCouponDialog, ChangePlanDialog, CouponDiscount, ExtendTrialDialog, type BillingSubject } from '@/components/billing';
import { Money, useUrlState } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { FailedPaymentRow, FailedPaymentTotals, SubscriptionRow, SubscriptionStatus } from '@/lib/types';

const STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'EXPIRED'];

export function Subscriptions() {
  return (
    <RequirePermission anyOf={['platform.billing.manage']}>
      <SubscriptionsScreen />
    </RequirePermission>
  );
}

/** SaaS billing across all centres: every subscription, and the unpaid invoices with a failed attempt. */
function SubscriptionsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const mayReport = session.hasPermission('platform.metrics.read');
  const [tab, setTab] = useUrlState('tab', 'all');
  const current = tab === 'failed' && mayReport ? 'failed' : 'all';
  return (
    <>
      <PageHeader title={t('nav.subscriptions')} description={t('billing.description')} />
      <Tabs value={current} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="all">{t('billing.tabs.all')}</TabsTrigger>
          {mayReport ? <TabsTrigger value="failed">{t('billing.tabs.failed')}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="all">{current === 'all' ? <AllSubscriptions /> : null}</TabsContent>
        {mayReport ? <TabsContent value="failed">{current === 'failed' ? <FailedPayments /> : null}</TabsContent> : null}
      </Tabs>
    </>
  );
}

function AllSubscriptions() {
  const { t, pick, formatDate } = useI18n();
  const api = usePlatformApi();
  const plans = useQuery({ queryKey: keys.plans.admin, queryFn: ({ signal }) => api.plans.list(signal), staleTime: 60_000 });
  const [dialog, setDialog] = React.useState<{ kind: 'plan' | 'trial' | 'coupon'; subject: BillingSubject } | null>(null);
  const subjectOf = (row: SubscriptionRow): BillingSubject => ({ tenantId: row.tenant.id, tenantName: row.tenant.name, planKey: row.plan.key, planName: row.plan.name, cycle: row.billingCycle, status: row.status, trialEndsAt: row.trialEndsAt });

  const columns = React.useMemo<Array<DataTableColumn<SubscriptionRow>>>(
    () => [
      {
        id: 'centre',
        header: t('pc.centre'),
        mobile: 'title',
        className: 'min-w-52',
        cell: (row) => (
          <>
            <bdi className="block">{row.tenant.name}</bdi>
            <span className="ltr-value block text-sm font-normal text-muted-foreground">{row.tenant.slug}</span>
          </>
        ),
      },
      {
        id: 'plan',
        header: t('billing.columns.plan'),
        cell: (row) => (
          <>
            <span className="block">{row.plan.name}</span>
            <span className="block text-sm text-muted-foreground">{t(`pc.cycle.${row.billingCycle}`)}</span>
            {row.pendingPlan || row.pendingCycle ? (
              <span className="mt-0.5 block text-xs text-info-text">
                {t('billing.pendingChange', { plan: row.pendingPlan?.name ?? row.plan.name })}
                {row.pendingCycle ? ` · ${t(`pc.cycle.${row.pendingCycle}`)}` : ''}
              </span>
            ) : null}
          </>
        ),
      },
      {
        id: 'status',
        header: t('pc.status'),
        sortField: 'status',
        mobile: 'badge',
        cell: (row) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="subscription" status={row.status} />
            {row.cancelAtPeriodEnd && !row.cancelledAt ? <Badge tone="warning">{t('billing.cancelAtPeriodEnd')}</Badge> : null}
          </span>
        ),
      },
      {
        id: 'ends',
        header: t('billing.columns.periodEnd'),
        sortField: 'currentPeriodEnd',
        className: 'whitespace-nowrap',
        cell: (row) =>
          row.currentPeriodEnd ? (
            <>
              <span className="tabular block">{formatDate(row.currentPeriodEnd)}</span>
              <span className="block text-sm text-muted-foreground">
                {row.status === 'TRIALING' ? t('billing.ends.trial') : row.status === 'ACTIVE' ? (row.cancelAtPeriodEnd ? t('billing.ends.cancels') : t('billing.ends.renews')) : row.status === 'CANCELLED' ? t('billing.ends.cancelled') : row.graceEndsAt ? t('billing.ends.grace', { date: formatDate(row.graceEndsAt) }) : t('billing.ends.period')}
              </span>
            </>
          ) : null,
      },
      {
        id: 'price',
        header: t('billing.price'),
        align: 'end',
        className: 'whitespace-nowrap',
        cell: (row) => <Money amount={row.billingCycle === 'ANNUAL' ? row.plan.annualPrice : row.plan.monthlyPrice} currency={row.plan.currency} />,
      },
      {
        id: 'coupon',
        header: t('billing.columns.coupon'),
        cell: (row) =>
          row.coupon ? (
            <>
              <span className="ltr-value tabular block font-medium">{row.coupon.code}</span>
              <span className="block text-sm text-muted-foreground">
                <CouponDiscount coupon={{ ...row.coupon, currency: row.plan.currency }} />
              </span>
            </>
          ) : null,
      },
      { id: 'started', header: t('billing.columns.started'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (row) => formatDate(row.createdAt) },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('pc.status'), options: STATUSES.map((s) => ({ value: s, label: pick(STATUS_META.subscription[s].en, STATUS_META.subscription[s].ar) })) },
      { id: 'planKey', type: 'select', label: t('billing.columns.plan'), options: [...(plans.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ value: p.key, label: p.name })) },
      { id: 'billingCycle', type: 'select', label: t('billing.columns.cycle'), options: [{ value: 'MONTHLY', label: t('pc.cycle.MONTHLY') }, { value: 'ANNUAL', label: t('pc.cycle.ANNUAL') }] },
    ],
    [t, pick, plans.data],
  );

  const running = (row: SubscriptionRow) => row.status === 'TRIALING' || row.status === 'ACTIVE';
  const rowActions = React.useMemo<Array<RowAction<SubscriptionRow>>>(
    () => [
      { id: 'open', label: t('billing.openBilling'), icon: <ExternalLink aria-hidden="true" />, href: (row) => `/tenants/${row.tenant.id}?tab=billing` },
      { id: 'plan', label: t('billing.change.action'), icon: <Repeat2 aria-hidden="true" />, hidden: (row) => !running(row), onSelect: (row) => setDialog({ kind: 'plan', subject: subjectOf(row) }) },
      { id: 'trial', label: t('billing.trial.action'), icon: <CalendarPlus aria-hidden="true" />, hidden: (row) => row.status !== 'TRIALING', onSelect: (row) => setDialog({ kind: 'trial', subject: subjectOf(row) }) },
      { id: 'coupon', label: t('billing.coupon.action'), icon: <TicketPercent aria-hidden="true" />, hidden: (row) => !!row.coupon || !running(row), onSelect: (row) => setDialog({ kind: 'coupon', subject: subjectOf(row) }) },
    ],
    [t],
  );

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  return (
    <>
      <DataTable<SubscriptionRow>
        caption={t('nav.subscriptions')}
        queryKey={keys.billing.all}
        queryFn={(params, signal) => api.billing.subscriptions(params, signal)}
        columns={columns}
        rowKey={(row) => row.id}
        rowHref={(row) => `/tenants/${row.tenant.id}?tab=billing`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('billing.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <CreditCard />, title: t('billing.emptyTitle'), description: t('billing.emptyText') }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('billing.separateNote')}</p>
      <ChangePlanDialog subject={dialog?.subject ?? null} open={dialog?.kind === 'plan'} onOpenChange={close} />
      <ExtendTrialDialog subject={dialog?.subject ?? null} open={dialog?.kind === 'trial'} onOpenChange={close} />
      <ApplyCouponDialog subject={dialog?.subject ?? null} open={dialog?.kind === 'coupon'} onOpenChange={close} />
    </>
  );
}

/** Open subscription invoices that already had a failed collection attempt (GET /platform/reports/failed-payments). */
function FailedPayments() {
  const { t, tn, formatDate, formatNumber } = useI18n();
  const api = usePlatformApi();
  const [totals, setTotals] = React.useState<FailedPaymentTotals | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<FailedPaymentRow>>>(
    () => [
      {
        id: 'centre',
        header: t('pc.centre'),
        mobile: 'title',
        className: 'min-w-52',
        cell: (row) => (
          <>
            <bdi className="block">{row.centre.name}</bdi>
            <span className="ltr-value tabular block text-sm font-normal text-muted-foreground">{row.number}</span>
          </>
        ),
      },
      { id: 'plan', header: t('billing.columns.plan'), cell: (row) => row.plan.name },
      { id: 'total', header: t('billing.invoices.total'), align: 'end', className: 'whitespace-nowrap', cell: (row) => <Money amount={row.total} currency={row.currency} className="font-medium" /> },
      { id: 'due', header: t('billing.invoices.due'), className: 'whitespace-nowrap tabular', cell: (row) => formatDate(row.dueAt) },
      {
        id: 'attempts',
        header: t('billing.failed.attempts'),
        cell: (row) => (
          <>
            <span className="tabular block">{formatNumber(row.attempts)}</span>
            {row.nextAttemptAt ? <span className="tabular block text-sm text-muted-foreground">{t('billing.failed.next', { date: formatDate(row.nextAttemptAt) })}</span> : null}
          </>
        ),
      },
      {
        id: 'status',
        header: t('billing.columns.subscription'),
        mobile: 'badge',
        cell: (row) => (
          <>
            <StatusBadge kind="subscription" status={row.subscriptionStatus} />
            {row.graceEndsAt ? <span className="tabular mt-1 block text-sm text-muted-foreground">{t('billing.ends.grace', { date: formatDate(row.graceEndsAt) })}</span> : null}
          </>
        ),
      },
      {
        id: 'error',
        header: t('billing.failed.lastError'),
        mobile: 'hidden',
        className: 'max-w-72',
        cell: (row) =>
          row.lastError ? (
            <span className="line-clamp-2 text-sm" dir="auto" title={row.lastError}>
              {row.lastError}
            </span>
          ) : null,
      },
    ],
    [t, formatDate, formatNumber],
  );
  const filters = React.useMemo<DataTableFilter[]>(() => [{ id: 'due', type: 'dateRange', label: t('billing.invoices.due'), fromKey: 'from', toKey: 'to' }], [t]);

  return (
    <>
      {totals ? (
        <p className="mb-3 text-base text-muted-foreground">
          {tn('billing.failed.summary', totals.openInvoices)}
          {totals.amounts.map((amount) => (
            <React.Fragment key={amount.currency}>
              {' · '}
              <Money amount={amount.total} currency={amount.currency} className="font-medium text-foreground" />
            </React.Fragment>
          ))}
          {' · '}
          {t('billing.failed.states', { pastDue: formatNumber(totals.subscriptionsPastDue), grace: formatNumber(totals.subscriptionsInGrace) })}
        </p>
      ) : null}
      <DataTable<FailedPaymentRow>
        caption={t('billing.tabs.failed')}
        queryKey={keys.billing.failed}
        queryFn={async (params, signal) => {
          const page = await api.reports.failedPayments(params, signal);
          setTotals(page.totals);
          return page;
        }}
        columns={columns}
        rowKey={(row) => row.id}
        rowHref={(row) => `/tenants/${row.centre.id}?tab=billing`}
        filters={filters}
        searchPlaceholder={t('billing.failed.searchPlaceholder')}
        empty={{ icon: <Receipt />, title: t('billing.failed.emptyTitle'), description: t('billing.failed.emptyText') }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('billing.failed.note')}</p>
    </>
  );
}
