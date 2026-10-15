'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, BellRing, ClipboardCheck, ClipboardList, FilePen, Hourglass, Plus, Receipt, ShieldCheck, Users } from 'lucide-react';
import type { RequestBucket, RequestListItem } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, DescriptionList, PageHeader, PermissionGate, Skeleton, StatCard, StatusBadge, useBranding, useErrorMessage, useI18n,
  useSession, type DataTableColumn,
} from '@typease/ui';
import { Expiry, EXPIRY_WARNING_DAYS, Ltr, PersonName, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import { useOpenQuotations } from '../approvals/approvals';
import { requestHref, rowPerson } from '../requests/requests-list';

/** The stages a company cares about, in the order a request moves through them. */
const STAGES: RequestBucket[] = ['newRequests', 'pendingVerification', 'awaitingCustomer', 'awaitingPayment', 'readyForProcessing', 'inProgress', 'completedToday', 'overdue'];

const STATUS_NOTICE = {
  PENDING_VERIFICATION: { tone: 'warning', key: 'pending' },
  SUSPENDED: { tone: 'danger', key: 'suspended' },
  ARCHIVED: { tone: 'info', key: 'archived' },
} as const;

/**
 * Home of the corporate portal. A company administrator gets the company's account with the centre;
 * an employee, who may not read the company's account (the API answers 403), gets their own requests.
 */
export function Overview() {
  const role = useRole();
  return role.company ? <CompanyOverview /> : <EmployeeOverview />;
}

/** Documents whose expiry the centre tracks, the soonest first: the next thing to renew. */
function ExpiringSoon({ limit = 4 }: { limit?: number }) {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const reminders = useQuery({ queryKey: keys.reminders, queryFn: ({ signal }) => api.reminders(undefined, signal) });
  const soon = (reminders.data?.data ?? []).filter((r) => r.status === 'ACTIVE' && r.daysLeft <= EXPIRY_WARNING_DAYS).sort((a, b) => a.daysLeft - b.daysLeft);
  return (
    <Card data-expiring-soon>
      <CardHeader className="items-center">
        <CardTitle className="text-lg">{t('overview.expiring.title')}</CardTitle>
        <Button asChild variant="link">
          <Link href={ROUTES.reminders}>{t('overview.expiring.all')}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {reminders.isPending ? (
          <div className="space-y-3" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : reminders.isError ? (
          <p className="text-base text-muted-foreground">{t('overview.expiring.error')}</p>
        ) : soon.length === 0 ? (
          <p className="flex gap-2.5 text-base text-muted-foreground">
            <BellRing className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            {role.company ? t('overview.expiring.none') : t('overview.expiring.noneSelf')}
          </p>
        ) : (
          <ul className="space-y-3.5">
            {soon.slice(0, limit).map((r) => (
              <li key={r.id} className="min-w-0">
                <p className="text-base font-medium text-foreground">{pick(r.documentTypeName, r.documentTypeNameAr)}</p>
                {r.subjectLabel && role.company ? (
                  <p className="truncate text-sm text-muted-foreground" dir="auto">
                    {r.subjectLabel}
                  </p>
                ) : null}
                <p className="mt-0.5 text-sm">
                  <Expiry date={r.expiryDate} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function useRecentColumns(withPerson: boolean): Array<DataTableColumn<RequestListItem>> {
  const { t, pick, formatDate } = useI18n();
  return [
    { id: 'service', header: t('overview.recent.service'), cell: (r) => pick(r.service.name, r.service.nameAr), mobile: 'title' },
    { id: 'status', header: t('overview.recent.status'), cell: (r) => <StatusBadge kind="requestCustomer" status={r.status} label={r.statusLabel} />, mobile: 'badge' },
    ...(withPerson ? [{ id: 'person', header: t('overview.recent.person'), cell: (r: RequestListItem) => <PersonName {...rowPerson(r)} /> }] : []),
    { id: 'number', header: t('overview.recent.number'), cell: (r) => <Ltr>{r.requestNo}</Ltr>, className: 'whitespace-nowrap' },
    { id: 'created', header: t('overview.recent.created'), cell: (r) => formatDate(r.createdAt), className: 'whitespace-nowrap tabular' },
  ];
}

// ---------------------------------------------------------------- company administrators

/** The company's account with the centre (GET /corporate/account) and where its requests stand (GET /requests/counts). */
function CompanyOverview() {
  const { t, tn, pick, formatNumber, formatMoney } = useI18n();
  const api = usePortalApi();
  const describe = useErrorMessage();
  const session = useSession();
  const { name: centre, config } = useBranding();
  const currency = config?.currency ?? 'AED';

  const account = useQuery({ queryKey: keys.account, queryFn: () => api.account() });
  const counts = useQuery({ queryKey: keys.requests.counts, queryFn: () => api.requestCounts() });
  const open = useOpenQuotations(session.hasPermission('corp.requests.approve'));
  const columns = useRecentColumns(true);

  const a = account.data;
  const notice = a && a.status !== 'ACTIVE' ? STATUS_NOTICE[a.status] : null;
  const stages = counts.data ? STAGES.filter((bucket) => counts.data.buckets[bucket] > 0) : [];
  const figure = (value: number | undefined) => (value === undefined ? '–' : formatNumber(value));
  const waiting = open.data?.length ?? 0;

  return (
    <>
      <PageHeader
        title={a ? pick(a.companyName, a.companyNameAr) : t('overview.title')}
        description={t('overview.description', { centre })}
        meta={
          a ? (
            <Badge tone={a.verified ? 'success' : 'neutral'} icon={a.verified ? <BadgeCheck /> : undefined}>
              {a.verified ? t('overview.company.verified') : t('overview.company.notVerified')}
            </Badge>
          ) : undefined
        }
        action={
          !a || a.status === 'ACTIVE' ? (
            <PermissionGate permission="corp.requests.create">
              <Button asChild variant="accent" size="lg">
                <Link href={ROUTES.newRequest}>
                  <Plus aria-hidden="true" />
                  {t('overview.newRequest')}
                </Link>
              </Button>
            </PermissionGate>
          ) : undefined
        }
      />

      {account.isError ? (
        <Alert tone="danger" className="mb-4" action={<Button size="sm" variant="outline" onClick={() => void account.refetch()}>{t('common.retry')}</Button>}>
          {t('overview.loadError')} {describe(account.error)}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone={notice.tone} className="mb-4" title={t(`overview.status.${notice.key}Title`)}>
          {t(`overview.status.${notice.key}Text`)}
        </Alert>
      ) : null}
      {waiting > 0 ? (
        <Alert
          tone="warning"
          className="mb-4"
          title={tn('overview.approvals.waiting', waiting)}
          data-approvals-waiting={waiting}
          action={
            <Button asChild size="sm">
              <Link href={ROUTES.approvals}>
                <ClipboardCheck aria-hidden="true" />
                {t('overview.approvals.review')}
              </Link>
            </Button>
          }
        >
          {t('overview.approvals.text')}
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard label={t('overview.stats.employees')} value={figure(a?.counters.employees)} icon={<Users />} tone="info" href={ROUTES.employees} loading={account.isPending} />
        <StatCard label={t('overview.stats.openRequests')} value={figure(a?.counters.openRequests)} icon={<ClipboardList />} tone="brand" href={ROUTES.requests} loading={account.isPending} />
        <StatCard
          label={t('overview.stats.awaitingYou')}
          value={figure(counts.data?.buckets.awaitingCustomer)}
          icon={<Hourglass />}
          // Only raises its voice when something is actually waiting.
          tone={(counts.data?.buckets.awaitingCustomer ?? 0) > 0 ? 'warning' : 'neutral'}
          href={`${ROUTES.requests}?show=awaitingCustomer`}
          loading={counts.isPending}
        />
        <StatCard
          label={t('overview.stats.unpaidInvoices')}
          value={figure(a?.counters.unpaidInvoices)}
          hint={a && a.counters.unpaidInvoices > 0 ? t('overview.stats.balance', { amount: formatMoney(a.counters.unpaidInvoicesBalance, currency) }) : undefined}
          icon={<Receipt />}
          tone={(a?.counters.unpaidInvoices ?? 0) > 0 ? 'danger' : 'neutral'}
          href={ROUTES.invoices}
          loading={account.isPending}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader className="items-center pb-4">
              <CardTitle className="text-lg">{t('overview.recent.title')}</CardTitle>
              <Button asChild variant="link">
                <Link href={ROUTES.requests}>{t('overview.recent.viewAll')}</Link>
              </Button>
            </CardHeader>
            <DataTable<RequestListItem>
              bare
              caption={t('overview.recent.title')}
              queryKey={[...keys.requests.recent]}
              queryFn={(params, signal) => api.requests(params, signal)}
              columns={columns}
              rowKey={(r) => r.id}
              rowHref={requestHref}
              defaultSort="createdAt:desc"
              defaultPageSize={5}
              searchable={false}
              pagination={false}
              syncUrl={false}
              className="border-t"
              empty={{ icon: <ClipboardList />, title: t('overview.recent.empty'), description: t('overview.recent.emptyText') }}
            />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('overview.stages.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {counts.isPending ? (
                <div className="space-y-2" role="status" aria-label={t('common.loading')}>
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                </div>
              ) : counts.isError ? (
                <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void counts.refetch()}>{t('common.retry')}</Button>}>
                  {t('overview.countsError')} {describe(counts.error)}
                </Alert>
              ) : stages.length === 0 ? (
                <p className="text-base text-muted-foreground">{t('overview.stages.empty')}</p>
              ) : (
                <ul className="divide-y">
                  {stages.map((bucket) => (
                    <li key={bucket}>
                      <Link href={`${ROUTES.requests}?show=${bucket === 'completedToday' ? 'completed' : bucket}`} className="flex items-center justify-between gap-4 rounded-md py-2.5 text-base hover:text-secondary-text">
                        <span>{t(`overview.stages.${bucket}`)}</span>
                        <span className="tabular font-semibold">{formatNumber(counts.data.buckets[bucket])}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <ExpiringSoon />
          <Card>
            <CardHeader className="items-center">
              <CardTitle className="text-lg">{t('overview.company.title')}</CardTitle>
              <PermissionGate permission="corp.account.read">
                <Button asChild variant="link">
                  <Link href={ROUTES.company}>{t('overview.company.edit')}</Link>
                </Button>
              </PermissionGate>
            </CardHeader>
            <CardContent>
              {account.isPending ? (
                <div className="space-y-3" role="status" aria-label={t('common.loading')}>
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : a ? (
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('overview.accountNo'), value: <Ltr>{a.accountNo}</Ltr> },
                    { label: t('overview.company.licenceNo'), value: a.tradeLicenceNo ? <Ltr>{a.tradeLicenceNo}</Ltr> : null },
                    { label: t('overview.company.licenceExpiry'), value: a.tradeLicenceExpiry ? <Expiry date={a.tradeLicenceExpiry} /> : null },
                    { label: t('overview.company.members'), value: formatNumber(a.counters.members) },
                  ]}
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('overview.credit.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {account.isPending ? (
                <Skeleton className="h-16" role="status" aria-label={t('common.loading')} />
              ) : a && a.credit.approved ? (
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('overview.credit.limit'), value: a.credit.limit ? <span className="tabular">{formatMoney(a.credit.limit, currency)}</span> : null },
                    { label: t('overview.credit.available'), value: a.counters.creditAvailable ? <span className="tabular">{formatMoney(a.counters.creditAvailable, currency)}</span> : null },
                    { label: t('overview.credit.terms'), value: a.credit.paymentTermsDays > 0 ? tn('overview.credit.days', a.credit.paymentTermsDays) : t('overview.credit.onInvoice') },
                  ]}
                />
              ) : a ? (
                <p className="text-base text-muted-foreground">{t('overview.credit.none')}</p>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- employees

/** An employee's own corner: what waits for them, their latest requests, what expires soon. */
function EmployeeOverview() {
  const { t, formatNumber } = useI18n();
  const api = usePortalApi();
  const session = useSession();
  const { name: centre } = useBranding();
  const counts = useQuery({ queryKey: keys.requests.counts, queryFn: () => api.requestCounts() });
  const columns = useRecentColumns(false);
  const figure = (value: number | undefined) => (value === undefined ? '–' : formatNumber(value));
  const waiting = counts.data ? counts.data.buckets.awaitingCustomer + counts.data.buckets.awaitingPayment : undefined;
  const firstName = (session.user?.fullName ?? '').trim().split(/\s+/)[0] ?? '';

  const newRequest = (
    <PermissionGate permission="self.requests">
      <Button asChild variant="accent" size="lg">
        <Link href={ROUTES.newRequest}>
          <Plus aria-hidden="true" />
          {t('overview.newRequest')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={firstName ? t('overview.self.greeting', { name: firstName }) : t('overview.title')} description={t('overview.self.description', { centre })} action={newRequest} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3" data-employee-overview>
        <StatCard label={t('overview.self.open')} value={figure(counts.data?.open)} icon={<ClipboardList />} tone="brand" href={ROUTES.requests} loading={counts.isPending} />
        <StatCard label={t('overview.self.waiting')} value={figure(waiting)} icon={<Hourglass />} tone={(waiting ?? 0) > 0 ? 'warning' : 'neutral'} href={`${ROUTES.requests}?show=awaitingCustomer`} loading={counts.isPending} />
        <StatCard label={t('overview.self.drafts')} value={figure(counts.data?.drafts)} icon={<FilePen />} tone="neutral" href={`${ROUTES.requests}?show=drafts`} loading={counts.isPending} className="col-span-2 lg:col-span-1" />
      </div>
      {counts.isError ? (
        <Alert tone="danger" className="mt-4" action={<Button size="sm" variant="outline" onClick={() => void counts.refetch()}>{t('common.retry')}</Button>}>
          {t('overview.countsError')}
        </Alert>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0">
          <CardHeader className="items-center pb-4">
            <CardTitle className="text-lg">{t('overview.self.recent')}</CardTitle>
            <Button asChild variant="link">
              <Link href={ROUTES.requests}>{t('overview.self.viewAll')}</Link>
            </Button>
          </CardHeader>
          <DataTable<RequestListItem>
            bare
            caption={t('overview.self.recent')}
            queryKey={[...keys.requests.recent]}
            queryFn={(params, signal) => api.requests(params, signal)}
            columns={columns}
            rowKey={(r) => r.id}
            rowHref={requestHref}
            defaultSort="createdAt:desc"
            defaultPageSize={5}
            searchable={false}
            pagination={false}
            syncUrl={false}
            className="border-t"
            empty={{ icon: <ClipboardList />, title: t('overview.self.empty'), description: t('overview.self.emptyText'), action: newRequest }}
          />
        </Card>
        <div className="space-y-6">
          <ExpiringSoon />
          <Card>
            <CardContent className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-base text-muted-foreground">{t('overview.self.scope')}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
