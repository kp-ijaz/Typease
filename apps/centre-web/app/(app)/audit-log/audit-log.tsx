'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, ScrollText, ShieldAlert, X } from 'lucide-react';
import {
  Badge, Button, CopyButton, DataTable, DescriptionList, PageHeader, RequirePermission, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, cn, focusRing,
  useI18n, useSession, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { StaffPicker, useStaffOptions } from '@/components/pickers';
import { useFinApi } from '@/components/fin/api';
import { useScopeParams } from '@/components/fin/scope-filters';
import { LoadError, TextLink, useDownload } from '@/components/fin/shared';
import type { AuditEntry } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const SCOPE = ['resourceType', 'resourceId', 'actorUserId'] as const;
/** Prefixes of the action names (the API filters by prefix): the areas a centre owner asks about. */
// The first part of an audit action ("invoice.voided"): the API filters by prefix.
const AREAS = [
  'request', 'task', 'document', 'customer', 'corporate', 'appointment', 'queue', 'quotation', 'invoice', 'payment', 'refund', 'creditnote', 'expense', 'reconciliation', 'finance', 'report',
  'ticket', 'reminder', 'notification', 'service', 'workflow', 'automation', 'integration', 'staff', 'role', 'branch', 'tenant', 'branding', 'domain', 'subscription', 'support_access', 'privacy', 'audit',
] as const;
const ACTORS = ['STAFF', 'CUSTOMER', 'CORPORATE', 'PLATFORM', 'SYSTEM', 'AUTOMATION'] as const;
/** Filters the table keeps in the URL; the CSV export uses exactly what is on screen. */
const EXPORT_KEYS = ['q', 'action', 'actorType', 'supportAccess', 'from', 'to', 'resourceType', 'resourceId', 'actorUserId'];

/** Where the record behind an entry lives in this app, when it has a page. */
const RESOURCE_PATHS: Record<string, (id: string) => string> = {
  Invoice: (id) => `/invoices/${id}`,
  Quotation: (id) => `/quotations/${id}`,
  Payment: (id) => `/payments/${id}`,
  Refund: (id) => `/refunds/${id}`,
  ServiceRequest: (id) => `/requests/${id}`,
  Customer: (id) => `/customers/${id}`,
  CorporateAccount: (id) => `/corporate/${id}`,
  Document: (id) => `/documents/${id}`,
  Reconciliation: (id) => `/finance/reconciliation/${id}`,
  ReconciliationRecord: (id) => `/finance/reconciliation/${id}`,
  ScheduledReport: (id) => `/reports/scheduled/${id}`,
};

export function AuditLog() {
  return (
    <RequirePermission anyOf={['audit.read']}>
      <AuditLogInner />
    </RequirePermission>
  );
}

function AuditLogInner() {
  const { t, formatDateTime } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const download = useDownload();
  const scope = useScopeParams(SCOPE);
  const maySeeStaff = session.hasAnyPermission(['staff.read', 'request.assign']);
  const staff = useStaffOptions(maySeeStaff);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const actorMember = scope.values.actorUserId ? staff.data?.find((m) => m.userId === scope.values.actorUserId) : undefined;

  const columns = React.useMemo<Array<DataTableColumn<AuditEntry>>>(
    () => [
      { id: 'when', header: t('fin.audit.columns.when'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (e) => formatDateTime(e.createdAt) },
      {
        id: 'summary',
        header: t('fin.audit.columns.what'),
        mobile: 'title',
        className: 'min-w-64',
        cell: (e) => (
          <button type="button" onClick={() => setOpenId(e.id)} className={cn('block rounded-sm text-start font-medium text-secondary-text hover:underline', focusRing)}>
            <span dir="auto">{e.summary ?? e.action}</span>
          </button>
        ),
      },
      { id: 'action', header: t('fin.audit.columns.action'), mobile: 'hidden', cell: (e) => <code className="ltr-value rounded bg-muted px-1.5 py-0.5 text-xs">{e.action}</code> },
      {
        id: 'actor',
        header: t('fin.audit.columns.who'),
        cell: (e) => (
          <>
            <span className="block" dir="auto">
              {e.actorLabel ?? t(`fin.audit.actors.${e.actorType}`)}
            </span>
            <span className="block text-sm text-muted-foreground">{t(`fin.audit.actors.${e.actorType}`)}</span>
            {/* Anything done during a support access the centre granted is marked, row by row. */}
            {e.supportGrantId ? (
              <Badge tone="warning" icon={<ShieldAlert />} className="mt-1">
                {t('fin.audit.supportBadge')}
              </Badge>
            ) : null}
          </>
        ),
      },
      { id: 'resource', header: t('fin.audit.columns.record'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (e) => e.resourceType },
    ],
    [t, formatDateTime],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'action', type: 'select', label: t('fin.audit.filters.area'), options: AREAS.map((a) => ({ value: `${a}.`, label: t(`fin.audit.areas.${a}`) })) },
      { id: 'actorType', type: 'select', label: t('fin.audit.filters.actorType'), options: ACTORS.map((a) => ({ value: a, label: t(`fin.audit.actors.${a}`) })) },
      {
        id: 'supportAccess',
        type: 'select',
        label: t('fin.audit.filters.support'),
        allLabel: t('fin.audit.filters.supportAll'),
        options: [
          { value: 'true', label: t('fin.audit.filters.supportOnly') },
          { value: 'false', label: t('fin.audit.filters.supportNone') },
        ],
      },
      { id: 'when', type: 'dateRange', label: t('fin.audit.columns.when'), fromKey: 'from', toKey: 'to' },
    ],
    [t],
  );

  const rowActions = React.useMemo<Array<RowAction<AuditEntry>>>(
    () => [
      { id: 'view', label: t('fin.audit.view'), icon: <Eye aria-hidden="true" />, onSelect: (e) => setOpenId(e.id) },
      {
        id: 'record',
        label: t('fin.audit.sameRecord'),
        icon: <ScrollText aria-hidden="true" />,
        onSelect: (e) => {
          if (!e.resourceType || !e.resourceId) return;
          scope.set('resourceType', e.resourceType);
          scope.set('resourceId', e.resourceId);
        },
        hidden: (e) => !e.resourceType || !e.resourceId,
      },
    ],
    [t, scope],
  );

  const exportCsv = () => {
    const search = new URLSearchParams(window.location.search);
    const query: Record<string, string> = {};
    for (const key of EXPORT_KEYS) {
      const value = search.get(key);
      if (value) query[key] = value;
    }
    void download.save('csv', api.audit.exportPath, { query, fallbackFilename: 'audit-log.csv' });
  };

  return (
    <>
      <PageHeader
        title={t('fin.audit.title')}
        description={t('fin.audit.description')}
        secondary={
          <Button variant="outline" onClick={exportCsv} loading={download.busy === 'csv'} loadingText={t('common.loading')} title={t('fin.audit.exportHint')}>
            <Download aria-hidden="true" />
            {t('fin.audit.export')}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3 empty:hidden">
        {maySeeStaff ? (
          <div className="w-full sm:w-72">
            <StaffPicker
              aria-label={t('fin.audit.filters.actor')}
              placeholder={t('fin.audit.filters.actorAll')}
              value={actorMember?.id ?? ''}
              onChange={(_, member) => scope.set('actorUserId', member?.userId)}
            />
          </div>
        ) : null}
        {scope.values.resourceId ? (
          <Badge tone="brand" className="h-8 gap-1 pe-1 text-sm">
            {t('fin.audit.filters.record', { type: scope.values.resourceType ?? '' })}
            <span className="ltr-value tabular">{scope.values.resourceId.slice(0, 8)}</span>
            <button
              type="button"
              aria-label={t('fin.scope.remove')}
              onClick={() => {
                scope.set('resourceType', undefined);
                scope.set('resourceId', undefined);
              }}
              className={cn('inline-flex size-6 items-center justify-center rounded-full hover:bg-secondary-soft', focusRing)}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </Badge>
        ) : null}
      </div>

      <DataTable<AuditEntry>
        caption={t('fin.audit.title')}
        queryKey={finKeys.audit.all}
        queryFn={(params, signal) => api.audit.list(params, signal)}
        fixedParams={scope.params}
        columns={columns}
        rowKey={(e) => e.id}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.audit.searchPlaceholder')}
        defaultSort="createdAt:desc"
        defaultPageSize={50}
        empty={{ icon: <ScrollText />, title: t('fin.audit.emptyTitle'), description: t('fin.audit.emptyText') }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('fin.audit.immutable')}</p>

      <EntrySheet id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

// ---------------------------------------------------------------- detail drawer

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const show = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));

function EntrySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, formatDateTime } = useI18n();
  const api = useFinApi();
  const entry = useQuery({ queryKey: finKeys.audit.detail(id ?? ''), queryFn: ({ signal }) => api.audit.get(id as string, signal), enabled: !!id, staleTime: Infinity });
  const e = entry.data;
  const before = e?.before;
  const after = e?.after;
  const keys = React.useMemo(() => [...new Set([...(isRecord(before) ? Object.keys(before) : []), ...(isRecord(after) ? Object.keys(after) : [])])], [before, after]);
  const structured = (before === null || before === undefined || isRecord(before)) && (after === null || after === undefined || isRecord(after));
  const path = e?.resourceType && e.resourceId ? RESOURCE_PATHS[e.resourceType]?.(e.resourceId) : undefined;

  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="end" className="w-[min(40rem,96vw)]">
        <SheetHeader>
          <SheetTitle dir="auto">{e ? e.summary ?? e.action : t('fin.audit.detail.title')}</SheetTitle>
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
              {e.supportGrantId ? (
                <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-foreground">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden="true" />
                  {t('fin.audit.detail.support')}
                </p>
              ) : null}
              <DescriptionList
                columns={2}
                items={[
                  { label: t('fin.audit.columns.who'), value: <span dir="auto">{e.actorLabel ?? t(`fin.audit.actors.${e.actorType}`)}</span> },
                  { label: t('fin.audit.filters.actorType'), value: t(`fin.audit.actors.${e.actorType}`) },
                  { label: t('fin.audit.columns.action'), value: <code className="ltr-value rounded bg-muted px-1.5 py-0.5 text-sm">{e.action}</code> },
                  {
                    label: t('fin.audit.columns.record'),
                    value: e.resourceType ? (
                      <>
                        {e.resourceType}
                        {path ? (
                          <TextLink href={path} className="ms-2 text-sm">
                            {t('fin.audit.detail.openRecord')}
                          </TextLink>
                        ) : null}
                      </>
                    ) : null,
                  },
                  { label: t('fin.audit.detail.ip'), value: e.ip ? <span className="ltr-value tabular">{e.ip}</span> : null },
                  { label: t('fin.audit.detail.device'), value: e.userAgent ? <span className="ltr-value break-all text-sm">{e.userAgent}</span> : null },
                  {
                    label: t('fin.audit.detail.reference'),
                    wide: true,
                    value: (
                      <span className="inline-flex items-center gap-1">
                        <span className="ltr-value tabular break-all text-sm">{e.id}</span>
                        <CopyButton value={e.id} label={t('fin.audit.detail.copyReference')} />
                      </span>
                    ),
                  },
                ]}
              />

              <section aria-labelledby="audit-changes">
                <h3 id="audit-changes" className="text-md font-semibold text-foreground">
                  {t('fin.audit.detail.changes')}
                </h3>
                <p className="mb-3 mt-1 text-sm text-muted-foreground">{t('fin.audit.detail.changesHint')}</p>
                {keys.length === 0 && structured ? (
                  <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('fin.audit.detail.noValues')}</p>
                ) : structured ? (
                  <div className="overflow-hidden rounded-lg border">
                    <table className="w-full table-fixed border-collapse text-sm">
                      <caption className="sr-only">{t('fin.audit.detail.changes')}</caption>
                      <thead className="border-b bg-muted/50 text-xs font-semibold text-muted-foreground">
                        <tr>
                          <th scope="col" className="w-[28%] px-3 py-2 text-start">
                            {t('fin.audit.detail.field')}
                          </th>
                          <th scope="col" className="px-3 py-2 text-start">
                            {t('fin.audit.detail.before')}
                          </th>
                          <th scope="col" className="px-3 py-2 text-start">
                            {t('fin.audit.detail.after')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {keys.map((key) => {
                          const b = isRecord(before) ? before[key] : undefined;
                          const a = isRecord(after) ? after[key] : undefined;
                          const changed = show(b) !== show(a);
                          return (
                            <tr key={key} className="border-b align-top last:border-0">
                              <th scope="row" className="ltr-value break-words px-3 py-2 text-start font-medium text-foreground">
                                {key}
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
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ['before', before],
                        ['after', after],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <p className="mb-1 text-xs font-semibold text-muted-foreground">{t(`fin.audit.detail.${label}`)}</p>
                        <pre dir="ltr" className="scroll-quiet max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                          {show(value) || '–'}
                        </pre>
                      </div>
                    ))}
                  </div>
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
  const text = show(value);
  return (
    <span dir="ltr" className={cn('block whitespace-pre-wrap break-words rounded px-1.5 py-0.5 text-start font-mono text-xs', tone === 'added' && 'bg-success-soft text-foreground', tone === 'removed' && 'bg-destructive-soft text-foreground line-through decoration-destructive/50')}>
      {text}
    </span>
  );
}
