'use client';

import * as React from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarClock, ChartColumn, Download, FileSpreadsheet, FileText, FileType, ListTree } from 'lucide-react';
import {
  Alert, Button, Card, CardContent, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, EmptyState, Label, PageHeader, Pagination, RequirePermission, STATUS_META, Select, Skeleton, useI18n, useSession,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { SeriesChart, ShareBars, type ChartValueType } from '@/components/fin/charts';
import { ReportFilters, drilldownParamsOfRow, reportFilterKeys, toApiParams, useUrlReportParams, type ReportParams } from '@/components/fin/report-params';
import { ReportTable } from '@/components/fin/report-table';
import { LoadError, Section, useDownload } from '@/components/fin/shared';
import type { ReportDefinition, ReportResult, ReportRow } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const FORMAT_ICONS = { xlsx: FileSpreadsheet, pdf: FileText, csv: FileType } as const;

export function ReportView({ reportKey }: { reportKey: string }) {
  return (
    <RequirePermission anyOf={['report.operational', 'report.financial']}>
      <ReportViewInner reportKey={reportKey} />
    </RequirePermission>
  );
}

function ReportViewInner({ reportKey }: { reportKey: string }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const download = useDownload();

  const catalogue = useQuery({ queryKey: finKeys.reports.catalogue, queryFn: ({ signal }) => api.reports.catalogue(signal), staleTime: 5 * 60_000 });
  const definition = catalogue.data?.reports.find((r) => r.key === reportKey);
  const allowedKeys = React.useMemo(() => reportFilterKeys(definition), [definition]);
  const { params, update, ready } = useUrlReportParams(allowedKeys);
  const apiParams = React.useMemo(() => toApiParams(params), [params]);
  // A custom period with no date yet is not a question the API can answer: wait for a date.
  const waitingForDates = params.__custom === '1' && !params.from && !params.to;

  const report = useQuery({
    queryKey: finKeys.reports.run(reportKey, apiParams),
    queryFn: ({ signal }) => api.reports.run(reportKey, apiParams, signal),
    enabled: !!definition && ready && !waitingForDates,
    placeholderData: keepPreviousData,
  });
  const [drill, setDrill] = React.useState<{ params: ReportParams; label: string | null } | null>(null);

  const breadcrumbs = [{ label: t('fin.reports.title'), href: '/reports' }];

  if (catalogue.isPending) {
    return (
      <div className="space-y-6" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }
  if (catalogue.isError) {
    return (
      <>
        <PageHeader title={t('fin.reports.view.title')} breadcrumbs={breadcrumbs} />
        <LoadError error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      </>
    );
  }
  if (!definition) {
    return (
      <>
        <PageHeader title={t('fin.reports.view.title')} breadcrumbs={breadcrumbs} />
        <Card>
          <EmptyState
            size="page"
            icon={<ChartColumn />}
            title={t('fin.reports.view.unknownTitle')}
            description={t('fin.reports.view.unknownText')}
            action={
              <Button asChild>
                <Link href="/reports">{t('fin.reports.view.backToReports')}</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const data = report.data;
  const canExport = !!catalogue.data?.canExport && session.hasPermission('report.export');
  const formats = catalogue.data?.exportFormats ?? [];
  const exportAs = (format: string) => void download.save(format, api.reports.exportPath(reportKey), { query: { ...apiParams, format }, fallbackFilename: `${reportKey}.${format}` });

  const period = data?.period;
  /** The first column names the row; a date is shown the way the rest of the app shows dates. */
  const rowLabel = (row: ReportRow) => {
    const first = data?.columns[0];
    const value = first ? row[first.key] : null;
    if (value === null || value === undefined) return '';
    return first?.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value) : String(value);
  };
  const periodText = !period ? null : period.asOf ? t('fin.reports.view.asOf', { date: formatDateTime(period.asOf) }) : period.from && period.to ? t('fin.reports.view.period', { from: formatDate(period.from), to: formatDate(period.to) }) : null;

  return (
    <>
      <PageHeader
        title={<span dir="auto">{definition.title}</span>}
        description={<span dir="auto">{definition.description}</span>}
        breadcrumbs={breadcrumbs}
        action={
          canExport ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button loading={download.busy !== null} loadingText={t('common.loading')} disabled={!data}>
                  <Download aria-hidden="true" />
                  {t('fin.reports.view.export')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {formats.map((format) => {
                  const Icon = FORMAT_ICONS[format];
                  return (
                    <DropdownMenuItem key={format} onSelect={() => exportAs(format)}>
                      <Icon aria-hidden="true" />
                      {t(`fin.reports.formats.${format}`)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
        secondary={
          canExport ? (
            <Button asChild variant="outline">
              <Link href={`/reports/scheduled?new=${reportKey}`}>
                <CalendarClock aria-hidden="true" />
                {t('fin.reports.view.schedule')}
              </Link>
            </Button>
          ) : null
        }
      />

      <Card className="mb-6">
        <CardContent className="space-y-4">
          {definition.parameters.some((p) => !p.drilldownOnly) ? <ReportFilters definition={definition} params={params} onChange={update} /> : null}
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {waitingForDates ? t('fin.reports.view.chooseDates') : [periodText, data ? t('fin.reports.view.generated', { time: formatDateTime(data.generatedAt), zone: data.timeZone }) : null].filter(Boolean).join(' · ')}
          </p>
        </CardContent>
      </Card>

      {report.isError && !data ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : !data ? (
        waitingForDates ? null : <Skeleton className="h-80 w-full" />
      ) : (
        <div className={report.isFetching ? 'space-y-6 opacity-60 transition-opacity' : 'space-y-6'} aria-busy={report.isFetching}>
          {report.isError ? <LoadError error={report.error} onRetry={() => void report.refetch()} /> : null}

          {/* The basis of the figures is part of the report, not a footnote. */}
          {data.notes.length ? (
            <Alert tone="info" title={t('fin.reports.view.notesTitle')}>
              <ul className="list-disc space-y-1 ps-5" dir="auto">
                {data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {data.chart && data.rows.length > 0 ? (
            <Section title={t('fin.reports.view.chart')}>
              <ReportChart report={data} />
            </Section>
          ) : null}

          <Section
            title={t('fin.reports.view.table')}
            flush
            action={
              definition.hasDrilldown ? (
                <Button variant="outline" size="sm" onClick={() => setDrill({ params: {}, label: null })}>
                  <ListTree aria-hidden="true" />
                  {t('fin.reports.view.allRecords')}
                </Button>
              ) : undefined
            }
          >
            {data.rows.length === 0 ? (
              <EmptyState icon={<ChartColumn />} title={t('fin.reports.view.emptyTitle')} description={t('fin.reports.view.emptyText')} />
            ) : (
              <ReportTable
                caption={definition.title}
                columns={data.columns}
                rows={data.rows}
                totals={data.totals}
                currency={data.currency}
                links={!definition.hasDrilldown}
                drillLabel={t('fin.reports.view.details')}
                onDrill={definition.hasDrilldown ? (row) => setDrill({ params: drilldownParamsOfRow(definition, row), label: rowLabel(row) }) : undefined}
              />
            )}
          </Section>
        </div>
      )}

      {drill ? <DrilldownDialog definition={definition} base={apiParams} initial={drill.params} label={drill.label} currency={data?.currency ?? session.tenant?.currency ?? 'AED'} onClose={() => setDrill(null)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- chart

/** The chart a report offers. Series of different kinds (counts and money) get a chart each: never two scales on one. */
function ReportChart({ report }: { report: ReportResult }) {
  const chart = report.chart;
  if (!chart) return null;
  const typeOf = (key: string): ChartValueType => {
    const type = report.columns.find((c) => c.key === key)?.type;
    return type === 'money' ? 'money' : type === 'percent' ? 'percent' : 'number';
  };
  const xColumn = report.columns.find((c) => c.key === chart.x);
  const sample = report.rows[0]?.[chart.x];
  const xType = xColumn?.type === 'date' ? 'date' : typeof sample === 'string' && /^\d{4}-\d{2}$/.test(sample) ? 'month' : 'text';

  if (chart.type === 'pie') {
    const series = chart.series[0];
    return (
      <ShareBars
        label={series.label}
        valueType={typeOf(series.key)}
        currency={report.currency}
        items={report.rows.map((row) => ({ name: String(row[chart.x] ?? ''), value: Number(row[series.key] ?? 0) })).filter((item) => item.value > 0)}
      />
    );
  }
  const groups = new Map<ChartValueType, typeof chart.series>();
  for (const s of chart.series) groups.set(typeOf(s.key), [...(groups.get(typeOf(s.key)) ?? []), s]);
  // Categories on the x axis: keep the chart legible, the table below has every row.
  const rows = xType === 'text' ? report.rows.slice(0, 20) : report.rows;
  return (
    <div className={groups.size > 1 ? 'grid grid-cols-1 gap-8 lg:grid-cols-2' : undefined}>
      {[...groups.entries()].map(([valueType, series]) => (
        <div key={valueType} className="min-w-0">
          {groups.size > 1 || series.length === 1 ? <h3 className="mb-2 text-sm font-semibold text-foreground" dir="auto">{series.map((s) => s.label).join(' · ')}</h3> : null}
          <SeriesChart type={chart.type === 'line' ? 'line' : 'bar'} data={rows} xKey={chart.x} xType={xType} series={series} valueType={valueType} currency={report.currency} height={260} label={series.map((s) => s.label).join(', ')} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- drill-down

const ALL = '__all__';

function DrilldownDialog({ definition, base, initial, label, currency, onClose }: { definition: ReportDefinition; base: ReportParams; initial: ReportParams; label: string | null; currency: string; onClose: () => void }) {
  const { t, pick, has, formatDate } = useI18n();
  const api = useFinApi();
  const id = React.useId();
  // Enum values come from the API as codes: word the ones this app knows, show the rest as they are.
  const optionLabel = (param: string, option: string) => {
    if (param === 'status' && option in STATUS_META.request) return pick(STATUS_META.request[option as keyof typeof STATUS_META.request].en, STATUS_META.request[option as keyof typeof STATUS_META.request].ar);
    if (param === 'component') return t(`fin.components.${option}`);
    return has(`fin.reports.options.${option}`) ? t(`fin.reports.options.${option}`) : option;
  };
  const [extra, setExtra] = React.useState<ReportParams>(initial);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const query = React.useMemo(() => ({ ...base, ...extra, page, pageSize }), [base, extra, page, pageSize]);
  const result = useQuery({ queryKey: finKeys.reports.drilldown(definition.key, query), queryFn: ({ signal }) => api.reports.drilldown(definition.key, query, signal), placeholderData: keepPreviousData });

  // Choices the row could not make for the person (an ageing bucket, upcoming / sent).
  const choices = definition.parameters.filter((p) => p.drilldownOnly && p.type === 'enum' && p.options?.length && !(p.key in initial));
  const data = result.data;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl" className="sm:h-[88dvh]">
        <DialogHeader>
          <DialogTitle dir="auto">{label ? t('fin.reports.drilldown.titleOf', { report: definition.title, row: label }) : t('fin.reports.drilldown.title', { report: definition.title })}</DialogTitle>
          <DialogDescription>
            {t('fin.reports.drilldown.description')}
            {!label && data?.period.from && data.period.to ? ` ${t('fin.reports.view.period', { from: formatDate(data.period.from), to: formatDate(data.period.to) })}` : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="p-0 sm:p-0">
          {choices.length ? (
            <div className="flex flex-wrap items-end gap-3 border-b px-5 py-3 sm:px-6">
              {choices.map((p) => (
                <div key={p.key} className="w-full space-y-1.5 sm:w-56">
                  <Label htmlFor={`${id}-${p.key}`} dir="auto">
                    {p.label}
                  </Label>
                  <Select
                    id={`${id}-${p.key}`}
                    value={extra[p.key] ?? ALL}
                    onValueChange={(v) => {
                      setPage(1);
                      setExtra((current) => {
                        const next = { ...current };
                        if (v === ALL) delete next[p.key];
                        else next[p.key] = v;
                        return next;
                      });
                    }}
                    options={[{ value: ALL, label: t('common.all') }, ...(p.options ?? []).map((o) => ({ value: o, label: optionLabel(p.key, o) }))]}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {result.isError && !data ? (
            <div className="p-5">
              <LoadError error={result.error} onRetry={() => void result.refetch()} />
            </div>
          ) : !data ? (
            <div className="space-y-3 p-5" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : data.rows.length === 0 ? (
            <EmptyState icon={<ListTree />} title={t('fin.reports.drilldown.emptyTitle')} description={t('fin.reports.drilldown.emptyText')} />
          ) : (
            <div className={result.isFetching ? 'opacity-60 transition-opacity' : undefined} aria-busy={result.isFetching}>
              <ReportTable caption={definition.title} columns={data.columns} rows={data.rows} currency={currency} links rowKey={(row: ReportRow, i) => `${String(row.id ?? '')}-${i}`} />
            </div>
          )}
        </DialogBody>
        <DialogFooter className="sm:items-center sm:justify-between">
          <Button variant="outline" onClick={onClose} className="sm:order-2">
            {t('common.close')}
          </Button>
          {data && data.meta.total > 0 ? <Pagination className="flex-1" meta={data.meta} onPageChange={setPage} onPageSizeChange={(size) => (setPageSize(size), setPage(1))} pageSizeOptions={[20, 50, 100]} disabled={result.isFetching} /> : <span />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
