'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Download, Eye, FolderOpen, Upload } from 'lucide-react';
import { documentPreviewLink, uploadDocument, type UploadSummary } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, CardContent, DataTable, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileUpload, FileViewer,
  Label, PageHeader, Select, StatusBadge, cn, useApiClient, useI18n, useToast, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { UPLOAD_ACCEPT, UPLOAD_ACCEPT_LABEL } from '@/components/portal/checklist';
import { SectionTitle, daysUntil, useDocumentDownload, useDocumentTypeName } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { DocumentRow, DocumentType } from '@/lib/types';

/** Types a customer never uploads: the centre's results and the files the system produces. */
const SYSTEM_TYPES = new Set(['completed_document', 'data_export']);

/** The state of the file itself, or (once it is usable) whether the centre has checked it. */
function DocumentState({ doc }: { doc: Pick<DocumentRow, 'status' | 'verificationStatus' | 'isCompletionDocument'> }) {
  const { t } = useI18n();
  if (doc.status !== 'AVAILABLE') return <StatusBadge kind="document" status={doc.status} />;
  if (doc.isCompletionDocument) return <Badge tone="success">{t('my.documents.fromCentre')}</Badge>;
  return <StatusBadge kind="verification" status={doc.verificationStatus} />;
}

function Expiry({ doc }: { doc: Pick<DocumentRow, 'expiryDate' | 'expiryVerified'> }) {
  const { t, tn, formatDate, today } = useI18n();
  if (!doc.expiryDate) return null;
  const days = daysUntil(doc.expiryDate, today());
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="tabular whitespace-nowrap">{formatDate(doc.expiryDate)}</span>
      {days < 0 ? <Badge tone="danger">{t('my.documents.expired')}</Badge> : days <= 90 ? <Badge tone="warning">{tn('my.documents.expiresIn', days)}</Badge> : null}
    </span>
  );
}

/** The customer's document vault: what they uploaded and what the centre completed for them. */
export function DocumentVault() {
  const { t, pick, formatDate, formatFileSize } = useI18n();
  const api = usePortalApi();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const typeName = useDocumentTypeName();
  const { download } = useDocumentDownload();
  const types = useQuery({ queryKey: keys.documentTypes, queryFn: () => api.documentTypes(), staleTime: 10 * 60_000 });
  const [viewer, setViewer] = React.useState<DocumentRow | null>(null);
  const [upload, setUpload] = React.useState<{ replaces?: DocumentRow } | null>(null);
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

  const uploadButton = (
    <Button variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base" onClick={() => setUpload({})}>
      <Upload aria-hidden="true" />
      {t('my.documents.upload')}
    </Button>
  );

  const columns = React.useMemo<Array<DataTableColumn<DocumentRow>>>(
    () => [
      { id: 'title', header: t('my.documents.columns.title'), sortField: 'title', mobile: 'title', cell: (d) => <span dir="auto">{d.title}</span> },
      { id: 'state', header: t('my.documents.columns.status'), mobile: 'badge', cell: (d) => <DocumentState doc={d} /> },
      { id: 'type', header: t('my.documents.columns.type'), cell: (d) => typeName(d.documentTypeKey) },
      { id: 'expiry', header: t('my.documents.columns.expiry'), sortField: 'expiryDate', cell: (d) => (d.expiryDate ? <Expiry doc={d} /> : null) },
      { id: 'added', header: t('my.documents.columns.added'), sortField: 'createdAt', className: 'whitespace-nowrap', cell: (d) => formatDate(d.createdAt) },
      { id: 'size', header: t('my.documents.columns.size'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (d) => (d.currentVersion ? <span className="tabular ltr-value">{formatFileSize(d.currentVersion.sizeBytes)}</span> : null) },
    ],
    [t, typeName, formatDate, formatFileSize],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'type', type: 'select', label: t('my.documents.columns.type'), options: (types.data ?? []).filter((d) => d.isActive).map((d) => ({ value: d.key, label: pick(d.name, d.nameAr) })) }],
    [t, pick, types.data],
  );
  const rowActions = React.useMemo<Array<RowAction<DocumentRow>>>(
    () => [
      { id: 'view', label: t('common.view'), icon: <Eye aria-hidden="true" />, onSelect: (d) => setViewer(d), hidden: (d) => !d.downloadable },
      { id: 'download', label: t('common.download'), icon: <Download aria-hidden="true" />, onSelect: (d) => void download(d.id), hidden: (d) => !d.downloadable },
      {
        id: 'replace',
        label: t('my.documents.newVersion'),
        icon: <Upload aria-hidden="true" />,
        onSelect: (d) => setUpload({ replaces: d }),
        hidden: (d) => d.isCompletionDocument || SYSTEM_TYPES.has(d.documentTypeKey) || (d.status !== 'AVAILABLE' && d.status !== 'QUARANTINED'),
      },
    ],
    [t, download],
  );

  return (
    <>
      <PageHeader title={t('nav.documents')} description={t('account.sections.documents')} action={uploadButton} />
      <ExpiringSoon />
      <DataTable<DocumentRow>
        caption={t('nav.documents')}
        queryKey={keys.documents.all}
        queryFn={(params, signal) => api.documents(params, signal)}
        columns={columns}
        rowKey={(d) => d.id}
        onRowClick={(d) => (d.downloadable ? setViewer(d) : undefined)}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('my.documents.search')}
        defaultSort="createdAt:desc"
        onPageLoaded={({ rows }) => watchScans(rows)}
        empty={{ icon: <FolderOpen />, title: t('my.documents.emptyTitle'), description: t('my.documents.emptyText'), action: uploadButton }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('my.documents.privacyNote')}</p>

      {viewer ? (
        <FileViewer
          open
          onOpenChange={(open) => !open && setViewer(null)}
          title={viewer.title}
          getSource={async () => {
            // A fresh link every time the viewer opens: it lives for two minutes and is never stored.
            const source = await documentPreviewLink(client, viewer.id);
            return { url: source.url, mime: source.mime, filename: source.filename };
          }}
          onDownload={() => void download(viewer.id)}
        />
      ) : null}
      {upload ? (
        <UploadDialog
          types={(types.data ?? []).filter((d) => d.isActive && !SYSTEM_TYPES.has(d.key))}
          replaces={upload.replaces}
          onClose={() => setUpload(null)}
          onUploaded={() => void queryClient.invalidateQueries({ queryKey: keys.documents.all })}
        />
      ) : null}
    </>
  );
}

/** Documents whose expiry the centre tracks for the customer, soonest first, with the renewal request one tap away. */
function ExpiringSoon() {
  const { t, tn, pick, formatDate } = useI18n();
  const api = usePortalApi();
  const reminders = useQuery({ queryKey: keys.reminders, queryFn: () => api.reminders() });
  const soon = (reminders.data?.data ?? []).filter((r) => r.status === 'ACTIVE' && r.daysLeft <= 90).sort((a, b) => a.daysLeft - b.daysLeft);
  if (!soon.length) return null;
  return (
    <Card className="mb-5 border-warning/50 bg-warning-soft/40">
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2.5">
          <CalendarClock className="size-5 text-warning-text" aria-hidden="true" />
          <SectionTitle className="text-md">{t('my.documents.expiring.title')}</SectionTitle>
        </div>
        <ul className="space-y-3">
          {soon.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="min-w-0 text-base">
                <span className="font-medium">{pick(r.documentTypeName, r.documentTypeNameAr)}</span>
                <span aria-hidden="true"> – </span>
                <span className={cn(r.daysLeft < 0 && 'text-destructive-text')}>
                  {r.daysLeft < 0 ? t('my.documents.expiring.expiredOn', { date: formatDate(r.expiryDate) }) : t('my.documents.expiring.on', { date: formatDate(r.expiryDate), left: tn('my.documents.expiresIn', r.daysLeft) })}
                </span>
              </p>
              {r.renewalRequestId ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/requests/${r.renewalRequestId}`}>{t('my.documents.expiring.openRenewal')}</Link>
                </Button>
              ) : (
                <Button asChild size="sm">
                  <Link href={r.renewalPath}>{t('my.documents.expiring.renew')}</Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t('my.documents.expiring.note')}</p>
      </CardContent>
    </Card>
  );
}

function UploadDialog({ types, replaces, onClose, onUploaded }: { types: DocumentType[]; replaces?: DocumentRow; onClose: () => void; onUploaded: () => void }) {
  const { t, pick, today } = useI18n();
  const client = useApiClient();
  const toasts = useToast();
  const typeName = useDocumentTypeName();
  const [type, setType] = React.useState(replaces?.documentTypeKey ?? '');
  const [expiry, setExpiry] = React.useState('');
  const [done, setDone] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const typeId = React.useId();
  const expiryId = React.useId();
  const chosen = types.find((d) => d.key === type);
  const hasExpiry = chosen?.hasExpiry ?? false;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{replaces ? t('my.documents.newVersion') : t('my.documents.upload')}</DialogTitle>
          <DialogDescription>{replaces ? t('my.documents.newVersionText', { name: replaces.title }) : t('my.documents.uploadText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {replaces ? (
            <p className="rounded-md bg-muted/60 px-3 py-2 text-base">
              <span className="text-muted-foreground">{t('my.documents.columns.type')}:</span> {typeName(replaces.documentTypeKey)}
            </p>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor={typeId} required>
                {t('my.documents.whatIsIt')}
              </Label>
              <Select id={typeId} value={type} onValueChange={setType} placeholder={t('common.selectPlaceholder')} options={types.map((d) => ({ value: d.key, label: pick(d.name, d.nameAr) }))} />
            </div>
          )}
          {hasExpiry ? (
            <div className="space-y-1.5">
              <Label htmlFor={expiryId} optionalText={t('common.optional')}>
                {t('my.documents.expiryDate')}
              </Label>
              <DatePicker id={expiryId} value={expiry} min={today()} onChange={setExpiry} />
              <p className="text-sm text-muted-foreground">{t('my.documents.expiryHint')}</p>
            </div>
          ) : null}
          <FileUpload<UploadSummary>
            multiple={!replaces}
            maxFiles={5}
            accept={UPLOAD_ACCEPT}
            acceptLabel={UPLOAD_ACCEPT_LABEL}
            capture="environment"
            disabled={!type}
            upload={(file, o) => uploadDocument(client, { file, documentTypeKey: type, ...(replaces ? { replacesDocumentId: replaces.id } : {}), ...(expiry ? { expiryDate: expiry } : {}), ...o })}
            onFilesChange={(items) => setBusy(items.some((i) => i.status === 'uploading' || i.status === 'queued'))}
            onUploaded={() => {
              setDone((n) => n + 1);
              onUploaded();
            }}
          />
          {!type ? <p className="text-sm text-muted-foreground">{t('my.documents.chooseTypeFirst')}</p> : null}
          {done > 0 ? (
            <Alert tone="success" live>
              {t('my.documents.uploadedNote')}
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant={done > 0 ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => {
              if (done > 0) toasts.success(t('my.documents.uploadedToast'));
              onClose();
            }}
          >
            {done > 0 ? t('common.done') : t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
