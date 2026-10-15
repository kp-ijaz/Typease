'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, Download, Eye, FileCheck2, Link2, ShieldAlert, Trash2, Upload, XCircle } from 'lucide-react';
import { documentPreviewLink, uploadDocument, type UploadSummary } from '@typease/api-client';
import { Alert, Badge, Button, ConfirmDialog, FileUpload, FileViewer, Spinner, StatusBadge, cn, useApiClient, useErrorMessage, useI18n, useToast } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { ChecklistItem, RequestView } from '@/lib/types';
import { daysUntil, useDocumentDownload, useRole } from './shared';

/** What the API accepts by default (UPLOAD_ALLOWED_MIME); the API checks the real content again. */
export const UPLOAD_ACCEPT = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const UPLOAD_ACCEPT_LABEL = 'PDF, JPG, PNG';

const needsFile = (line: ChecklistItem) => line.status === 'MISSING' || line.status === 'REJECTED' || line.document?.status === 'QUARANTINED';
/** Mandatory documents the customer still has to provide. */
export const missingDocuments = (view: RequestView) => view.checklist.filter((line) => line.kind === 'INPUT' && line.isMandatory && needsFile(line));
/** A file that was just uploaded is checked for malware before anybody can open it. */
export const hasScanningDocument = (view: RequestView | undefined) => !!view?.checklist.some((line) => line.document?.status === 'PENDING_SCAN' || line.document?.status === 'PENDING_UPLOAD');

/**
 * The documents the customer has to provide for a request: what is needed, what is
 * there, what was not accepted and why. Upload (with progress), re-upload of a
 * rejected document, reuse of a valid document already on file, preview.
 */
export function DocumentChecklist({ view, onChanged, editable }: {
  view: RequestView;
  /** Called after an upload, a link or a removal: pass the new request view when the API returned one. */
  onChanged: (next?: RequestView) => void;
  /** The request still accepts documents from the customer. */
  editable: boolean;
}) {
  const { t, pick, formatDate, today } = useI18n();
  const api = usePortalApi();
  const client = useApiClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { download, busy: downloading } = useDocumentDownload();
  const company = useRole().company;

  const assist = useQuery({ queryKey: keys.requests.assist(view.id), queryFn: () => api.checklistAssist(view.id), enabled: editable });
  const candidatesOf = React.useMemo(() => new Map((assist.data?.items ?? []).map((item) => [item.checklistItemId, item.candidates])), [assist.data]);

  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [viewer, setViewer] = React.useState<{ id: string; title: string } | null>(null);
  const [removing, setRemoving] = React.useState<ChecklistItem | null>(null);

  const refresh = React.useCallback(
    (next?: RequestView) => {
      onChanged(next);
      void queryClient.invalidateQueries({ queryKey: keys.requests.assist(view.id) });
      void queryClient.invalidateQueries({ queryKey: keys.documents.all });
    },
    [onChanged, queryClient, view.id],
  );

  const link = async (line: ChecklistItem, documentId: string) => {
    setBusy(line.id);
    try {
      refresh(await api.linkDocument(view.id, line.id, documentId));
      toasts.success(t('my.checklist.linked', { name: pick(line.label, line.labelAr) }));
    } catch (error) {
      toasts.error(error);
    } finally {
      setBusy(null);
    }
  };

  const inputs = view.checklist.filter((line) => line.kind === 'INPUT');
  if (!inputs.length) return <p className="text-base text-muted-foreground">{t('my.checklist.none')}</p>;

  return (
    <>
      <ul className="divide-y rounded-lg border bg-card">
        {inputs.map((line) => {
          const doc = line.document;
          const label = pick(line.label, line.labelAr);
          const rejected = line.status === 'REJECTED';
          const blocked = doc?.status === 'QUARANTINED';
          const scanning = doc?.status === 'PENDING_SCAN' || doc?.status === 'PENDING_UPLOAD';
          const wants = needsFile(line);
          const accepted = line.status === 'VERIFIED' || line.status === 'WAIVED';
          const candidates = (candidatesOf.get(line.id) ?? []).filter((c) => c.documentId !== doc?.id);
          const expiresIn = doc?.expiryDate ? daysUntil(doc.expiryDate, today()) : null;
          const Icon = accepted ? CheckCircle2 : rejected || blocked ? XCircle : doc ? FileCheck2 : CircleDashed;
          const expanded = open === line.id;
          return (
            <li key={line.id} className={cn('p-4', line.actionRequired && 'bg-warning-soft/40')} data-checklist-status={line.status}>
              <div className="flex items-start gap-3">
                <Icon className={cn('mt-0.5 size-5 shrink-0', accepted ? 'text-success-text' : rejected || blocked ? 'text-destructive-text' : 'text-muted-foreground')} aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <p className="text-base font-medium text-foreground">{label}</p>
                    <ChecklistBadge line={line} />
                  </div>

                  {rejected ? (
                    <Alert tone="danger" title={t('my.checklist.rejectedTitle')}>
                      <span dir="auto">{line.note ?? t('my.checklist.rejectedNoReason')}</span>
                    </Alert>
                  ) : null}
                  {blocked ? <Alert tone="danger">{t('my.checklist.blocked')}</Alert> : null}
                  {scanning ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                      <Spinner size="sm" />
                      {t('my.checklist.scanning')}
                    </p>
                  ) : null}

                  {doc && !blocked ? (
                    <p className="text-sm text-muted-foreground">
                      <span dir="auto">{doc.title}</span>
                      <span aria-hidden="true"> – </span>
                      <span className="whitespace-nowrap">{t('my.checklist.uploadedOn', { date: formatDate(doc.uploadedAt) })}</span>
                      {doc.expiryDate ? (
                        <>
                          <span aria-hidden="true"> – </span>
                          <span className={cn(expiresIn !== null && expiresIn < 0 && 'font-medium text-destructive-text')}>
                            {expiresIn !== null && expiresIn < 0 ? t('my.checklist.expiredOn', { date: formatDate(doc.expiryDate) }) : t('my.checklist.validUntil', { date: formatDate(doc.expiryDate) })}
                          </span>
                        </>
                      ) : null}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {editable && wants ? (
                      <Button size="sm" variant={line.isMandatory || rejected ? 'default' : 'outline'} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : line.id)}>
                        <Upload aria-hidden="true" />
                        {rejected || blocked ? t('my.checklist.uploadNew') : t('my.checklist.upload')}
                      </Button>
                    ) : null}
                    {editable && !wants && !accepted && doc && !scanning ? (
                      <>
                        <Button size="sm" variant="outline" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : line.id)}>
                          <Upload aria-hidden="true" />
                          {t('my.checklist.replace')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(line)}>
                          <Trash2 aria-hidden="true" />
                          {t('common.remove')}
                        </Button>
                      </>
                    ) : null}
                    {doc && doc.status === 'AVAILABLE' ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setViewer({ id: doc.id, title: doc.title })}>
                          <Eye aria-hidden="true" />
                          {t('common.view')}
                        </Button>
                        <Button size="sm" variant="ghost" loading={downloading === doc.id} loadingText={t('common.loading')} onClick={() => void download(doc.id)}>
                          <Download aria-hidden="true" />
                          {t('common.download')}
                        </Button>
                      </>
                    ) : null}
                  </div>

                  {editable && wants && candidates.length ? (
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-sm text-muted-foreground">{t('my.checklist.reuseHint')}</p>
                      <ul className="mt-2 space-y-2">
                        {candidates.slice(0, 3).map((c) => (
                          <li key={c.documentId} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0 text-sm text-foreground">
                              <span dir="auto">{c.title}</span>
                              {c.expiryDate ? <span className="text-muted-foreground"> ({t('my.checklist.validUntil', { date: formatDate(c.expiryDate) })})</span> : null}
                            </span>
                            <Button size="sm" variant="subtle" loading={busy === line.id} loadingText={t('common.saving')} onClick={() => void link(line, c.documentId)}>
                              <Link2 aria-hidden="true" />
                              {t('my.checklist.reuse')}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {editable && expanded ? (
                    <div className="space-y-2">
                      <FileUpload<UploadSummary>
                        multiple={false}
                        accept={UPLOAD_ACCEPT}
                        acceptLabel={UPLOAD_ACCEPT_LABEL}
                        capture="environment"
                        // Filed under the person the request is about (an upload intent without `customerId` lands under the
                        // company); in the company's list "Passport copy" alone would not say whose it is.
                        upload={(file, o) =>
                          uploadDocument(client, {
                            file,
                            requestId: view.id,
                            checklistItemId: line.id,
                            documentTypeKey: line.documentTypeKey,
                            ...(company && view.customer.type !== 'BUSINESS' ? { customerId: view.customer.id, title: `${line.label} - ${view.customer.fullName}` } : {}),
                            ...o,
                          })
                        }
                        onUploaded={() => {
                          toasts.success(t('my.checklist.uploaded', { name: label }));
                          setOpen(null);
                          refresh();
                        }}
                      />
                      <p className="flex gap-2 text-sm text-muted-foreground">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        {t('my.checklist.uploadHint')}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {viewer ? (
        <FileViewer
          open
          onOpenChange={(next) => !next && setViewer(null)}
          title={viewer.title}
          getSource={async () => {
            const source = await documentPreviewLink(client, viewer.id);
            return { url: source.url, mime: source.mime, filename: source.filename };
          }}
          onDownload={() => void download(viewer.id)}
        />
      ) : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('my.checklist.removeTitle')}
        description={t('my.checklist.removeText', { name: removing ? pick(removing.label, removing.labelAr) : '' })}
        confirmLabel={t('common.remove')}
        onConfirm={async () => {
          if (!removing) return;
          try {
            refresh(await api.unlinkDocument(view.id, removing.id));
          } catch (error) {
            toasts.error(describe(error));
            throw error;
          }
        }}
      />
    </>
  );
}

/** The state of one checklist line in a word. A document that is only "if available" is never shown as "missing". */
export function ChecklistBadge({ line }: { line: ChecklistItem }) {
  const { t } = useI18n();
  const doc = line.document;
  if (doc?.status === 'QUARANTINED') return <StatusBadge kind="document" status="QUARANTINED" />;
  if (doc?.status === 'PENDING_SCAN' || doc?.status === 'PENDING_UPLOAD') return <StatusBadge kind="document" status="PENDING_SCAN" />;
  if (line.status === 'MISSING' && !line.isMandatory) return <Badge tone="neutral">{t('my.checklist.optional')}</Badge>;
  return <StatusBadge kind="checklist" status={line.status} />;
}

/** Files the centre produced for the customer (the result of the request). */
export function CompletedDocuments({ view }: { view: RequestView }) {
  const { t, pick, formatDate } = useI18n();
  const client = useApiClient();
  const { download, busy } = useDocumentDownload();
  const [viewer, setViewer] = React.useState<{ id: string; title: string } | null>(null);
  const ready = view.checklist.filter((line) => line.kind === 'COMPLETION' && line.document && line.document.status === 'AVAILABLE');
  if (!ready.length) return null;
  return (
    <>
      <ul className="divide-y rounded-lg border bg-card">
        {ready.map((line) => {
          const doc = line.document!;
          return (
            <li key={line.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
              <FileCheck2 className="size-6 shrink-0 text-success-text" aria-hidden="true" />
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-base font-medium text-foreground">{pick(line.label, line.labelAr)}</p>
                <p className="text-sm text-muted-foreground">
                  <span dir="auto">{doc.title}</span>
                  <span aria-hidden="true"> – </span>
                  <span className="whitespace-nowrap">{formatDate(doc.uploadedAt)}</span>
                </p>
              </div>
              <div className="flex w-full gap-2 sm:w-auto">
                <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => setViewer({ id: doc.id, title: doc.title })}>
                  <Eye aria-hidden="true" />
                  {t('common.view')}
                </Button>
                <Button className="flex-1 sm:flex-none" loading={busy === doc.id} loadingText={t('common.loading')} onClick={() => void download(doc.id)}>
                  <Download aria-hidden="true" />
                  {t('common.download')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {viewer ? (
        <FileViewer
          open
          onOpenChange={(next) => !next && setViewer(null)}
          title={viewer.title}
          getSource={async () => {
            const source = await documentPreviewLink(client, viewer.id);
            return { url: source.url, mime: source.mime, filename: source.filename };
          }}
          onDownload={() => void download(viewer.id)}
        />
      ) : null}
    </>
  );
}
