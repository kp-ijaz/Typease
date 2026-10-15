'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Eye, FolderOpen } from 'lucide-react';
import { documentPreviewLink } from '@typease/api-client';
import { Badge, DataTable, FileViewer, StatusBadge, useApiClient, useI18n, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { DocumentRow } from '@/lib/types';
import { Expiry, Ltr, PersonName, useDocumentDownload, useDocumentTypeName, useRole } from './shared';

/** The state of the file itself, or (once it is usable) whether the centre has checked it. */
export function DocumentState({ doc }: { doc: Pick<DocumentRow, 'status' | 'verificationStatus' | 'isCompletionDocument'> }) {
  const { t } = useI18n();
  if (doc.status !== 'AVAILABLE') return <StatusBadge kind="document" status={doc.status} />;
  if (doc.isCompletionDocument) return <Badge tone="success">{t('my.documents.fromCentre')}</Badge>;
  return <StatusBadge kind="verification" status={doc.verificationStatus} />;
}

/**
 * Documents of the vault the signed-in person may see (the API decides which): view through a
 * short-lived link, download, expiry at a glance. `fixedParams` narrows it (one person, one request).
 */
export function DocumentsTable({ caption, queryKey, fixedParams, filters, extraActions, compact, empty, toolbar }: {
  caption: string;
  queryKey: readonly unknown[];
  fixedParams?: Record<string, string | number | boolean | undefined>;
  filters?: DataTableFilter[];
  extraActions?: Array<RowAction<DocumentRow>>;
  /** A short list inside a card: no search, no paging controls, not in the URL. */
  compact?: boolean;
  empty: { title: string; description?: string; action?: React.ReactNode };
  toolbar?: React.ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const typeName = useDocumentTypeName();
  const company = useRole().company;
  const { download } = useDocumentDownload();
  const [viewer, setViewer] = React.useState<DocumentRow | null>(null);

  // A file that was just uploaded is checked for malware first: look again until the check is done.
  const recheck = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(recheck.current), []);
  const watchScans = React.useCallback(
    (rows: DocumentRow[]) => {
      window.clearTimeout(recheck.current);
      if (rows.some((d) => d.status === 'PENDING_SCAN' || d.status === 'PENDING_UPLOAD')) recheck.current = window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: keys.documents.all }), 3000);
    },
    [queryClient],
  );

  const columns = React.useMemo<Array<DataTableColumn<DocumentRow>>>(
    () => [
      { id: 'title', header: t('my.documents.columns.title'), sortField: compact ? undefined : 'title', mobile: 'title', cell: (d) => <span dir="auto">{d.title}</span> },
      { id: 'state', header: t('my.documents.columns.status'), mobile: 'badge', cell: (d) => <DocumentState doc={d} /> },
      // Whose document and which request: the company's list names them, a person's own list does not need to.
      ...(company && !compact
        ? [
            { id: 'person', header: t('my.documents.columns.person'), cell: (d: DocumentRow) => (d.customerName || d.customerErased ? <PersonName name={d.customerName} erased={d.customerErased} /> : <span className="text-muted-foreground">{t('my.common.yourCompany')}</span>) },
          ]
        : []),
      ...(!compact ? [{ id: 'request', header: t('my.documents.columns.request'), className: 'whitespace-nowrap', cell: (d: DocumentRow) => (d.requestNo ? <Ltr>{d.requestNo}</Ltr> : null) }] : []),
      { id: 'type', header: t('my.documents.columns.type'), cell: (d) => typeName(d.documentTypeKey) },
      { id: 'expiry', header: t('my.documents.columns.expiry'), sortField: compact ? undefined : 'expiryDate', cell: (d) => (d.expiryDate ? <Expiry date={d.expiryDate} /> : null) },
      { id: 'added', header: t('my.documents.columns.added'), sortField: compact ? undefined : 'createdAt', className: 'whitespace-nowrap', mobile: compact ? 'hidden' : 'field', cell: (d) => formatDate(d.createdAt) },
    ],
    [t, typeName, formatDate, compact, company],
  );
  const rowActions = React.useMemo<Array<RowAction<DocumentRow>>>(
    () => [
      { id: 'view', label: t('common.view'), icon: <Eye aria-hidden="true" />, onSelect: (d) => setViewer(d), hidden: (d) => !d.downloadable },
      { id: 'download', label: t('common.download'), icon: <Download aria-hidden="true" />, onSelect: (d) => void download(d.id), hidden: (d) => !d.downloadable },
      ...(extraActions ?? []),
    ],
    [t, download, extraActions],
  );

  return (
    <>
      <DataTable<DocumentRow>
        bare={compact}
        caption={caption}
        queryKey={queryKey}
        queryFn={(params, signal) => api.documents(params, signal)}
        columns={columns}
        rowKey={(d) => d.id}
        onRowClick={(d) => (d.downloadable ? setViewer(d) : undefined)}
        rowActions={rowActions}
        filters={filters}
        fixedParams={fixedParams}
        searchable={!compact}
        pagination={!compact}
        syncUrl={!compact}
        defaultPageSize={compact ? 10 : 20}
        searchPlaceholder={t('my.documents.search')}
        defaultSort="createdAt:desc"
        onPageLoaded={({ rows }) => watchScans(rows)}
        toolbar={toolbar}
        className={compact ? 'border-t' : undefined}
        empty={{ icon: <FolderOpen />, ...empty }}
      />
      {viewer ? (
        <FileViewer
          open
          onOpenChange={(open) => !open && setViewer(null)}
          title={viewer.title}
          getSource={async () => {
            // A fresh link every time the viewer opens: it lives for minutes and is never stored.
            const source = await documentPreviewLink(client, viewer.id);
            return { url: source.url, mime: source.mime, filename: source.filename };
          }}
          onDownload={() => void download(viewer.id)}
        />
      ) : null}
    </>
  );
}
