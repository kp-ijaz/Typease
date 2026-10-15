'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, MailWarning, RotateCw, Send } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, DataTable, DescriptionList, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, Timeline, useApi, useI18n,
  type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import { Loadable, OpsStatusBadge, useRun } from '@/components/ops/common';
import type { FailureSummary, NotificationEvent, NotificationLogRow } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { CHANNELS, useEventLabel } from './settings-page';

const STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED'];

function useLogColumns(onOpen: (row: NotificationLogRow) => void) {
  const { t, has, formatDateTime } = useI18n();
  const eventLabel = useEventLabel();
  return React.useMemo<Array<DataTableColumn<NotificationLogRow>>>(
    () => [
      { id: 'when', header: t('ops.notify.log.when'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (r) => formatDateTime(r.createdAt) },
      {
        id: 'event',
        header: t('ops.notify.matrix.event'),
        mobile: 'title',
        cell: (r) => (
          <button type="button" onClick={() => onOpen(r)} className="rounded-sm text-start font-medium text-secondary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {eventLabel(r.eventKey, r.eventLabel)}
          </button>
        ),
      },
      { id: 'channel', header: t('ops.notify.templates.channel'), sortField: 'channel', cell: (r) => t(`ops.notify.channelNames.${r.channel}`) },
      { id: 'recipient', header: t('ops.notify.log.recipient'), cell: (r) => (r.recipientAddress ? <span className="ltr-value block max-w-56 truncate" title={r.recipientAddress}>{r.recipientAddress}</span> : null) },
      {
        id: 'status',
        header: t('ops.common.status'),
        sortField: 'status',
        mobile: 'badge',
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <OpsStatusBadge kind="delivery" status={r.status} />
            {r.suppressedReason ? <span className="text-sm text-muted-foreground">{has(`ops.notify.suppressed.${r.suppressedReason}`) ? t(`ops.notify.suppressed.${r.suppressedReason}`) : r.suppressedReason}</span> : null}
          </span>
        ),
      },
      { id: 'error', header: t('ops.notify.log.error'), mobile: 'hidden', cell: (r) => (r.status === 'FAILED' && r.lastError ? <span className="block max-w-64 truncate text-sm text-destructive-text" title={r.lastError} dir="auto">{r.lastError}</span> : null) },
    ],
    [t, has, formatDateTime, eventLabel, onOpen],
  );
}

function useLogFilters(withStatus: boolean) {
  const { t } = useI18n();
  const api = useApi();
  const eventLabel = useEventLabel();
  const events = useQuery({ queryKey: opsKeys.notifications.events, queryFn: () => api.client.get<NotificationEvent[]>('/notifications/events'), staleTime: 10 * 60_000 });
  return React.useMemo<DataTableFilter[]>(
    () => [
      ...(withStatus ? [{ id: 'status', type: 'select' as const, label: t('ops.common.status'), options: STATUSES.map((s) => ({ value: s, label: t(`ops.status.delivery.${s}`) })) }] : []),
      { id: 'channel', type: 'select', label: t('ops.notify.templates.channel'), options: CHANNELS.map((c) => ({ value: c, label: t(`ops.notify.channelNames.${c}`) })) },
      { id: 'eventKey', type: 'select', label: t('ops.notify.matrix.event'), options: (events.data ?? []).map((e) => ({ value: e.eventKey, label: eventLabel(e.eventKey, e.label) })) },
      { id: 'sent', type: 'dateRange', label: t('ops.notify.log.when'), fromKey: 'from', toKey: 'to' },
    ],
    [t, withStatus, events.data, eventLabel],
  );
}

/** Everything that was sent, queued, suppressed or failed. */
export function LogTab() {
  const { t } = useI18n();
  const api = useApi();
  const [open, setOpen] = React.useState<string | null>(null);
  const onOpen = React.useCallback((row: NotificationLogRow) => setOpen(row.id), []);
  const columns = useLogColumns(onOpen);
  const filters = useLogFilters(true);
  return (
    <>
      <DataTable<NotificationLogRow>
        caption={t('ops.notify.tabs.log')}
        queryKey={opsKeys.notifications.log}
        queryFn={(params, signal) => api.client.get<Page<NotificationLogRow>>('/notifications', { query: params, signal })}
        columns={columns}
        rowKey={(r) => r.id}
        rowActions={[{ id: 'open', label: t('ops.notify.log.details'), icon: <Eye aria-hidden="true" />, onSelect: onOpen }]}
        filters={filters}
        searchPlaceholder={t('ops.notify.log.search')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Send />, title: t('ops.notify.log.emptyTitle'), description: t('ops.notify.log.emptyText') }}
      />
      <DeliverySheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Messages that finally failed, with what failed most and a way to send them again. */
export function FailuresTab() {
  const { t, formatNumber } = useI18n();
  const api = useApi();
  const eventLabel = useEventLabel();
  const { run } = useRun();
  const [open, setOpen] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<FailureSummary | null>(null);
  const onOpen = React.useCallback((row: NotificationLogRow) => setOpen(row.id), []);
  const columns = useLogColumns(onOpen);
  const filters = useLogFilters(false);
  const retry = (row: NotificationLogRow) => run(`retry-${row.id}`, () => api.client.post(`/notifications/${row.id}/retry`), { success: t('ops.notify.log.retried'), description: t('ops.notify.log.retriedText'), invalidate: [opsKeys.notifications.failures, opsKeys.notifications.log] });

  return (
    <div className="space-y-4">
      {summary && summary.total > 0 ? (
        <Card className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <p className="text-sm text-muted-foreground">{t('ops.notify.failures.total')}</p>
            <p className="tabular text-3xl font-semibold">{formatNumber(summary.total)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('ops.notify.failures.byChannel')}</p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {summary.byChannel.map((c) => (
                <Badge key={c.channel} tone="danger">
                  {t(`ops.notify.channelNames.${c.channel}`)}: {formatNumber(c.count)}
                </Badge>
              ))}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('ops.notify.failures.byEvent')}</p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {summary.byEvent.map((e) => (
                <Badge key={e.eventKey} tone="neutral">
                  {eventLabel(e.eventKey, e.eventLabel)}: {formatNumber(e.count)}
                </Badge>
              ))}
            </p>
          </div>
        </Card>
      ) : null}
      <DataTable<NotificationLogRow>
        caption={t('ops.notify.tabs.failures')}
        queryKey={opsKeys.notifications.failures}
        queryFn={async ({ page, pageSize, channel, eventKey, from, to }, signal) => {
          const result = await api.client.get<Page<NotificationLogRow> & { summary: FailureSummary }>('/notifications/failures', { query: { page, pageSize, channel, eventKey, from, to }, signal });
          setSummary(result.summary);
          return result;
        }}
        columns={columns}
        rowKey={(r) => r.id}
        rowActions={[
          { id: 'retry', label: t('ops.notify.log.retry'), icon: <RotateCw aria-hidden="true" />, onSelect: (r) => void retry(r) },
          { id: 'open', label: t('ops.notify.log.details'), icon: <Eye aria-hidden="true" />, onSelect: onOpen },
        ]}
        filters={filters}
        searchable={false}
        empty={{ icon: <MailWarning />, title: t('ops.notify.failures.emptyTitle'), description: t('ops.notify.failures.emptyText') }}
      />
      <DeliverySheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function DeliverySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, has, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const eventLabel = useEventLabel();
  const { run, busy } = useRun();
  const detail = useQuery({ queryKey: opsKeys.notifications.detail(id ?? ''), queryFn: () => api.client.get<NotificationLogRow>(`/notifications/${id}`), enabled: !!id });
  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('ops.notify.log.detailTitle')}</SheetTitle>
          <SheetDescription>{detail.data ? eventLabel(detail.data.eventKey, detail.data.eventLabel) : t('common.loading')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {id ? (
            <Loadable query={detail} skeleton={<Skeleton className="h-64 w-full" />}>
              {(n) => (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <OpsStatusBadge kind="delivery" status={n.status} />
                    <Badge tone="outline">{t(`ops.notify.channelNames.${n.channel}`)}</Badge>
                    <Badge tone="outline">{n.language === 'ar' ? 'العربية' : 'English'}</Badge>
                  </div>
                  {n.suppressedReason ? <Alert tone="info">{has(`ops.notify.suppressed.${n.suppressedReason}`) ? t(`ops.notify.suppressed.${n.suppressedReason}`) : n.suppressedReason}</Alert> : null}
                  <DescriptionList
                    columns={1}
                    items={[
                      { label: t('ops.notify.log.recipient'), value: n.recipientAddress ? <span className="ltr-value break-all">{n.recipientAddress}</span> : null },
                      { label: t('ops.notify.templates.subject'), value: n.subject ? <span dir="auto">{n.subject}</span> : null },
                      { label: t('ops.notify.log.when'), value: formatDateTime(n.createdAt) },
                      { label: t('ops.notify.log.sentAt'), value: n.sentAt ? formatDateTime(n.sentAt) : null },
                      { label: t('ops.notify.log.attempts'), value: formatNumber(n.attempts) },
                    ]}
                  />
                  {n.body ? (
                    <div>
                      <p className="text-sm text-muted-foreground">{t('ops.notify.templates.body')}</p>
                      <p className="mt-1 whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm" dir="auto">
                        {n.body}
                      </p>
                    </div>
                  ) : null}
                  {n.status === 'FAILED' ? (
                    <Button loading={busy === 'retry'} onClick={() => void run('retry', () => api.client.post(`/notifications/${n.id}/retry`), { success: t('ops.notify.log.retried'), description: t('ops.notify.log.retriedText'), invalidate: [opsKeys.notifications.all] })}>
                      <RotateCw aria-hidden="true" />
                      {t('ops.notify.log.retry')}
                    </Button>
                  ) : null}
                  {n.deliveries?.length ? (
                    <section className="space-y-3">
                      <h3 className="text-md font-semibold">{t('ops.notify.log.attemptsTitle')}</h3>
                      <Timeline
                        items={n.deliveries.map((d) => ({
                          id: d.id,
                          title: t('ops.notify.log.attemptLine', { number: formatNumber(d.attempt), provider: d.provider ?? '–' }),
                          time: formatDateTime(d.completedAt ?? d.requestedAt),
                          description: d.error ? <span className="text-destructive-text" dir="auto">{d.error}</span> : undefined,
                          state: d.status === 'FAILED' ? 'current' : 'done',
                          tone: d.status === 'FAILED' ? 'danger' : undefined,
                        }))}
                      />
                    </section>
                  ) : null}
                </>
              )}
            </Loadable>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
