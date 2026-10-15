'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BellRing, CalendarClock, RefreshCw, SearchX } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Select, Skeleton, StatCard, StatusBadge, cn, useI18n } from '@typease/ui';
import { CompanyStatusNotice, EXPIRY_WARNING_DAYS, LoadError, useCompanyAccount, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { ReminderRow } from '@/lib/types';

const RANGES = ['all', '30', '60', '90', 'expired'] as const;
type Range = (typeof RANGES)[number];

const inRange = (r: ReminderRow, range: Range) => (range === 'all' ? true : range === 'expired' ? r.daysLeft < 0 : r.daysLeft >= 0 && r.daysLeft <= Number(range));

/**
 * The expiry schedule the centre keeps for the company: its own documents (trade licence ...)
 * and, for administrators, those of its employees; an employee sees their own. Soonest first,
 * with the renewal request one press away. Dates are "according to the centre's records":
 * nothing here states a legal deadline.
 */
export function Reminders() {
  const { t, tn, pick, formatDate, formatNumber } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const { active } = useCompanyAccount();
  const reminders = useQuery({ queryKey: keys.reminders, queryFn: ({ signal }) => api.reminders(undefined, signal) });
  const [q, setQ] = React.useState('');
  const [range, setRange] = React.useState<Range>('all');
  const [type, setType] = React.useState('all');

  const all = React.useMemo(() => [...(reminders.data?.data ?? [])].sort((a, b) => a.daysLeft - b.daysLeft), [reminders.data]);
  const types = React.useMemo(() => [...new Map(all.map((r) => [r.documentTypeKey, pick(r.documentTypeName, r.documentTypeNameAr)])).entries()], [all, pick]);
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => inRange(r, range) && (type === 'all' || r.documentTypeKey === type) && (!needle || [r.subjectLabel, r.documentTypeName, r.documentTypeNameAr].some((text) => text?.toLowerCase().includes(needle))));
  }, [all, q, range, type]);
  const count = (w: Range) => all.filter((r) => r.status === 'ACTIVE' && inRange(r, w)).length;
  const canRenew = role.canCreateRequests && active;
  const filtered = !!q || range !== 'all' || type !== 'all';
  const total = reminders.data?.meta.total ?? 0;

  return (
    <>
      <PageHeader title={t('nav.reminders')} description={role.company ? t('sections.reminders') : t('my.reminders.mineText')} />
      <CompanyStatusNotice className="mb-4" />

      {reminders.isPending ? (
        <div className="space-y-4" role="status" aria-label={t('common.loading')}>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[4.75rem]" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : reminders.isError ? (
        <LoadError error={reminders.error} onRetry={() => void reminders.refetch()} />
      ) : all.length === 0 ? (
        <Card>
          <EmptyState size="page" icon={<BellRing />} title={t('my.reminders.emptyTitle')} description={role.company ? t('my.reminders.emptyText') : t('my.reminders.emptyTextSelf')} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <StatCard label={t('my.reminders.stats.expired')} value={formatNumber(count('expired'))} icon={<CalendarClock />} tone={count('expired') > 0 ? 'danger' : 'neutral'} />
            <StatCard label={t('my.reminders.stats.d30')} value={formatNumber(count('30'))} icon={<CalendarClock />} tone={count('30') > 0 ? 'warning' : 'neutral'} />
            <StatCard label={t('my.reminders.stats.d60')} value={formatNumber(count('60'))} icon={<CalendarClock />} tone="info" />
            <StatCard label={t('my.reminders.stats.d90')} value={formatNumber(count('90'))} icon={<CalendarClock />} tone="info" />
          </div>

          <section aria-label={t('nav.reminders')} className="mt-6 rounded-lg border bg-card shadow-xs">
            <div className="flex flex-wrap items-end gap-3 border-b p-3 sm:p-4">
              <div className="w-full sm:w-72">
                <SearchInput value={q} onChange={setQ} placeholder={t('my.reminders.search')} aria-label={t('my.reminders.search')} />
              </div>
              <div className="min-w-0 flex-1 basis-[calc(50%-0.375rem)] sm:max-w-56 sm:flex-none sm:basis-auto">
                <Select
                  aria-label={t('my.reminders.window.label')}
                  value={range}
                  onValueChange={(v) => setRange(v as Range)}
                  options={RANGES.map((w) => ({ value: w, label: w === 'all' ? `${t('my.reminders.window.label')}: ${t('common.all')}` : t(`my.reminders.window.${w}`) }))}
                  className="sm:min-w-44 [&>span]:truncate"
                />
              </div>
              {types.length > 1 ? (
                <div className="min-w-0 flex-1 basis-[calc(50%-0.375rem)] sm:max-w-56 sm:flex-none sm:basis-auto">
                  <Select
                    aria-label={t('my.documents.columns.type')}
                    value={type}
                    onValueChange={setType}
                    options={[{ value: 'all', label: `${t('my.documents.columns.type')}: ${t('common.all')}` }, ...types.map(([key, label]) => ({ value: key, label }))]}
                    className="sm:min-w-44 [&>span]:truncate"
                  />
                </div>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <EmptyState
                icon={<SearchX />}
                title={t('table.emptyFilteredTitle')}
                description={t('table.emptyFilteredDescription')}
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQ('');
                        setRange('all');
                        setType('all');
                      }}
                    >
                      {t('table.clearFilters')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="divide-y" data-reminders={rows.length}>
                {rows.map((r) => {
                  const expired = r.daysLeft < 0;
                  const soon = !expired && r.daysLeft <= EXPIRY_WARNING_DAYS;
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4" data-reminder={r.id} data-days-left={r.daysLeft}>
                      <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', expired ? 'bg-destructive-soft text-destructive-text' : soon ? 'bg-warning-soft text-warning-text' : 'bg-muted text-muted-foreground')}>
                        <CalendarClock className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                          <span>{pick(r.documentTypeName, r.documentTypeNameAr)}</span>
                          {r.status !== 'ACTIVE' ? <StatusBadge kind="reminder" status={r.status} /> : null}
                        </p>
                        {r.subjectLabel ? (
                          <p className="text-sm text-muted-foreground" dir="auto">
                            {r.subjectLabel}
                          </p>
                        ) : null}
                      </div>
                      <div className="basis-full text-base sm:basis-auto">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="tabular whitespace-nowrap">{expired ? t('my.reminders.expiredOn', { date: formatDate(r.expiryDate) }) : t('my.reminders.expiresOn', { date: formatDate(r.expiryDate) })}</span>
                          {expired ? <Badge tone="danger">{t('my.expiry.expired')}</Badge> : soon ? <Badge tone="warning">{tn('my.expiry.inDays', r.daysLeft)}</Badge> : <Badge tone="neutral">{tn('my.expiry.inDays', r.daysLeft)}</Badge>}
                        </p>
                        {r.status === 'ACTIVE' && r.nextReminderOn ? <p className="mt-0.5 text-sm text-muted-foreground">{t('my.reminders.nextOn', { date: formatDate(r.nextReminderOn) })}</p> : null}
                      </div>
                      <div className="flex w-full sm:w-auto">
                        {r.renewalRequestId ? (
                          <Button asChild variant="outline" className="flex-1 sm:flex-none">
                            <Link href={`${ROUTES.requests}/${r.renewalRequestId}`}>{t('my.reminders.openRenewal')}</Link>
                          </Button>
                        ) : canRenew && r.status === 'ACTIVE' ? (
                          <Button asChild variant={expired || soon ? 'default' : 'outline'} className="flex-1 sm:flex-none" data-action="renew">
                            <Link href={r.renewalPath}>
                              <RefreshCw aria-hidden="true" />
                              {t('my.reminders.renew')}
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {total > all.length ? <p className="mt-3 text-sm text-muted-foreground">{t('my.reminders.more', { shown: formatNumber(all.length), total: formatNumber(total) })}</p> : null}
          <p className="mt-3 text-sm text-muted-foreground">{t('my.reminders.note')}</p>
        </>
      )}
    </>
  );
}
