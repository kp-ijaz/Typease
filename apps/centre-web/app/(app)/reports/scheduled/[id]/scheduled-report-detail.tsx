'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, History, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { documentDownloadLink } from '@typease/api-client';
import {
  Badge, Button, ConfirmDialog, DescriptionList, EmptyState, PageHeader, Pagination, RequirePermission, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  useApiClient, useI18n, useSession, useToast,
} from '@typease/ui';
import { useBranches } from '@/components/branch';
import { useFinApi } from '@/components/fin/api';
import { ScheduleDialog, UpgradeForSchedules, useScheduleText, useScheduledReportsFeature } from '@/components/fin/schedule-dialog';
import { DetailSkeleton, LoadError, Section, TextLink } from '@/components/fin/shared';
import type { ScheduledRun } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';
import { RunStatus } from '../scheduled-reports';

export function ScheduledReportDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['report.export']}>
      <ScheduledReportDetailInner id={id} />
    </RequirePermission>
  );
}

function ScheduledReportDetailInner({ id }: { id: string }) {
  const { t, pick, formatDate, formatDateTime, formatFileSize, formatNumber } = useI18n();
  const api = useFinApi();
  const client = useApiClient();
  const router = useRouter();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const branches = useBranches();
  const feature = useScheduledReportsFeature();
  const describeWhen = useScheduleText();
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const schedule = useQuery({ queryKey: finKeys.reports.schedule(id), queryFn: ({ signal }) => api.reports.schedule(id, signal) });
  const catalogue = useQuery({ queryKey: finKeys.reports.catalogue, queryFn: ({ signal }) => api.reports.catalogue(signal), staleTime: 5 * 60_000 });
  const asOfNow = !!catalogue.data?.reports.find((r) => r.key === schedule.data?.reportKey)?.asOfNow;
  const runs = useQuery({ queryKey: finKeys.reports.runs(id, page), queryFn: ({ signal }) => api.reports.runs(id, { page, pageSize: 10 }, signal), placeholderData: keepPreviousData, enabled: !!schedule.data });

  const breadcrumbs = [
    { label: t('fin.reports.title'), href: '/reports' },
    { label: t('fin.reports.scheduled.title'), href: '/reports/scheduled' },
  ];

  if (schedule.isPending) return <DetailSkeleton />;
  if (schedule.isError) {
    return (
      <>
        <PageHeader title={t('fin.reports.scheduled.detailTitle')} breadcrumbs={breadcrumbs} />
        <LoadError error={schedule.error} onRetry={() => void schedule.refetch()} />
      </>
    );
  }

  const s = schedule.data;
  const branch = s.params.branchId ? branches.data?.find((b) => b.id === s.params.branchId) : null;
  const mayDownload = session.hasPermission('document.read');

  const toggle = async () => {
    setBusy('toggle');
    try {
      await api.reports.updateSchedule(s.id, { isActive: !s.isActive });
      toasts.success(s.isActive ? t('fin.reports.scheduled.paused') : t('fin.reports.scheduled.resumed'));
      await queryClient.invalidateQueries({ queryKey: finKeys.reports.scheduled });
    } catch (error) {
      toasts.error(error);
    } finally {
      setBusy(null);
    }
  };

  /** Generated files live in the document vault: a short-lived link from the documents API starts the download. */
  const downloadRun = async (run: ScheduledRun) => {
    if (!run.documentId) return;
    setBusy(run.documentId);
    try {
      const link = await documentDownloadLink(client, run.documentId);
      window.location.assign(link.url);
    } catch (error) {
      toasts.error(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={<span dir="auto">{s.reportTitle}</span>}
        breadcrumbs={breadcrumbs}
        meta={<Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? t('fin.reports.scheduled.active') : t('fin.reports.scheduled.inactive')}</Badge>}
        description={t('fin.reports.scheduled.detailDescription')}
        action={
          <Button onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" />
            {t('common.edit')}
          </Button>
        }
        secondary={
          <>
            <Button variant="outline" onClick={() => void toggle()} loading={busy === 'toggle'} loadingText={t('common.saving')}>
              {s.isActive ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {s.isActive ? t('fin.reports.scheduled.pause') : t('fin.reports.scheduled.resume')}
            </Button>
            <Button variant="destructive-outline" onClick={() => setRemoving(true)}>
              <Trash2 aria-hidden="true" />
              {t('common.delete')}
            </Button>
          </>
        }
      />
      {feature.known && !feature.included ? <UpgradeForSchedules className="mb-6" /> : null}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Section title={t('fin.reports.scheduled.what')}>
            <DescriptionList
              columns={3}
              items={[
                { label: t('fin.reports.scheduled.report'), value: <TextLink href={`/reports/${s.reportKey}?${asOfNow ? '' : `range=${s.params.range}`}${s.params.branchId ? `&branchId=${s.params.branchId}` : ''}`}>{s.reportTitle}</TextLink> },
                { label: t('fin.reports.scheduled.range'), value: asOfNow ? t('fin.reports.scheduled.asOfRange') : t(`fin.reports.ranges.${s.params.range}`) },
                { label: t('fin.common.branch'), value: s.params.branchId ? (branch ? pick(branch.name, branch.nameAr) : t('fin.reports.scheduled.oneBranch')) : t('shell.allBranches') },
                { label: t('fin.reports.scheduled.format'), value: t(`fin.reports.formats.${s.format.toLowerCase()}`) },
                { label: t('fin.reports.scheduled.frequency'), value: describeWhen(s) },
                { label: t('fin.reports.scheduled.nextRun'), value: s.isActive && s.nextRunAt ? formatDateTime(s.nextRunAt) : t('fin.reports.scheduled.notPlanned') },
                { label: t('fin.reports.scheduled.lastRun'), value: <RunStatus status={s.lastStatus} />, wide: true },
              ]}
            />
            <p className="mt-4 text-sm text-muted-foreground">{t('fin.reports.scheduled.clockNote', { zone: s.timeZone })}</p>
          </Section>

          <Section title={t('fin.reports.scheduled.history')} description={t('fin.reports.scheduled.historyHint')} flush>
            {runs.isPending ? (
              <div className="space-y-3 p-5" aria-hidden="true">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : runs.isError ? (
              <div className="p-5">
                <LoadError error={runs.error} onRetry={() => void runs.refetch()} />
              </div>
            ) : runs.data.data.length === 0 ? (
              <EmptyState icon={<History />} title={t('fin.reports.scheduled.noRuns')} description={s.isActive && s.nextRunAt ? t('fin.reports.scheduled.noRunsText', { date: formatDateTime(s.nextRunAt) }) : undefined} />
            ) : (
              <>
                <Table>
                  <caption className="sr-only">{t('fin.reports.scheduled.history')}</caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('fin.reports.scheduled.ranAt')}</TableHead>
                      <TableHead>{t('fin.common.period')}</TableHead>
                      <TableHead>{t('fin.reports.scheduled.result')}</TableHead>
                      <TableHead>{t('fin.reports.scheduled.file')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.data.data.map((run) => (
                      <TableRow key={`${run.ranAt}-${run.documentId ?? ''}`} className="hover:bg-transparent">
                        <TableCell className="whitespace-nowrap tabular">{formatDateTime(run.ranAt)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular">{run.period ? `${formatDate(run.period.from)} – ${formatDate(run.period.to)}` : <span className="text-muted-foreground">–</span>}</TableCell>
                        <TableCell>
                          <RunStatus status={run.detail ? `${run.status}: ${run.detail}` : run.status} />
                          {run.rows !== null && run.rows !== undefined ? <span className="block text-sm text-muted-foreground">{t('fin.reports.scheduled.rows', { count: formatNumber(run.rows), recipients: formatNumber(run.recipients?.length ?? 0) })}</span> : null}
                        </TableCell>
                        <TableCell>
                          {run.document?.available && run.documentId ? (
                            mayDownload ? (
                              <Button variant="subtle" size="sm" loading={busy === run.documentId} onClick={() => void downloadRun(run)} title={run.document.filename}>
                                <Download aria-hidden="true" />
                                {run.format ?? t('common.download')} · {formatFileSize(run.document.sizeBytes)}
                              </Button>
                            ) : (
                              <span className="text-sm text-muted-foreground">{t('fin.reports.scheduled.noDocumentAccess')}</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {runs.data.meta.totalPages > 1 ? (
                  <div className="border-t px-4 py-3">
                    <Pagination meta={runs.data.meta} onPageChange={setPage} disabled={runs.isFetching} />
                  </div>
                ) : null}
              </>
            )}
          </Section>
        </div>

        <Section title={t('fin.reports.scheduled.recipients')} description={t('fin.reports.scheduled.recipientsNote')}>
          <ul className="space-y-1.5">
            {s.recipients.map((address) => (
              <li key={address} className="truncate text-base" title={address}>
                <span className="ltr-value">{address}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {editing ? <ScheduleDialog open onOpenChange={(open) => !open && setEditing(false)} schedule={s} /> : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('fin.reports.scheduled.deleteTitle')}
        description={t('fin.reports.scheduled.deleteText', { title: s.reportTitle })}
        confirmLabel={t('fin.reports.scheduled.delete')}
        onConfirm={async () => {
          try {
            await api.reports.deleteSchedule(s.id);
            toasts.success(t('fin.reports.scheduled.deleted'));
            // Leave first: refreshing this page's own query would only find that the schedule is gone.
            router.push('/reports/scheduled');
            void queryClient.invalidateQueries({ queryKey: [...finKeys.reports.scheduled, 'list'] });
          } catch (error) {
            toasts.error(error);
            throw error;
          }
        }}
      />
    </>
  );
}
