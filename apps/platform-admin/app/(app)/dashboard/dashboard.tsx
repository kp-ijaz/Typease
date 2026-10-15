'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Building2, CheckCircle2, CircleDollarSign, Hourglass, KeyRound, LifeBuoy, PauseCircle, Plus, Receipt, TrendingDown, TrendingUp } from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, EmptyState, PageHeader, PermissionGate, Select, Skeleton, StatCard, StatusBadge, cn, focusRing, useI18n, useSession } from '@typease/ui';
import { SeriesChart, ShareBars } from '@/components/charts';
import { CentreCell, LoadError, Money, RelativeTime, RowsSkeleton, Section, TextLink } from '@/components/shared';
import { AccessStatusBadge } from '@/components/access-status';
import { HealthPill, healthProblems } from '@/components/health-bits';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformDashboard } from '@/lib/types';

/**
 * The home page. With `platform.metrics.read` (super admin): the SaaS figures of
 * GET /platform/dashboard and the reports. Without it (support agent): the agent's own
 * work, from the endpoints the role may call. Nothing is requested that would answer 403.
 */
export function Dashboard() {
  const session = useSession();
  return session.hasPermission('platform.metrics.read') ? <Overview /> : <AgentHome />;
}

// ---------------------------------------------------------------- super admin

function Overview() {
  const { t, formatNumber, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const dashboard = useQuery({ queryKey: keys.dashboard.summary, queryFn: ({ signal }) => api.dashboard(signal), placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const data = dashboard.data;
  const loading = dashboard.isPending;
  const tenants = data?.tenants;
  const n = (value: number | undefined) => (value === undefined ? '–' : formatNumber(value));

  const quiet: Array<{ id: keyof PlatformDashboard['tenants']; status: string }> = [
    { id: 'onboarding', status: 'ONBOARDING' },
    { id: 'pendingApproval', status: 'PENDING_APPROVAL' },
    { id: 'pastDue', status: 'PAST_DUE' },
    { id: 'cancelled', status: 'CANCELLED' },
    { id: 'archived', status: 'ARCHIVED' },
  ];

  return (
    <>
      <PageHeader
        title={t('dash.title')}
        description={t('dash.description')}
        action={
          <PermissionGate permission="platform.tenants.manage">
            <Button asChild variant="accent">
              <Link href="/tenants?add=1">
                <Plus aria-hidden="true" />
                {t('tenants.add.action')}
              </Link>
            </Button>
          </PermissionGate>
        }
      />

      {dashboard.isError ? <LoadError className="mb-4" lead={t('dash.loadError')} error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : null}

      {loading || data ? (
        <>
          <section aria-label={t('dash.centres.label')} className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              <StatCard label={t('dash.centres.total')} value={n(tenants?.total)} icon={<Building2 />} tone="brand" href="/tenants" loading={loading} />
              <StatCard label={t('dash.centres.active')} value={n(tenants?.active)} icon={<CheckCircle2 />} tone="success" href="/tenants?status=ACTIVE" loading={loading} />
              <StatCard label={t('dash.centres.trial')} value={n(tenants?.trial)} icon={<Hourglass />} tone="info" href="/tenants?status=TRIAL" loading={loading} />
              <StatCard label={t('dash.centres.suspended')} value={n(tenants?.suspended)} icon={<PauseCircle />} tone={(tenants?.suspended ?? 0) > 0 ? 'danger' : 'neutral'} href="/tenants?status=SUSPENDED" loading={loading} />
            </div>
            {tenants ? (
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                {quiet.map(({ id, status }) => (
                  <li key={id}>
                    <Link href={`/tenants?status=${status}`} className={cn('rounded-sm hover:text-foreground hover:underline', focusRing)}>
                      <span className={cn('tabular font-medium', tenants[id] > 0 && (id === 'pendingApproval' || id === 'pastDue') ? 'text-warning-text' : 'text-foreground')}>{formatNumber(tenants[id])}</span> {t(`dash.centres.${id}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section aria-label={t('dash.money.label')} className="mt-6 space-y-2">
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
              <RevenueTile kind="mrr" data={data} loading={loading} />
              <RevenueTile kind="arr" data={data} loading={loading} />
              <FigureTile
                icon={<TrendingDown />}
                tone={data && Number(data.churn.ratePercent ?? 0) > 0 ? 'warning' : 'neutral'}
                loading={loading}
                value={data ? (data.churn.ratePercent === null ? '–' : `${formatNumber(data.churn.ratePercent, { maximumFractionDigits: 2 })}%`) : ''}
                label={t('dash.money.churn')}
                hint={data ? (data.churn.activeAtStart === 0 ? t('dash.money.churnNone') : t('dash.money.churnHint', { churned: formatNumber(data.churn.churned), base: formatNumber(data.churn.activeAtStart) })) : ''}
              />
              <FigureTile
                icon={<Receipt />}
                tone={data && data.failedPayments.openInvoices > 0 ? 'danger' : 'neutral'}
                loading={loading}
                href={session.hasPermission('platform.billing.manage') ? '/subscriptions?tab=failed' : undefined}
                value={data ? formatNumber(data.failedPayments.openInvoices) : ''}
                label={t('dash.money.failed')}
                hint={
                  data ? (
                    data.failedPayments.amounts.length ? (
                      <>
                        {data.failedPayments.amounts.map((a, i) => (
                          <React.Fragment key={a.currency}>
                            {i > 0 ? ' · ' : null}
                            <Money amount={a.total} currency={a.currency} />
                          </React.Fragment>
                        ))}{' '}
                        {t('dash.money.failedOpen')}
                      </>
                    ) : (
                      t('dash.money.failedHint', { pastDue: formatNumber(data.failedPayments.subscriptionsPastDue), grace: formatNumber(data.failedPayments.subscriptionsInGrace) })
                    )
                  ) : (
                    ''
                  )
                }
              />
            </div>
            <p className="text-sm text-muted-foreground">{t('dash.money.note')}</p>
          </section>

          <div className="mt-6 grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
            <div className="min-w-0 space-y-6 xl:col-span-2">
              <GrowthCard />
              <RevenueCard />
              <UsageCard data={data} loading={loading} />
            </div>
            <div className="min-w-0 space-y-6">
              <AttentionCard data={data} loading={loading} />
              <PlansCard />
            </div>
          </div>

          {data ? (
            <p className="mt-6 text-sm text-muted-foreground">
              {t('dash.generated', { time: formatDateTime(data.generatedAt) })} {t('dash.autoRefresh')}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

const TILE_TONES: Record<'success' | 'info' | 'warning' | 'danger' | 'neutral', { card: string; tile: string }> = {
  success: { card: 'bg-success-soft/70 border-success/15', tile: 'bg-success text-success-foreground' },
  info: { card: 'bg-info-soft/70 border-info/15', tile: 'bg-info text-info-foreground' },
  warning: { card: 'bg-warning-soft/80 border-warning/25', tile: 'bg-warning text-warning-foreground' },
  danger: { card: 'bg-destructive-soft/70 border-destructive/15', tile: 'bg-destructive text-destructive-foreground' },
  neutral: { card: 'bg-card', tile: 'bg-muted text-muted-foreground' },
};

/** A figure in the look of StatCard, wide enough for an amount and a precise label with its qualifier. */
function FigureTile({ icon, tone, value, label, hint, href, loading }: { icon: React.ReactNode; tone: keyof typeof TILE_TONES; value: React.ReactNode; label: string; hint?: React.ReactNode; href?: string; loading?: boolean }) {
  const tones = TILE_TONES[tone];
  const body = (
    <>
      <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-[0.625rem] [&_svg]:size-5', tones.tile)}>
        {icon}
      </span>
      <span className="min-w-0">
        {loading ? <Skeleton className="mb-1.5 h-7 w-24 bg-foreground/10" /> : <span className="tabular block text-2xl font-semibold leading-8 text-foreground">{value}</span>}
        <span className="mt-0.5 block text-sm font-medium leading-[1.15rem] text-foreground/80">{label}</span>
        {hint && !loading ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </>
  );
  const classes = cn('flex items-center gap-4 rounded-lg border p-4', tones.card);
  return href ? (
    <Link href={href} className={cn(classes, 'transition-shadow hover:shadow-sm', focusRing)}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

/** MRR or ARR as the API computed it: one line per plan currency, never added across currencies. */
function RevenueTile({ kind, data, loading }: { kind: 'mrr' | 'arr'; data: PlatformDashboard | undefined; loading: boolean }) {
  const { t, tn } = useI18n();
  const lines = data?.revenue ?? [];
  const first = lines[0];
  return (
    <FigureTile
      icon={kind === 'mrr' ? <CircleDollarSign /> : <TrendingUp />}
      tone={kind === 'mrr' ? 'success' : 'info'}
      loading={loading}
      value={first ? <Money amount={first[kind]} currency={first.currency} /> : '–'}
      label={t(`dash.money.${kind}`)}
      hint={
        first ? (
          <>
            {lines.slice(1).map((line) => (
              <React.Fragment key={line.currency}>
                <Money amount={line[kind]} currency={line.currency} />
                {' · '}
              </React.Fragment>
            ))}
            {kind === 'mrr' ? tn('dash.money.paying', first.subscriptions) : t('dash.money.arrHint')}
          </>
        ) : (
          t('dash.money.noPaying')
        )
      }
    />
  );
}

function AttentionCard({ data, loading }: { data: PlatformDashboard | undefined; loading: boolean }) {
  const { t, tn, formatDate, formatNumber } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const billing = session.hasPermission('platform.billing.manage');
  // Trials are listed soonest first; `currentPeriodEnd` of a trial is its end.
  const trials = useQuery({
    queryKey: keys.dashboard.trials,
    queryFn: ({ signal }) => api.billing.subscriptions({ status: 'TRIALING', sort: 'currentPeriodEnd:asc', pageSize: 20 }, signal),
    enabled: billing,
    staleTime: 60_000,
  });
  const failed = useQuery({ queryKey: keys.dashboard.failedPayments, queryFn: ({ signal }) => api.reports.failedPayments({ pageSize: 5 }, signal), enabled: !!data && data.failedPayments.openInvoices > 0, staleTime: 60_000 });
  const [soon, setSoon] = React.useState<number | null>(null);
  React.useEffect(() => setSoon(Date.now() + 7 * 86_400_000), [trials.dataUpdatedAt]);
  const ending = (trials.data?.data ?? []).filter((s) => s.trialEndsAt && soon !== null && new Date(s.trialEndsAt).getTime() <= soon);

  if (loading || !data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t('dash.attention.title')}</CardTitle>
        </CardHeader>
        <RowsSkeleton className="border-t" />
      </Card>
    );
  }

  const health = data.systemHealth;
  const tickets = data.supportTickets;
  const rows: React.ReactNode[] = [];

  if (health.status !== 'ok') {
    rows.push(
      <AttentionRow key="health" icon={<Activity />} tone={health.status === 'down' ? 'danger' : 'warning'} href="/system-health" title={t(`dash.attention.health.${health.status}`)}>
        {tn('dash.attention.healthProblems', healthProblems(health).length)}
      </AttentionRow>,
    );
  }
  if (data.tenants.pendingApproval > 0) {
    rows.push(
      <AttentionRow key="approval" icon={<Building2 />} tone="warning" href="/tenants?status=PENDING_APPROVAL" title={tn('dash.attention.pendingApproval', data.tenants.pendingApproval)}>
        {t('dash.attention.pendingApprovalText')}
      </AttentionRow>,
    );
  }
  if (data.failedPayments.openInvoices > 0) {
    rows.push(
      <AttentionRow key="failed" icon={<Receipt />} tone="danger" href={billing ? '/subscriptions?tab=failed' : undefined} title={tn('dash.attention.failedPayments', data.failedPayments.openInvoices)}>
        {failed.data?.data.length ? (
          <ul className="mt-1 space-y-1">
            {failed.data.data.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 truncate">
                  <bdi>{row.centre.name}</bdi> · <span className="tabular ltr-value">{row.number}</span>
                </span>
                <Money amount={row.total} currency={row.currency} className="font-medium text-foreground" />
              </li>
            ))}
          </ul>
        ) : (
          t('dash.attention.failedPaymentsText', { pastDue: formatNumber(data.failedPayments.subscriptionsPastDue), grace: formatNumber(data.failedPayments.subscriptionsInGrace) })
        )}
      </AttentionRow>,
    );
  }
  if (ending.length) {
    rows.push(
      <AttentionRow key="trials" icon={<Hourglass />} tone="info" href="/subscriptions?status=TRIALING&sort=currentPeriodEnd%3Aasc" title={tn('dash.attention.trialsEnding', ending.length)}>
        <ul className="mt-1 space-y-1">
          {ending.slice(0, 5).map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 truncate">
                <bdi>{s.tenant.name}</bdi> · {s.plan.name}
              </span>
              <span className="tabular">{formatDate(s.trialEndsAt)}</span>
            </li>
          ))}
        </ul>
      </AttentionRow>,
    );
  }
  if (tickets.open > 0) {
    rows.push(
      <AttentionRow key="tickets" icon={<LifeBuoy />} tone="info" href={session.hasPermission('platform.support.manage') ? '/support' : undefined} title={tn('dash.attention.openTickets', tickets.open)}>
        {t('dash.attention.openTicketsText', { open: formatNumber(tickets.byStatus.OPEN ?? 0), progress: formatNumber(tickets.byStatus.IN_PROGRESS ?? 0), waiting: formatNumber(tickets.byStatus.WAITING_CUSTOMER ?? 0) })}
      </AttentionRow>,
    );
  }

  return (
    <Card>
      <CardHeader className="items-center pb-3">
        <CardTitle className="text-lg">{t('dash.attention.title')}</CardTitle>
        <HealthPill health={health} />
      </CardHeader>
      {rows.length ? <ul className="divide-y border-t">{rows}</ul> : <EmptyState className="border-t" icon={<CheckCircle2 />} title={t('dash.attention.empty')} description={t('dash.attention.emptyText')} />}
    </Card>
  );
}

function AttentionRow({ icon, tone, title, href, children }: { icon: React.ReactNode; tone: 'danger' | 'warning' | 'info'; title: string; href?: string; children?: React.ReactNode }) {
  const tones = { danger: 'bg-destructive-soft text-destructive-text', warning: 'bg-warning-soft text-warning-text', info: 'bg-info-soft text-info-text' }[tone];
  return (
    <li className="flex gap-3 px-5 py-3.5">
      <span aria-hidden="true" className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4', tones)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{href ? <TextLink href={href}>{title}</TextLink> : title}</p>
        {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      </div>
    </li>
  );
}

function ChartCard({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="min-w-0">
          <CardTitle className="text-lg">{title}</CardTitle>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </CardHeader>
      <div className="p-5 pt-3">{children}</div>
    </Card>
  );
}

function GrowthCard() {
  const { t } = useI18n();
  const api = usePlatformApi();
  const growth = useQuery({ queryKey: keys.dashboard.growth, queryFn: ({ signal }) => api.reports.tenantGrowth(signal), staleTime: 5 * 60_000 });
  return (
    <ChartCard title={t('dash.growth.title')} description={t('dash.growth.description')}>
      {growth.isPending ? (
        <Skeleton className="h-56 w-full" />
      ) : growth.isError ? (
        <LoadError error={growth.error} onRetry={() => void growth.refetch()} />
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">{t('dash.growth.new')}</h3>
            <SeriesChart type="bar" data={growth.data.series} xKey="period" xType="month" label={t('dash.growth.new')} series={[{ key: 'new', label: t('dash.growth.new') }]} />
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">{t('dash.growth.total')}</h3>
            <SeriesChart type="line" data={growth.data.series} xKey="period" xType="month" label={t('dash.growth.total')} series={[{ key: 'total', label: t('dash.growth.total') }]} />
          </div>
        </div>
      )}
    </ChartCard>
  );
}

function RevenueCard() {
  const { t, tn } = useI18n();
  const api = usePlatformApi();
  const revenue = useQuery({ queryKey: keys.dashboard.revenue, queryFn: ({ signal }) => api.reports.revenue(signal), staleTime: 5 * 60_000 });
  const currencies = React.useMemo(() => [...new Set((revenue.data?.series ?? []).flatMap((p) => p.lines.map((l) => l.currency)))], [revenue.data]);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const currency = chosen && currencies.includes(chosen) ? chosen : currencies[0];
  // One currency per chart: amounts in different currencies are never drawn on one axis.
  const rows = React.useMemo(() => (revenue.data?.series ?? []).map((p) => ({ period: p.period, total: p.lines.find((l) => l.currency === currency)?.total ?? '0.00' })), [revenue.data, currency]);
  const total = revenue.data?.totals.find((line) => line.currency === currency);
  return (
    <ChartCard
      title={t('dash.revenue.title')}
      description={
        <>
          {t('dash.revenue.description')}
          {total ? (
            <>
              {' '}
              <Money amount={total.total} currency={total.currency} className="font-medium text-foreground" /> {tn('dash.revenue.invoices', total.invoices)}
            </>
          ) : null}
        </>
      }
    >
      {revenue.isPending ? (
        <Skeleton className="h-56 w-full" />
      ) : revenue.isError ? (
        <LoadError error={revenue.error} onRetry={() => void revenue.refetch()} />
      ) : !currency ? (
        <EmptyState icon={<Receipt />} title={t('dash.revenue.empty')} />
      ) : (
        <>
          {currencies.length > 1 ? (
            <Select aria-label={t('dash.revenue.currency')} size="sm" className="mb-3 w-32" value={currency} onValueChange={setChosen} options={currencies.map((c) => ({ value: c, label: c }))} />
          ) : null}
          <SeriesChart type="bar" data={rows} xKey="period" xType="month" valueType="money" currency={currency} label={t('dash.revenue.title')} series={[{ key: 'total', label: t('dash.revenue.series') }]} />
        </>
      )}
    </ChartCard>
  );
}

function PlansCard() {
  const { t, tn, formatNumber } = useI18n();
  const api = usePlatformApi();
  const plans = useQuery({ queryKey: keys.dashboard.distribution, queryFn: ({ signal }) => api.reports.planDistribution(signal), staleTime: 5 * 60_000 });
  // All subscriptions of a plan, whatever their state (the API's `subscriptions` counts the paying ones only).
  const items = (plans.data?.plans ?? []).map((p) => ({ name: p.planName, value: Object.values(p.byStatus).reduce<number>((sum, count) => sum + (count ?? 0), 0), paying: p.subscriptions }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="min-w-0">
          <CardTitle className="text-lg">{t('dash.plans.title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('dash.plans.description')}</p>
        </div>
      </CardHeader>
      <div className="p-5 pt-3">
        {plans.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : plans.isError ? (
          <LoadError error={plans.error} onRetry={() => void plans.refetch()} />
        ) : items.every((item) => item.value === 0) ? (
          <EmptyState title={t('dash.plans.empty')} />
        ) : (
          <>
            <ShareBars label={t('dash.plans.title')} items={items.map((item) => ({ name: item.name, value: item.value, display: formatNumber(item.value) }))} />
            <p className="mt-4 text-sm text-muted-foreground">
              {tn('dash.plans.paying', items.reduce((sum, item) => sum + item.paying, 0))}
              {plans.data.centresWithoutSubscription > 0 ? ` · ${tn('dash.plans.without', plans.data.centresWithoutSubscription)}` : ''}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function UsageCard({ data, loading }: { data: PlatformDashboard | undefined; loading: boolean }) {
  const { t, formatNumber, formatFileSize, has } = useI18n();
  const api = usePlatformApi();
  const usage = useQuery({ queryKey: keys.dashboard.usage, queryFn: ({ signal }) => api.reports.usage(signal), staleTime: 5 * 60_000 });
  const month = data?.usage;
  const channels = Object.entries(month?.notifications.deliveriesByChannel ?? {});
  const figures: Array<{ id: string; value: string; note?: React.ReactNode }> = month
    ? [
        { id: 'storage', value: formatFileSize(month.storage.bytes) },
        { id: 'requests', value: formatNumber(month.requests) },
        { id: 'notifications', value: formatNumber(month.notifications.counted) },
        {
          id: 'aiPages',
          value: formatNumber(month.ai.pages),
          note: month.ai.cost.length ? month.ai.cost.map((c) => <Money key={c.currency} amount={c.estimate} currency={c.currency} />) : undefined,
        },
      ]
    : [];
  return (
    <ChartCard title={t('dash.usage.title')} description={t('dash.usage.description')}>
      {loading || !month ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
          {figures.map((figure) => (
            <div key={figure.id} className="min-w-0">
              <dt className="text-sm text-muted-foreground">{t(`dash.usage.${figure.id}`)}</dt>
              <dd className="tabular ltr-value mt-0.5 text-xl font-semibold text-foreground">{figure.value}</dd>
              {figure.note ? (
                <dd className="text-xs text-muted-foreground">
                  {t('dash.usage.aiCost')} {figure.note}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      )}

      {channels.length ? (
        <div className="mt-5 border-t pt-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">{t('dash.usage.deliveries')}</h3>
          <ul className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            {channels.map(([channel, counts]) => (
              <li key={channel} className="flex items-center gap-2">
                <span className="font-medium text-foreground">{has(`dash.usage.channels.${channel}`) ? t(`dash.usage.channels.${channel}`) : channel}</span>
                <span className="text-muted-foreground">{t('dash.usage.sent', { count: formatNumber(counts.sent) })}</span>
                {counts.failed > 0 ? <Badge tone="danger">{t('dash.usage.failed', { count: formatNumber(counts.failed) })}</Badge> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 grid gap-8 border-t pt-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold text-foreground">{t('dash.usage.requestsTrend')}</h3>
          {usage.isPending ? (
            <Skeleton className="h-44 w-full" />
          ) : usage.isError ? (
            <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
          ) : (
            <SeriesChart
              type="bar"
              height={180}
              data={usage.data.series}
              xKey="period"
              xType="month"
              label={t('dash.usage.requestsTrend')}
              series={[
                { key: 'requests', label: t('dash.usage.requests') },
                { key: 'notifications', label: t('dash.usage.notifications') },
              ]}
            />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold text-foreground">{t('dash.usage.topStorage')}</h3>
          {usage.isPending ? (
            <Skeleton className="h-44 w-full" />
          ) : usage.isError ? null : usage.data.storage.topCentres.length ? (
            <ShareBars label={t('dash.usage.topStorage')} items={usage.data.storage.topCentres.slice(0, 6).map((row) => ({ name: row.centre.name, value: row.bytes, display: formatFileSize(row.bytes) }))} />
          ) : (
            <p className="text-sm text-muted-foreground">{t('dash.usage.noStorage')}</p>
          )}
        </div>
      </div>
    </ChartCard>
  );
}

// ---------------------------------------------------------------- support agent

function AgentHome() {
  const { t, tn } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const first = session.user?.fullName.trim().split(/\s+/)[0];
  const maySupport = session.hasPermission('platform.support.manage');
  const mayAccess = session.hasPermission('platform.access.request');
  const tickets = useQuery({ queryKey: [...keys.tickets.open, 'home'], queryFn: ({ signal }) => api.tickets.list({ open: true, pageSize: 6, sort: 'updatedAt:desc' }, signal), enabled: maySupport, refetchInterval: 60_000 });
  const grants = useQuery({ queryKey: [...keys.access.all, 'home'], queryFn: ({ signal }) => api.access.list({ pageSize: 6 }, signal), enabled: mayAccess, refetchInterval: 60_000 });

  return (
    <>
      <PageHeader title={first ? t('dash.agent.greeting', { name: first }) : t('dash.agent.title')} description={t('dash.agent.description')} />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        {maySupport ? (
          <Section
            flush
            title={t('dash.agent.tickets')}
            description={tickets.data ? tn('dash.agent.ticketsOpen', tickets.data.meta.total) : undefined}
            action={
              <Button asChild variant="link">
                <Link href="/support">{t('common.viewAll')}</Link>
              </Button>
            }
          >
            {tickets.isPending ? (
              <RowsSkeleton />
            ) : tickets.isError ? (
              <LoadError className="m-4" error={tickets.error} onRetry={() => void tickets.refetch()} />
            ) : tickets.data.data.length ? (
              <ul className="divide-y">
                {tickets.data.data.map((ticket) => (
                  <li key={ticket.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <TextLink href={`/support/${ticket.id}`}>
                        <span dir="auto">{ticket.subject}</span>
                      </TextLink>
                      <p className="truncate text-sm text-muted-foreground">
                        <span className="tabular ltr-value">{ticket.ticketNo}</span> · <bdi>{ticket.tenant.name}</bdi>
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <StatusBadge kind="ticket" status={ticket.status} />
                      <RelativeTime value={ticket.updatedAt} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<LifeBuoy />} title={t('dash.agent.ticketsEmpty')} description={t('dash.agent.ticketsEmptyText')} />
            )}
          </Section>
        ) : null}

        {mayAccess ? (
          <Section
            flush
            title={t('dash.agent.access')}
            description={t('dash.agent.accessText')}
            action={
              <Button asChild variant="link">
                <Link href="/access-requests">{t('common.viewAll')}</Link>
              </Button>
            }
          >
            {grants.isPending ? (
              <RowsSkeleton />
            ) : grants.isError ? (
              <LoadError className="m-4" error={grants.error} onRetry={() => void grants.refetch()} />
            ) : grants.data.data.length ? (
              <ul className="divide-y">
                {grants.data.data.map((grant) => (
                  <li key={grant.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <CentreCell centre={grant.centre} />
                      <p className="mt-0.5 truncate text-sm text-muted-foreground" dir="auto">
                        {grant.reason}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <AccessStatusBadge grant={grant} />
                      <RelativeTime value={grant.createdAt} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<KeyRound />} title={t('dash.agent.accessEmpty')} description={t('dash.agent.accessEmptyText')} />
            )}
          </Section>
        ) : null}
      </div>
      <p className="mt-6 flex items-start gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t('dash.agent.note')}
      </p>
    </>
  );
}
