'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, ScrollText, ShieldAlert } from 'lucide-react';
import {
  Badge, CopyButton, DataTable, DescriptionList, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, cn, focusRing, useI18n, type DataTableColumn, type DataTableFilter,
  type RowAction, type Tone,
} from '@typease/ui';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { AuditActorType, AuditEntry, SecurityEvent, Severity } from '@/lib/types';
import { CentreCell, Code, LoadError } from './shared';

/** Prefixes of the action names of platform-level audit entries (the API filters by prefix). */
export const AUDIT_AREAS = [
  { id: 'tenant', prefix: 'tenant.' },
  { id: 'access', prefix: 'support_access.' },
  { id: 'staff', prefix: 'platform.staff' },
  { id: 'plans', prefix: 'platform.plan' },
  { id: 'coupons', prefix: 'platform.coupon' },
  { id: 'billing', prefix: 'platform.subscription' },
  { id: 'flags', prefix: 'platform.feature' },
  { id: 'settings', prefix: 'platform.setting' },
  { id: 'providers', prefix: 'platform.approved_providers' },
  { id: 'integrations', prefix: 'integration.' },
  { id: 'privacy', prefix: 'privacy.' },
] as const;
const ACTORS: AuditActorType[] = ['PLATFORM', 'SYSTEM', 'STAFF', 'AUTOMATION'];

/**
 * The platform audit trail (GET /platform/audit-logs): what TypEase staff and platform jobs
 * did. A centre's own trail is not readable here. `centreSlug` narrows the list to the
 * entries about one centre (they carry "[centre <slug>]" in their summary).
 */
export function AuditTable({ centreSlug, embedded }: { centreSlug?: string; embedded?: boolean }) {
  const { t, has, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const [openId, setOpenId] = React.useState<string | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<AuditEntry>>>(
    () => [
      { id: 'when', header: t('audit.columns.when'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (e) => formatDateTime(e.createdAt) },
      {
        id: 'summary',
        header: t('audit.columns.what'),
        mobile: 'title',
        className: 'min-w-56',
        cell: (e) => <span dir="auto">{e.summary ?? (has(`audit.actions.${e.action.replace(/\./g, '_')}`) ? t(`audit.actions.${e.action.replace(/\./g, '_')}`) : e.action)}</span>,
      },
      { id: 'action', header: t('audit.columns.action'), mobile: 'hidden', cell: (e) => <Code>{e.action}</Code> },
      {
        id: 'actor',
        header: t('audit.columns.who'),
        className: 'whitespace-nowrap',
        cell: (e) => (
          <>
            <span className="block" dir="auto">
              {e.actorLabel ?? t(`audit.actors.${e.actorType}`)}
            </span>
            <span className="block text-sm text-muted-foreground">{t(`audit.actors.${e.actorType}`)}</span>
          </>
        ),
      },
      { id: 'resource', header: t('audit.columns.record'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (e) => e.resourceType },
    ],
    [t, has, formatDateTime],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'action', type: 'select', label: t('audit.filters.area'), options: AUDIT_AREAS.map((a) => ({ value: a.prefix, label: t(`audit.areas.${a.id}`) })) },
      { id: 'actorType', type: 'select', label: t('audit.filters.actorType'), options: ACTORS.map((a) => ({ value: a, label: t(`audit.actors.${a}`) })) },
      { id: 'when', type: 'dateRange', label: t('audit.columns.when'), fromKey: 'from', toKey: 'to' },
    ],
    [t],
  );

  const rowActions = React.useMemo<Array<RowAction<AuditEntry>>>(() => [{ id: 'view', label: t('audit.view'), icon: <Eye aria-hidden="true" />, onSelect: (e) => setOpenId(e.id) }], [t]);

  return (
    <>
      <DataTable<AuditEntry>
        caption={t('audit.tabs.log')}
        queryKey={[...keys.audit.all, centreSlug ?? '']}
        queryFn={(params, signal) => api.audit.list(centreSlug ? { ...params, q: `[centre ${centreSlug}]` } : params, signal)}
        columns={columns}
        rowKey={(e) => e.id}
        onRowClick={(e) => setOpenId(e.id)}
        rowActions={rowActions}
        filters={embedded ? filters.slice(0, 1) : filters}
        searchable={!centreSlug}
        syncUrl={!embedded}
        searchPlaceholder={t('audit.searchPlaceholder')}
        defaultSort="createdAt:desc"
        defaultPageSize={embedded ? 10 : 20}
        empty={{ icon: <ScrollText />, title: t('audit.emptyTitle'), description: centreSlug ? t('audit.emptyCentre') : t('audit.emptyText') }}
      />
      <AuditEntrySheet id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

// ---------------------------------------------------------------- one entry

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const show = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));

function AuditEntrySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const entry = useQuery({ queryKey: keys.audit.detail(id ?? ''), queryFn: ({ signal }) => api.audit.get(id as string, signal), enabled: !!id, staleTime: Infinity });
  const e = entry.data;
  const before = e?.before;
  const after = e?.after;
  const fields = React.useMemo(() => [...new Set([...(isRecord(before) ? Object.keys(before) : []), ...(isRecord(after) ? Object.keys(after) : [])])], [before, after]);
  const structured = (before === null || before === undefined || isRecord(before)) && (after === null || after === undefined || isRecord(after));

  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="end" className="w-[min(40rem,96vw)]">
        <SheetHeader>
          <SheetTitle dir="auto">{e ? e.summary ?? e.action : t('audit.detail.title')}</SheetTitle>
          <SheetDescription>{e ? formatDateTime(e.createdAt, 'long') : t('common.loading')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {entry.isPending ? (
            <div className="space-y-3" aria-hidden="true">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : entry.isError ? (
            <LoadError error={entry.error} onRetry={() => void entry.refetch()} />
          ) : e ? (
            <>
              <DescriptionList
                columns={2}
                items={[
                  { label: t('audit.columns.who'), value: <span dir="auto">{e.actorLabel ?? t(`audit.actors.${e.actorType}`)}</span> },
                  { label: t('audit.filters.actorType'), value: t(`audit.actors.${e.actorType}`) },
                  { label: t('audit.columns.action'), value: <Code className="text-sm">{e.action}</Code> },
                  { label: t('audit.columns.record'), value: e.resourceType },
                  { label: t('audit.detail.ip'), value: e.ip ? <span className="ltr-value tabular">{e.ip}</span> : null },
                  { label: t('audit.detail.device'), value: e.userAgent ? <span className="ltr-value break-all text-sm">{e.userAgent}</span> : null },
                  {
                    label: t('audit.detail.reference'),
                    wide: true,
                    value: (
                      <span className="inline-flex items-center gap-1">
                        <span className="ltr-value tabular break-all text-sm">{e.id}</span>
                        <CopyButton value={e.id} label={t('audit.detail.copyReference')} />
                      </span>
                    ),
                  },
                ]}
              />

              <section aria-labelledby="audit-changes">
                <h3 id="audit-changes" className="text-md font-semibold text-foreground">
                  {t('audit.detail.changes')}
                </h3>
                <p className="mb-3 mt-1 text-sm text-muted-foreground">{t('audit.detail.changesHint')}</p>
                {fields.length === 0 && structured ? (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('audit.detail.noValues')}</p>
                ) : structured ? (
                  <div className="overflow-hidden rounded-lg border">
                    <table className="w-full table-fixed border-collapse text-sm">
                      <caption className="sr-only">{t('audit.detail.changes')}</caption>
                      <thead className="border-b bg-muted/50 text-xs font-semibold text-muted-foreground">
                        <tr>
                          <th scope="col" className="w-[28%] px-3 py-2 text-start">
                            {t('audit.detail.field')}
                          </th>
                          <th scope="col" className="px-3 py-2 text-start">
                            {t('audit.detail.before')}
                          </th>
                          <th scope="col" className="px-3 py-2 text-start">
                            {t('audit.detail.after')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field) => {
                          const b = isRecord(before) ? before[field] : undefined;
                          const a = isRecord(after) ? after[field] : undefined;
                          const changed = show(b) !== show(a);
                          return (
                            <tr key={field} className="border-b align-top last:border-0">
                              <th scope="row" className="ltr-value break-words px-3 py-2 text-start font-medium text-foreground">
                                {field}
                              </th>
                              <td className="px-3 py-2">
                                <Value value={b} tone={changed && b !== undefined ? 'removed' : undefined} />
                              </td>
                              <td className="px-3 py-2">
                                <Value value={a} tone={changed && a !== undefined ? 'added' : undefined} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <pre dir="ltr" className="scroll-quiet max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-start text-xs">
                    {show(after ?? before) || '–'}
                  </pre>
                )}
              </section>
            </>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function Value({ value, tone }: { value: unknown; tone?: 'added' | 'removed' }) {
  if (value === undefined || value === null || value === '') return <span className="text-muted-foreground">–</span>;
  return (
    <span dir="ltr" className={cn('block whitespace-pre-wrap break-words rounded px-1.5 py-0.5 text-start font-mono text-xs', tone === 'added' && 'bg-success-soft text-foreground', tone === 'removed' && 'bg-destructive-soft text-foreground line-through decoration-destructive/50')}>
      {show(value)}
    </span>
  );
}

// ---------------------------------------------------------------- security events

export const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
export const SEVERITY_TONE: Record<Severity, Tone> = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral', INFO: 'info' };

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useI18n();
  return (
    <Badge tone={SEVERITY_TONE[severity] ?? 'neutral'} icon={severity === 'CRITICAL' || severity === 'HIGH' ? <ShieldAlert /> : undefined}>
      {t(`audit.security.severity.${severity}`)}
    </Badge>
  );
}

/** "PERMISSION_DENIED" in words; an event type the console does not know yet is shown readable, as sent. */
export function useEventTypeLabel(): (type: string) => string {
  const { t, has } = useI18n();
  return React.useCallback(
    (type: string) =>
      has(`audit.security.types.${type}`)
        ? t(`audit.security.types.${type}`)
        : type
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/^./, (c) => c.toUpperCase()),
    [t, has],
  );
}

/**
 * Security events of the platform and of all centres (GET /platform/security-events):
 * failed sign-ins, permission denials, support access, webhook problems ... Event metadata only.
 */
export function SecurityEventsTable({ centreId, type, embedded }: { centreId?: string; type?: string; embedded?: boolean }) {
  const { t, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const typeLabel = useEventTypeLabel();
  const [open, setOpen] = React.useState<SecurityEvent | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<SecurityEvent>>>(
    () => [
      { id: 'when', header: t('audit.columns.when'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (e) => formatDateTime(e.createdAt) },
      { id: 'type', header: t('audit.security.event'), mobile: 'title', className: 'min-w-56', cell: (e) => typeLabel(e.type) },
      { id: 'severity', header: t('audit.security.severityLabel'), mobile: 'badge', cell: (e) => <SeverityBadge severity={e.severity} /> },
      ...(centreId
        ? []
        : [
            {
              id: 'centre',
              header: t('pc.centre'),
              cell: (e: SecurityEvent) => (e.centre ? <CentreCell centre={e.centre} /> : <span className="text-muted-foreground">{t('audit.security.platformLevel')}</span>),
            },
          ]),
      { id: 'ip', header: t('audit.detail.ip'), mobile: 'hidden', cell: (e) => (e.ip ? <span className="ltr-value tabular">{e.ip}</span> : null) },
    ],
    [t, formatDateTime, typeLabel, centreId],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'severity', type: 'select', label: t('audit.security.severityLabel'), options: SEVERITIES.map((s) => ({ value: s, label: t(`audit.security.severity.${s}`) })) },
      ...(centreId || embedded ? [] : [{ id: 'platformOnly', type: 'select' as const, label: t('audit.security.scope'), options: [{ value: 'true', label: t('audit.security.platformOnly') }] }]),
      ...(embedded ? [] : [{ id: 'when', type: 'dateRange' as const, label: t('audit.columns.when'), fromKey: 'from', toKey: 'to' }]),
    ],
    [t, centreId, embedded],
  );

  const fixed = React.useMemo(() => ({ centreId, type }), [centreId, type]);

  return (
    <>
      <DataTable<SecurityEvent>
        caption={t('audit.tabs.security')}
        queryKey={keys.security.all}
        queryFn={(params, signal) => api.security.list(params, signal)}
        fixedParams={fixed}
        columns={columns}
        rowKey={(e) => e.id}
        onRowClick={setOpen}
        filters={filters}
        searchable={false}
        syncUrl={!embedded}
        defaultSort="createdAt:desc"
        defaultPageSize={embedded ? 10 : 20}
        empty={{ icon: <ShieldAlert />, title: t('audit.security.emptyTitle'), description: t('audit.security.emptyText') }}
      />
      <Sheet open={!!open} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent side="end" className="w-[min(36rem,96vw)]">
          <SheetHeader>
            <SheetTitle>{open ? typeLabel(open.type) : ''}</SheetTitle>
            <SheetDescription>{open ? formatDateTime(open.createdAt, 'long') : ''}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {open ? (
              <>
                <DescriptionList
                  columns={2}
                  items={[
                    { label: t('audit.security.severityLabel'), value: <SeverityBadge severity={open.severity} /> },
                    { label: t('audit.security.code'), value: <Code>{open.type}</Code> },
                    { label: t('pc.centre'), value: open.centre ? <CentreCell centre={open.centre} /> : t('audit.security.platformLevel') },
                    { label: t('audit.detail.ip'), value: open.ip ? <span className="ltr-value tabular">{open.ip}</span> : null },
                    { label: t('audit.security.account'), wide: true, value: open.userId ? <span className="ltr-value tabular break-all text-sm">{open.userId}</span> : null },
                  ]}
                />
                <section>
                  <h3 className="text-md font-semibold text-foreground">{t('audit.security.details')}</h3>
                  <p className="mb-3 mt-1 text-sm text-muted-foreground">{t('audit.security.detailsHint')}</p>
                  <pre dir="ltr" className={cn('scroll-quiet max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-start text-xs', focusRing)} tabIndex={0}>
                    {open.details && Object.keys(open.details).length ? JSON.stringify(open.details, null, 2) : '–'}
                  </pre>
                </section>
              </>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
