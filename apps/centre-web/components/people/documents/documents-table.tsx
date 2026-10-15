'use client';

import * as React from 'react';
import { Download, ExternalLink, Eye, FolderOpen, User } from 'lucide-react';
import type { Page } from '@typease/types';
import { documentPreviewLink } from '@typease/api-client';
import { DataTable, FileViewer, addDays, useApi, useApiClient, useI18n, useSession, useToast, type DataTableColumn, type DataTableFilter, type RowAction } from '@typease/ui';
import { useDocumentTypes } from '@/components/pickers';
import { peopleKeys } from '@/lib/keys/people';
import { CustomerNameCell } from '../shared';
import type { DocumentRow } from '../types';
import { DocumentStatusChips, ExpiryCell, downloadDocument, useDocumentTypeName } from './doc-utils';

const EXPIRY_WINDOWS = [30, 60, 90, 180] as const;

/**
 * The list of documents: the whole vault, or the documents of one customer / company / request
 * (`fixedParams`). Rows open the document; preview and download go through short-lived links that
 * are requested at the moment of the click.
 */
export function DocumentsTable({
  queryKey, fixedParams, scope = 'vault', syncUrl = true, toolbar, emptyAction, emptyText,
}: {
  queryKey: readonly unknown[];
  fixedParams?: Record<string, string | number | boolean | undefined>;
  /** "vault": all filters and the owner column. "owner": inside a customer / company page. */
  scope?: 'vault' | 'owner';
  syncUrl?: boolean;
  toolbar?: React.ReactNode;
  emptyAction?: React.ReactNode;
  emptyText?: string;
}) {
  const { t, tn, pick, formatDate, formatFileSize, today } = useI18n();
  const api = useApi();
  const client = useApiClient();
  const toasts = useToast();
  const session = useSession();
  const types = useDocumentTypes();
  const typeName = useDocumentTypeName();
  const [preview, setPreview] = React.useState<DocumentRow | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<DocumentRow>>>(
    () => [
      {
        id: 'title',
        header: t('people.documents.columns.document'),
        sortField: 'title',
        mobile: 'title',
        cell: (d) => (
          <>
            <span className="block max-w-80 truncate" dir="auto" title={d.title}>
              {d.title}
            </span>
            <span className="block text-sm font-normal text-muted-foreground">{typeName(d.documentTypeKey)}</span>
          </>
        ),
      },
      { id: 'status', header: t('requests.columns.status'), mobile: 'badge', cell: (d) => <DocumentStatusChips document={d} /> },
      ...(scope === 'vault'
        ? [
            {
              id: 'owner',
              header: t('people.documents.columns.owner'),
              cell: (d: DocumentRow) => (d.customerId ? <span className="relative z-10"><CustomerNameCell id={d.customerId} /></span> : d.corporateAccountId ? <span className="whitespace-nowrap">{t('people.documents.companyFile')}</span> : null),
            } satisfies DataTableColumn<DocumentRow>,
          ]
        : []),
      { id: 'expiry', header: t('people.documents.columns.expiry'), sortField: 'expiryDate', cell: (d) => (d.expiryDate ? <ExpiryCell document={d} /> : null) },
      {
        id: 'file',
        header: t('people.documents.columns.file'),
        mobile: 'hidden',
        className: 'whitespace-nowrap text-sm text-muted-foreground',
        cell: (d) => (d.currentVersion ? `${d.currentVersion.mime.split('/')[1]?.toUpperCase() ?? ''} · ${formatFileSize(d.currentVersion.sizeBytes)}` : null),
      },
      {
        id: 'uploaded',
        header: t('people.documents.columns.uploaded'),
        sortField: 'createdAt',
        className: 'whitespace-nowrap',
        cell: (d) => (
          <>
            <span className="tabular block">{formatDate(d.createdAt)}</span>
            <span className="block text-sm text-muted-foreground">{t(`people.documents.uploadedBy.${['STAFF', 'CUSTOMER', 'CORPORATE', 'SYSTEM'].includes(d.uploadedByType) ? d.uploadedByType : 'OTHER'}`)}</span>
          </>
        ),
      },
    ],
    [t, scope, typeName, formatDate, formatFileSize],
  );

  const filters = React.useMemo<DataTableFilter[]>(() => {
    const base = today();
    return [
      { id: 'type', type: 'select', label: t('people.documents.filters.type'), options: (types.data ?? []).filter((d) => d.isActive).map((d) => ({ value: d.key, label: pick(d.name, d.nameAr) })) },
      {
        id: 'verificationStatus',
        type: 'select',
        label: t('people.documents.filters.verification'),
        options: (['UNVERIFIED', 'VERIFIED', 'REJECTED'] as const).map((v) => ({ value: v, label: t(`people.documents.verification.${v}`) })),
      },
      {
        id: 'status',
        type: 'select',
        label: t('people.documents.filters.file'),
        options: (['PENDING_SCAN', 'AVAILABLE', 'QUARANTINED'] as const).map((v) => ({ value: v, label: t(`people.documents.fileStatus.${v}`) })),
      },
      { id: 'expiringBefore', type: 'select', label: t('people.documents.filters.expiring'), allLabel: t('people.documents.filters.anyTime'), options: EXPIRY_WINDOWS.map((n) => ({ value: addDays(base, n), label: tn('people.documents.filters.withinDays', n) })) },
      ...(session.hasPermission('document.delete')
        ? [{ id: 'includeDeleted', type: 'select' as const, label: t('people.documents.filters.deleted'), allLabel: t('people.documents.filters.deletedHidden'), options: [{ value: 'true', label: t('people.documents.filters.deletedShown') }] }]
        : []),
    ];
  }, [t, tn, pick, today, types.data, session]);

  const rowActions = React.useMemo<Array<RowAction<DocumentRow>>>(
    () => [
      { id: 'open', label: t('people.documents.open'), icon: <ExternalLink aria-hidden="true" />, href: (d) => `/documents/${d.id}` },
      { id: 'preview', label: t('file.preview'), icon: <Eye aria-hidden="true" />, hidden: (d) => !d.downloadable, onSelect: (d) => setPreview(d) },
      { id: 'download', label: t('common.download'), icon: <Download aria-hidden="true" />, hidden: (d) => !d.downloadable, onSelect: (d) => void downloadDocument(client, d.id).catch((error) => toasts.error(error)) },
      ...(scope === 'vault' ? [{ id: 'customer', label: t('customers.open'), icon: <User aria-hidden="true" />, hidden: (d: DocumentRow) => !d.customerId, href: (d: DocumentRow) => `/customers/${d.customerId}` }] : []),
      { id: 'request', label: t('requests.open'), icon: <ExternalLink aria-hidden="true" />, hidden: (d) => !d.requestId, href: (d) => `/requests/${d.requestId}` },
    ],
    [t, scope, client, toasts],
  );

  return (
    <>
      <DataTable<DocumentRow>
        caption={t('people.documents.title')}
        queryKey={queryKey}
        queryFn={(params, signal) => api.client.get<Page<DocumentRow>>('/documents', { query: params, signal })}
        fixedParams={fixedParams}
        columns={columns}
        rowKey={(d) => d.id}
        rowHref={(d) => `/documents/${d.id}`}
        rowActions={rowActions}
        filters={scope === 'vault' ? filters : filters.slice(0, 2)}
        searchPlaceholder={t('people.documents.searchPlaceholder')}
        defaultSort="createdAt:desc"
        defaultPageSize={scope === 'vault' ? 20 : 10}
        syncUrl={syncUrl}
        toolbar={toolbar}
        empty={{ icon: <FolderOpen />, title: t('people.documents.emptyTitle'), description: emptyText ?? t('people.documents.emptyText'), action: emptyAction }}
      />
      {preview ? (
        <FileViewer
          open
          onOpenChange={(next) => !next && setPreview(null)}
          title={preview.title}
          getSource={async () => {
            const link = await documentPreviewLink(client, preview.id);
            return { url: link.url, mime: link.mime, filename: link.filename };
          }}
          onDownload={() => void downloadDocument(client, preview.id).catch((error) => toasts.error(error))}
        />
      ) : null}
    </>
  );
}

export const documentsQueryKey = peopleKeys.documents.all;
