'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlarmClock, Banknote, BellRing, CheckCircle2, ClipboardList, FileSearch, FileUp, HandCoins, Inbox, ListChecks, Loader, PlayCircle, Plus, Receipt, Search, UserPlus, UserRoundCheck,
  UserRoundSearch, Users, Wallet,
} from 'lucide-react';
import {
  Alert, Badge, Button, Card, CardHeader, CardTitle, DatePicker, EmptyState, PageHeader, PermissionGate, Select, Skeleton, StatCard, StatusBadge, addDays, cn, focusRing, useBranding,
  useErrorMessage, useI18n, useSession, type Tone,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';
import { useFinApi } from '@/components/fin/api';
import { SeriesChart } from '@/components/fin/charts';
import { Money, TextLink } from '@/components/fin/shared';
import type { DashboardResponse, RequestBucketKey } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

/** The four headline tiles of the reference dashboard, then four quieter ones. */
const PRIMARY: Array<{ bucket: RequestBucketKey; icon: React.ReactNode; tone: Tone }> = [
  { bucket: 'newRequests', icon: <Inbox />, tone: 'info' },
  { bucket: 'inProgress', icon: <Loader />, tone: 'warning' },
  { bucket: 'completedToday', icon: <CheckCircle2 />, tone: 'success' },
  { bucket: 'awaitingPayment', icon: <Wallet />, tone: 'danger' },
];
const SECONDARY: Array<{ bucket: RequestBucketKey; icon: React.ReactNode }> = [
  { bucket: 'pendingVerification', icon: <FileSearch /> },
  { bucket: 'awaitingCustomer', icon: <UserRoundSearch /> },
  { bucket: 'readyForProcessing', icon: <PlayCircle /> },
  { bucket: 'overdue', icon: <AlarmClock /> },
];

type Preset = 'now' | '7' | '30' | 'month' | 'custom';
const ALL_BRANCHES = '__all__';

/** Operational dashboard (spec section 10), driven by GET /dashboard and GET /dashboard/trends. */
export function Dashboard() {
  const { t, tn, pick, formatNumber, formatDate, today } = useI18n();
  const api = useFinApi();
  const describe = useErrorMessage();
  const session = useSession();
  const { branchId, setBranchId } = useBranch();
  const branches = useBranches();
  const { tenant, user } = useSessionNames();

  const [preset, setPreset] = React.useState<Preset>('now');
  const [custom, setCustom] = React.useState<{ from: string; to: string }>({ from: '', to: '' });
  const period = React.useMemo(() => {
    const end = today();
    if (preset === '7') return { from: addDays(end, -6), to: end };
    if (preset === '30') return { from: addDays(end, -29), to: end };
    if (preset === 'month') return { from: `${end.slice(0, 8)}01`, to: end };
    if (preset === 'custom' && (custom.from || custom.to)) return { from: custom.from || undefined, to: custom.to || undefined };
    return {};
  }, [preset, custom, today]);
  const params = React.useMemo(() => ({ branchId, ...period }), [branchId, period]);

  const dashboard = useQuery({ queryKey: finKeys.dashboard.summary(params), queryFn: ({ signal }) => api.dashboard(params, signal), placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const trends = useQuery({ queryKey: finKeys.dashboard.trends(params), queryFn: ({ signal }) => api.dashboardTrends(params, signal), placeholderData: keepPreviousData });

  const data = dashboard.data;
  const requests = data?.requests ?? null;
  const finance = data?.finance ?? null;
  const loading = dashboard.isPending;
  const count = (bucket: RequestBucketKey) => (requests ? formatNumber(requests[bucket]) : '–');
  const hasPeriod = !!(period.from || period.to);

  const quickActions = [
    { key: 'addCustomer', href: '/customers?add=1', icon: <UserPlus />, anyOf: ['customer.create'] },
    { key: 'searchCustomer', href: '/customers', icon: <Search />, anyOf: ['customer.read'] },
    { key: 'uploadDocument', href: '/documents', icon: <FileUp />, anyOf: ['document.upload'] },
    { key: 'createInvoice', href: '/invoices/new', icon: <Receipt />, anyOf: ['invoice.manage'] },
    { key: 'assignCase', href: '/requests?bucket=newRequests', icon: <UserRoundCheck />, anyOf: ['request.assign'] },
    { key: 'pendingTasks', href: '/tasks', icon: <ListChecks />, anyOf: ['task.read', 'task.manage'] },
  ].filter((a) => session.hasAnyPermission(a.anyOf));

  return (
    <>
      <PageHeader
        title={user ? t('dashboard.greeting', { name: user }) : t('dashboard.title')}
        description={tenant ? t('dashboard.description', { centre: tenant }) : undefined}
        action={
          <PermissionGate permission="request.create">
            <Button asChild variant="accent" size="lg">
              <Link href="/requests/new">
                <Plus aria-hidden="true" />
                {t('dashboard.newRequest')}
              </Link>
            </Button>
          </PermissionGate>
        }
      />

      {quickActions.length ? (
        <nav aria-label={t('fin.dashboard.quickActions')} className="-mt-2 mb-5">
          <ul className="scroll-quiet -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {quickActions.map((action) => (
              <li key={action.key} className="shrink-0">
                <Button asChild variant="outline" size="sm" className="h-9 [&_svg]:text-muted-foreground">
                  <Link href={action.href}>
                    {action.icon}
                    {t(`fin.dashboard.actions.${action.key}`)}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {/* Branch and period */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        {branches.data && branches.data.length > 1 ? (
          <Select
            aria-label={t('shell.branch')}
            className="w-full sm:w-52"
            value={branchId ?? ALL_BRANCHES}
            onValueChange={(v) => setBranchId(v === ALL_BRANCHES ? undefined : v)}
            options={[{ value: ALL_BRANCHES, label: t('shell.allBranches') }, ...branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
          />
        ) : null}
        <Select
          aria-label={t('fin.dashboard.period.label')}
          className="w-full sm:w-52"
          value={preset}
          onValueChange={(v) => setPreset(v as Preset)}
          options={(['now', '7', '30', 'month', 'custom'] as const).map((p) => ({ value: p, label: t(`fin.dashboard.period.${p}`) }))}
        />
        {preset === 'custom' ? (
          <fieldset className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <legend className="sr-only">{t('fin.dashboard.period.label')}</legend>
            <DatePicker aria-label={t('common.from')} value={custom.from} max={custom.to || today()} onChange={(from) => setCustom((c) => ({ ...c, from }))} className="min-w-0 flex-1 sm:w-40 sm:flex-none" />
            <span aria-hidden="true" className="text-muted-foreground">
              –
            </span>
            <DatePicker aria-label={t('common.to')} value={custom.to} min={custom.from || undefined} max={today()} onChange={(to) => setCustom((c) => ({ ...c, to }))} className="min-w-0 flex-1 sm:w-40 sm:flex-none" />
          </fieldset>
        ) : null}
        {hasPeriod && requests?.range ? (
          <p className="basis-full text-sm text-muted-foreground">
            {t('fin.dashboard.period.note', { from: formatDate(requests.range.from), to: formatDate(requests.range.to) })} {tn('fin.dashboard.period.created', requests.range.created)}, {tn('fin.dashboard.period.completed', requests.range.completed)}.
          </p>
        ) : null}
      </div>

      {dashboard.isError ? (
        <Alert tone="danger" className="mb-4" action={<Button size="sm" variant="outline" onClick={() => void dashboard.refetch()}>{t('common.retry')}</Button>}>
          {t('dashboard.countsError')} {describe(dashboard.error)}
        </Alert>
      ) : null}

      {/* Requests */}
      {loading || requests ? (
        <section aria-label={t('nav.requests')} className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {PRIMARY.map(({ bucket, icon, tone }) => (
              <StatCard key={bucket} label={t(`dashboard.buckets.${bucket}`)} value={count(bucket)} icon={icon} tone={tone} href={`/requests?bucket=${bucket}`} loading={loading} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {SECONDARY.map(({ bucket, icon }) => (
              <StatCard
                key={bucket}
                label={t(`dashboard.buckets.${bucket}`)}
                value={count(bucket)}
                icon={icon}
                // "Overdue" only raises its voice when there is something overdue.
                tone={bucket === 'overdue' && (requests?.overdue ?? 0) > 0 ? 'danger' : 'neutral'}
                href={`/requests?bucket=${bucket}`}
                loading={loading}
              />
            ))}
          </div>
          {requests ? (
            <p className="text-sm text-muted-foreground">
              {tn('dashboard.openTotal', requests.open)}
              {requests.drafts > 0 ? `, ${tn('dashboard.drafts', requests.drafts)}` : ''}
              {data?.scope.requests === 'ASSIGNED' ? ` · ${t('fin.dashboard.ownCases')}` : ''}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Money: earned service revenue is never mixed with cash collected (which includes fees held for others). */}
      {finance ? (
        <section aria-label={t('fin.dashboard.money.title')} className="mt-6 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
            <MoneyTile icon={<HandCoins />} tone="success" label={t('fin.dashboard.money.serviceRevenue')} hint={t('fin.dashboard.money.serviceRevenueHint')} amount={finance.serviceRevenueToday} currency={data?.currency} href={session.hasPermission('report.financial') ? '/reports/daily-sales' : undefined} />
            {finance.grossCollectionsToday !== null ? (
              <MoneyTile icon={<Banknote />} tone="info" label={t('fin.dashboard.money.grossCollections')} hint={t('fin.dashboard.money.grossCollectionsHint')} amount={finance.grossCollectionsToday} currency={data?.currency} href={session.hasPermission('payment.read') ? `/payments?from=${data?.today}&to=${data?.today}` : undefined} />
            ) : null}
            <MoneyTile
              icon={<Receipt />}
              tone="warning"
              label={t('fin.dashboard.money.receivables')}
              hint={tn('fin.dashboard.money.receivablesHint', finance.openInvoices)}
              amount={finance.outstandingReceivables}
              currency={data?.currency}
              href={session.hasPermission('report.financial') ? '/reports/outstanding-payments' : '/invoices?status=ISSUED'}
            />
          </div>
          {Number(finance.otherRevenueToday) > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('fin.dashboard.money.otherRevenue')} <Money amount={finance.otherRevenueToday} currency={data?.currency} className="font-medium text-foreground" />
            </p>
          ) : null}
          {finance.range ? (
            <p className="text-sm text-muted-foreground">
              {t('fin.dashboard.money.inPeriod', { from: formatDate(finance.range.from), to: formatDate(finance.range.to) })} {t('fin.dashboard.money.serviceRevenueShort')}{' '}
              <Money amount={finance.range.serviceRevenue} currency={data?.currency} className="font-medium text-foreground" />
              {finance.range.grossCollections !== null ? (
                <>
                  {' · '}
                  {t('fin.dashboard.money.grossCollectionsShort')} <Money amount={finance.range.grossCollections} currency={data?.currency} className="font-medium text-foreground" />
                </>
              ) : null}
            </p>
          ) : null}
          <details className="text-sm text-muted-foreground">
            <summary className={cn('inline cursor-pointer rounded-sm text-secondary-text hover:underline', focusRing)}>{t('fin.dashboard.money.how')}</summary>
            <ul className="mt-2 list-disc space-y-1 ps-5" dir="auto">
              <li>{t('fin.dashboard.money.howRevenue')}</li>
              <li>{t('fin.dashboard.money.howCollections')}</li>
              <li>{t('fin.dashboard.money.howPassThrough')}</li>
              {data?.scope.finance === 'OWN_CASES' ? <li>{t('fin.dashboard.money.ownCases')}</li> : null}
            </ul>
          </details>
        </section>
      ) : null}

      <div className="mt-6 grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
        {/* Trends */}
        <Card>
          <CardHeader className="pb-2">
            <div>
              <CardTitle className="text-lg">{t('fin.dashboard.trends.title')}</CardTitle>
              {trends.data ? <p className="mt-1 text-sm text-muted-foreground">{t('fin.dashboard.trends.range', { from: formatDate(trends.data.from), to: formatDate(trends.data.to) })}</p> : null}
            </div>
          </CardHeader>
          <div className="p-5 pt-3">
            {trends.isPending ? (
              <Skeleton className="h-56 w-full" />
            ) : trends.isError ? (
              <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void trends.refetch()}>{t('common.retry')}</Button>}>
                {describe(trends.error)}
              </Alert>
            ) : (
              <TrendCharts days={trends.data.days} currency={trends.data.currency} />
            )}
          </div>
        </Card>

        {/* Recent activity */}
        {loading || data?.recentActivity ? (
          <Card>
            <CardHeader className="items-center pb-3">
              <CardTitle className="text-lg">{t('fin.dashboard.activity.title')}</CardTitle>
              <Button asChild variant="link">
                <Link href="/requests">{t('common.viewAll')}</Link>
              </Button>
            </CardHeader>
            {loading ? (
              <ListSkeleton />
            ) : data?.recentActivity?.length ? (
              <ul className="divide-y border-t">
                {data.recentActivity.slice(0, 8).map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <TextLink href={`/requests/${a.requestId}`} className="tabular">
                        {a.requestNo}
                      </TextLink>
                      <span className="ms-2 inline-flex align-middle">
                        <StatusBadge kind="request" status={a.to} label={a.toLabel} />
                      </span>
                      <p className="truncate text-sm text-muted-foreground">
                        <bdi>{a.customerName ?? a.customerNo}</bdi> · <bdi>{a.serviceName}</bdi>
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground sm:text-end">
                      <span className="block text-foreground/80">{a.actorName ?? t(`fin.dashboard.activity.actors.${actorKey(a.actorType)}`)}</span>
                      <RelativeTime value={a.at} />
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState className="border-t" icon={<ClipboardList />} title={t('dashboard.recentEmpty')} description={t('dashboard.recentEmptyText')} />
            )}
          </Card>
        ) : null}

        </div>
        <div className="min-w-0 space-y-6">
        {/* Staff workload */}
        {loading || data?.staffWorkload ? (
          <Card>
            <CardHeader className="items-center pb-3">
              <CardTitle className="text-lg">{t('fin.dashboard.workload.title')}</CardTitle>
              {session.hasPermission('report.operational') ? (
                <Button asChild variant="link">
                  <Link href="/reports/staff-workload">{t('fin.dashboard.workload.report')}</Link>
                </Button>
              ) : null}
            </CardHeader>
            {loading ? (
              <ListSkeleton />
            ) : (
              <WorkloadList workload={data?.staffWorkload as NonNullable<DashboardResponse['staffWorkload']>} />
            )}
          </Card>
        ) : null}
        {/* Upcoming expiries */}
        {data?.upcomingExpiries ? (
          <Card>
            <CardHeader className="items-center pb-3">
              <div>
                <CardTitle className="text-lg">{t('fin.dashboard.expiries.title')}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{tn('fin.dashboard.expiries.within', data.upcomingExpiries.total, { days: data.upcomingExpiries.withinDays })}</p>
              </div>
              <Button asChild variant="link">
                <Link href="/reminders">{t('common.viewAll')}</Link>
              </Button>
            </CardHeader>
            {data.upcomingExpiries.items.length ? (
              <ul className="divide-y border-t">
                {data.upcomingExpiries.items.map((item) => (
                  <li key={item.scheduleId} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{pick(item.documentTypeName, item.documentTypeNameAr)}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {item.customerId ? (
                          <TextLink href={`/reminders?customerId=${item.customerId}`} className="font-normal">
                            <bdi>{item.customerName ?? item.customerNo}</bdi>
                          </TextLink>
                        ) : (
                          <bdi>{item.subjectLabel}</bdi>
                        )}
                        {' · '}
                        <bdi className="tabular">{formatDate(item.expiryDate)}</bdi>
                      </p>
                    </div>
                    <Badge tone={item.daysLeft <= 7 ? 'danger' : item.daysLeft <= 14 ? 'warning' : 'neutral'}>{tn('fin.dashboard.expiries.daysLeft', item.daysLeft)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState className="border-t" icon={<BellRing />} title={t('fin.dashboard.expiries.empty')} />
            )}
          </Card>
        ) : null}
        </div>
      </div>
    </>
  );
}

const actorKey = (type: string) => (type === 'CUSTOMER' ? 'customer' : type === 'CORPORATE' ? 'corporate' : type === 'STAFF' ? 'staff' : 'system');

/** "3 hours ago", written after mount: relative time depends on the clock and must not differ between server and browser. */
function RelativeTime({ value }: { value: string }) {
  const { formatRelative, formatDateTime } = useI18n();
  const [text, setText] = React.useState('');
  React.useEffect(() => setText(formatRelative(value)), [value, formatRelative]);
  return (
    <time dateTime={value} title={formatDateTime(value)} className="tabular">
      {text || formatDateTime(value)}
    </time>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3 border-t p-5" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** A money tile in the look of StatCard, wide enough for an amount and a precise label. */
function MoneyTile({ icon, tone, label, hint, amount, currency, href }: { icon: React.ReactNode; tone: 'success' | 'info' | 'warning'; label: string; hint: string; amount: string; currency?: string; href?: string }) {
  const tones = {
    success: { card: 'bg-success-soft/70 border-success/15', tile: 'bg-success text-success-foreground' },
    info: { card: 'bg-info-soft/70 border-info/15', tile: 'bg-info text-info-foreground' },
    warning: { card: 'bg-warning-soft/80 border-warning/25', tile: 'bg-warning text-warning-foreground' },
  }[tone];
  const body = (
    <>
      <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-[0.625rem] [&_svg]:size-5', tones.tile)}>
        {icon}
      </span>
      <span className="min-w-0">
        <Money amount={amount} currency={currency} className="block text-2xl font-semibold leading-8 text-foreground" />
        <span className="mt-0.5 block text-sm font-medium leading-[1.15rem] text-foreground/80">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
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

function WorkloadList({ workload }: { workload: NonNullable<DashboardResponse['staffWorkload']> }) {
  const { t, tn, formatNumber } = useI18n();
  const max = Math.max(1, ...workload.staff.map((s) => s.openRequests));
  return (
    <>
      {workload.unassignedRequests ? (
        <p className="flex items-center justify-between gap-3 border-t bg-warning-soft/60 px-5 py-2.5 text-sm">
          <span>{tn('fin.dashboard.workload.unassigned', workload.unassignedRequests)}</span>
          <PermissionGate permission="request.assign">
            <TextLink href="/requests?bucket=newRequests">{t('fin.dashboard.actions.assignCase')}</TextLink>
          </PermissionGate>
        </p>
      ) : null}
      {workload.staff.length ? (
        <ul className="divide-y border-t">
          {workload.staff.slice(0, 8).map((member) => (
            <li key={member.membershipId} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-medium text-foreground">{member.name}</p>
                <p className="tabular shrink-0 text-sm text-foreground">{tn('fin.dashboard.workload.open', member.openRequests)}</p>
              </div>
              <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-secondary" style={{ width: `${(member.openRequests / max) * 100}%` }} />
              </div>
              <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>{member.roleName}</span>
                {member.overdueRequests > 0 ? <span className="font-medium text-destructive-text">{tn('fin.dashboard.workload.overdue', member.overdueRequests)}</span> : null}
                {member.highPriorityRequests > 0 ? <span>{tn('fin.dashboard.workload.highPriority', member.highPriorityRequests)}</span> : null}
                <span>
                  {tn('fin.dashboard.workload.tasks', member.openTasks)}
                  {member.overdueTasks > 0 ? ` (${t('fin.dashboard.workload.tasksOverdue', { count: formatNumber(member.overdueTasks) })})` : ''}
                </span>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState className="border-t" icon={<Users />} title={t('fin.dashboard.workload.empty')} />
      )}
    </>
  );
}

/** Two small charts side by side: counts and money never share an axis. */
function TrendCharts({ days, currency }: { days: Array<{ date: string; requestsCreated: number | null; requestsCompleted: number | null; serviceRevenue: string | null; grossCollections: string | null }>; currency: string }) {
  const { t } = useI18n();
  const hasRequests = days.some((d) => d.requestsCreated !== null);
  const hasRevenue = days.some((d) => d.serviceRevenue !== null);
  const hasCollections = days.some((d) => d.grossCollections !== null);
  if (!hasRequests && !hasRevenue) return <EmptyState title={t('fin.dashboard.trends.empty')} />;
  return (
    <div className={cn('grid gap-8', hasRequests && hasRevenue && 'lg:grid-cols-2')}>
      {hasRequests ? (
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold text-foreground">{t('fin.dashboard.trends.requests')}</h3>
          <SeriesChart
            type="line"
            data={days}
            xKey="date"
            xType="date"
            label={t('fin.dashboard.trends.requests')}
            series={[
              { key: 'requestsCreated', label: t('fin.dashboard.trends.created') },
              { key: 'requestsCompleted', label: t('fin.dashboard.trends.completed') },
            ]}
          />
        </div>
      ) : null}
      {hasRevenue ? (
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold text-foreground">{t('fin.dashboard.trends.money')}</h3>
          <SeriesChart
            type="line"
            data={days}
            xKey="date"
            xType="date"
            valueType="money"
            currency={currency}
            label={t('fin.dashboard.trends.money')}
            series={[{ key: 'serviceRevenue', label: t('fin.dashboard.money.serviceRevenueShort') }, ...(hasCollections ? [{ key: 'grossCollections', label: t('fin.dashboard.money.grossCollectionsShort') }] : [])]}
          />
        </div>
      ) : null}
    </div>
  );
}

/** First name for the greeting and the centre's name (in the active language) for the description. */
function useSessionNames() {
  const session = useSession();
  const branding = useBranding();
  return { tenant: branding.config ? branding.name : session.tenant?.name ?? null, user: session.user?.fullName.trim().split(/\s+/)[0] ?? null };
}
