'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ExternalLink, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, ConfirmDialog, DataTable, PageHeader, RequirePermission, useI18n, useToast, type DataTableColumn, type RowAction } from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { ScheduleDialog, UpgradeForSchedules, useScheduleText, useScheduledReportsFeature } from '@/components/fin/schedule-dialog';
import type { ScheduledReportRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

/** "SUCCESS", "SUCCESS: 1 recipient(s) skipped", "FAILED: reason", "SKIPPED: reason" -> badge + the API's own detail. */
export function RunStatus({ status }: { status: string | null }) {
  const { t } = useI18n();
  if (!status) return <span className="text-muted-foreground">{t('fin.reports.scheduled.neverRun')}</span>;
  const [code, ...rest] = status.split(':');
  const detail = rest.join(':').trim();
  const tone = code === 'SUCCESS' ? (detail ? 'warning' : 'success') : code === 'FAILED' ? 'danger' : 'neutral';
  const known = code === 'SUCCESS' || code === 'FAILED' || code === 'SKIPPED';
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <Badge tone={tone}>{known ? t(`fin.reports.scheduled.runStatus.${code}`) : code}</Badge>
      {detail ? <span className="text-sm text-muted-foreground" dir="auto">{detail}</span> : null}
    </span>
  );
}

export function ScheduledReports() {
  return (
    <RequirePermission anyOf={['report.export']}>
      <ScheduledReportsInner />
    </RequirePermission>
  );
}

function ScheduledReportsInner() {
  const { t, tn, formatDateTime } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const feature = useScheduledReportsFeature();
  const describeWhen = useScheduleText();
  // Reports that show a position "as of now" have no period, whatever range the schedule stores.
  const catalogue = useQuery({ queryKey: finKeys.reports.catalogue, queryFn: ({ signal }) => api.reports.catalogue(signal), staleTime: 5 * 60_000 });
  const asOfNow = React.useMemo(() => new Set((catalogue.data?.reports ?? []).filter((r) => r.asOfNow).map((r) => r.key)), [catalogue.data]);
  const [dialog, setDialog] = React.useState<{ schedule?: ScheduledReportRow; reportKey?: string } | null>(null);
  const [removing, setRemoving] = React.useState<ScheduledReportRow | null>(null);

  // /reports/scheduled?new=<report key>: the "Schedule" button of a report opens the form for that report.
  React.useEffect(() => {
    const key = new URLSearchParams(window.location.search).get('new');
    if (key !== null) {
      setDialog({ reportKey: key || undefined });
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  const toggle = React.useCallback(
    async (schedule: ScheduledReportRow) => {
      try {
        await api.reports.updateSchedule(schedule.id, { isActive: !schedule.isActive });
        toasts.success(schedule.isActive ? t('fin.reports.scheduled.paused') : t('fin.reports.scheduled.resumed'));
        await queryClient.invalidateQueries({ queryKey: finKeys.reports.scheduled });
      } catch (error) {
        toasts.error(error);
      }
    },
    [api, toasts, queryClient, t],
  );

  const columns = React.useMemo<Array<DataTableColumn<ScheduledReportRow>>>(
    () => [
      { id: 'report', header: t('fin.reports.scheduled.report'), mobile: 'title', cell: (s) => <span dir="auto">{s.reportTitle}</span> },
      { id: 'state', header: t('fin.common.status'), mobile: 'badge', cell: (s) => <Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? t('fin.reports.scheduled.active') : t('fin.reports.scheduled.inactive')}</Badge> },
      {
        id: 'when',
        header: t('fin.reports.scheduled.frequency'),
        cell: (s) => (
          <>
            <span className="block">{describeWhen(s)}</span>
            <span className="block text-sm text-muted-foreground">
              {asOfNow.has(s.reportKey) ? t('fin.reports.scheduled.asOfRange') : t(`fin.reports.ranges.${s.params.range}`)} · {t(`fin.reports.formats.${s.format.toLowerCase()}`)}
            </span>
          </>
        ),
      },
      { id: 'recipients', header: t('fin.reports.scheduled.recipients'), cell: (s) => <span title={s.recipients.join(', ')}>{tn('fin.reports.scheduled.recipientCount', s.recipients.length)}</span> },
      { id: 'next', header: t('fin.reports.scheduled.nextRun'), className: 'whitespace-nowrap tabular', cell: (s) => (s.isActive && s.nextRunAt ? formatDateTime(s.nextRunAt) : null) },
      { id: 'last', header: t('fin.reports.scheduled.lastRun'), cell: (s) => <RunStatus status={s.lastStatus} /> },
    ],
    [t, tn, formatDateTime, describeWhen, asOfNow],
  );

  const rowActions = React.useMemo<Array<RowAction<ScheduledReportRow>>>(
    () => [
      { id: 'open', label: t('fin.reports.scheduled.open'), icon: <ExternalLink aria-hidden="true" />, href: (s) => `/reports/scheduled/${s.id}` },
      { id: 'edit', label: t('common.edit'), icon: <Pencil aria-hidden="true" />, onSelect: (s) => setDialog({ schedule: s }) },
      { id: 'pause', label: t('fin.reports.scheduled.pause'), icon: <Pause aria-hidden="true" />, onSelect: (s) => void toggle(s), hidden: (s) => !s.isActive },
      { id: 'resume', label: t('fin.reports.scheduled.resume'), icon: <Play aria-hidden="true" />, onSelect: (s) => void toggle(s), hidden: (s) => s.isActive },
      { id: 'delete', label: t('common.delete'), icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: (s) => setRemoving(s) },
    ],
    [t, toggle],
  );

  const create =
    feature.included ? (
      <Button variant="accent" onClick={() => setDialog({})}>
        <Plus aria-hidden="true" />
        {t('fin.reports.scheduled.new')}
      </Button>
    ) : null;

  return (
    <>
      <PageHeader title={t('fin.reports.scheduled.title')} description={t('fin.reports.scheduled.description')} breadcrumbs={[{ label: t('fin.reports.title'), href: '/reports' }]} action={create} />
      {feature.known && !feature.included ? <UpgradeForSchedules className="mb-4" /> : null}
      <DataTable<ScheduledReportRow>
        caption={t('fin.reports.scheduled.title')}
        queryKey={finKeys.reports.scheduled}
        queryFn={(params, signal) => api.reports.scheduled({ page: params.page, pageSize: params.pageSize }, signal)}
        columns={columns}
        rowKey={(s) => s.id}
        rowHref={(s) => `/reports/scheduled/${s.id}`}
        rowActions={rowActions}
        searchable={false}
        empty={{
          icon: <CalendarClock />,
          title: t('fin.reports.scheduled.emptyTitle'),
          description: t('fin.reports.scheduled.emptyText'),
          action:
            create ?? (
              <Button asChild variant="outline">
                <Link href="/reports">{t('fin.reports.view.backToReports')}</Link>
              </Button>
            ),
        }}
      />
      {dialog ? <ScheduleDialog open onOpenChange={(open) => !open && setDialog(null)} schedule={dialog.schedule} reportKey={dialog.reportKey} /> : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('fin.reports.scheduled.deleteTitle')}
        description={t('fin.reports.scheduled.deleteText', { title: removing?.reportTitle ?? '' })}
        confirmLabel={t('fin.reports.scheduled.delete')}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api.reports.deleteSchedule(removing.id);
            toasts.success(t('fin.reports.scheduled.deleted'));
            await queryClient.invalidateQueries({ queryKey: finKeys.reports.scheduled });
          } catch (error) {
            toasts.error(error);
            throw error;
          }
        }}
      />
    </>
  );
}
