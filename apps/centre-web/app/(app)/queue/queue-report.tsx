'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Clock, Ticket, UserX } from 'lucide-react';
import { Card, DatePicker, DescriptionList, EmptyState, Label, Skeleton, StatCard, addDays, useApi, useI18n } from '@typease/ui';
import { Loadable, Panel, useDuration } from '@/components/ops/common';
import type { QueueStats } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

/** Waiting-time report of a branch for a date range (default: the last 30 days). */
export function QueueReport({ branchId }: { branchId: string }) {
  const { t, today, formatNumber } = useI18n();
  const api = useApi();
  const duration = useDuration();
  const id = React.useId();
  const [to, setTo] = React.useState(today());
  const [from, setFrom] = React.useState(() => addDays(today(), -29));
  const params = { branchId, from, to };
  const stats = useQuery({ queryKey: opsKeys.queue.stats(params), queryFn: () => api.client.get<QueueStats>('/queue/stats', { query: params }), enabled: from <= to });

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-from`}>{t('common.from')}</Label>
          <DatePicker id={`${id}-from`} value={from} max={to} onChange={(v) => v && setFrom(v)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-to`}>{t('common.to')}</Label>
          <DatePicker id={`${id}-to`} value={to} min={from} max={today()} onChange={(v) => v && setTo(v)} />
        </div>
        <p className="basis-full text-sm text-muted-foreground sm:basis-auto sm:pb-2">{t('ops.queue.report.hint')}</p>
      </Card>

      <Loadable query={stats} skeleton={<Skeleton className="h-72 w-full" />}>
        {(s) =>
          s.tokens.total === 0 ? (
            <Card>
              <EmptyState icon={<Ticket />} title={t('ops.queue.report.emptyTitle')} description={t('ops.queue.report.emptyText')} />
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                <StatCard label={t('ops.queue.report.tokens')} value={formatNumber(s.tokens.total)} icon={<Ticket />} tone="info" hint={t('ops.queue.report.days', { count: formatNumber(s.tokens.daysWithTokens) })} />
                <StatCard label={t('ops.queue.report.served')} value={formatNumber(s.tokens.completed)} icon={<CheckCheck />} tone="success" />
                <StatCard label={t('ops.queue.report.averageWait')} value={duration(s.waitSeconds.average)} icon={<Clock />} tone="warning" />
                <StatCard label={t('ops.queue.report.noShowRate')} value={s.noShowRate === null ? '–' : formatNumber(s.noShowRate, { style: 'percent', maximumFractionDigits: 1 })} icon={<UserX />} tone={s.noShowRate && s.noShowRate > 0.15 ? 'danger' : 'neutral'} hint={t('ops.queue.report.noShows', { count: formatNumber(s.tokens.noShows) })} />
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel title={t('ops.queue.report.waitTitle')} description={t('ops.queue.report.waitText')}>
                  <DescriptionList
                    columns={3}
                    items={[
                      { label: t('ops.queue.report.average'), value: duration(s.waitSeconds.average) },
                      { label: t('ops.queue.report.median'), value: duration(s.waitSeconds.median) },
                      { label: t('ops.queue.report.p90'), value: duration(s.waitSeconds.p90) },
                    ]}
                  />
                </Panel>
                <Panel title={t('ops.queue.report.serviceTitle')} description={t('ops.queue.report.serviceText')}>
                  <DescriptionList
                    columns={3}
                    items={[
                      { label: t('ops.queue.report.average'), value: duration(s.serviceSeconds.average) },
                      { label: t('ops.queue.report.median'), value: duration(s.serviceSeconds.median) },
                      { label: t('ops.queue.report.p90'), value: duration(s.serviceSeconds.p90) },
                    ]}
                  />
                </Panel>
              </div>
              <Panel title={t('ops.queue.report.hoursTitle')} description={t('ops.queue.report.hoursText', { timezone: s.timezone })}>
                <HourBars rows={s.tokensPerHour} />
              </Panel>
            </>
          )
        }
      </Loadable>
    </div>
  );
}

/** Tokens per hour of the day as plain horizontal bars: the busiest hour is the full width. */
function HourBars({ rows }: { rows: QueueStats['tokensPerHour'] }) {
  const { t, formatNumber } = useI18n();
  const max = Math.max(1, ...rows.map((r) => r.averagePerDay));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.hour} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
          <span className="tabular text-muted-foreground" dir="ltr">
            {String(r.hour).padStart(2, '0')}:00
          </span>
          <span className="h-3 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span className="block h-full rounded-full bg-secondary" style={{ width: `${Math.max(3, Math.round((r.averagePerDay / max) * 100))}%` }} />
          </span>
          <span className="tabular whitespace-nowrap">{t('ops.queue.report.perDay', { count: formatNumber(r.averagePerDay, { maximumFractionDigits: 1 }) })}</span>
        </li>
      ))}
    </ul>
  );
}
