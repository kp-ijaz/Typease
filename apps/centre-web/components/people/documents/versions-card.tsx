'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { uploadDocument, type UploadSummary } from '@typease/api-client';
import { Alert, Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileUpload, useApiClient, useI18n, useSession, useToast, type Tone, type UploadItem } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { Section, useStaffNames } from '../shared';
import type { DocumentDetail, DocumentVersion } from '../types';
import { downloadDocument } from './doc-utils';
import { UPLOAD_ACCEPT, UPLOAD_ACCEPT_LABEL } from './upload-dialog';

const SCAN_TONE: Record<string, Tone> = { PENDING: 'info', CLEAN: 'success', SKIPPED: 'neutral', INFECTED: 'danger', ERROR: 'warning' };

/** Every file that was uploaded for this document, newest first. Older versions stay downloadable for staff. */
export function VersionsCard({ document: doc }: { document: DocumentDetail }) {
  const { t, has, formatDateTime, formatFileSize, formatNumber } = useI18n();
  const client = useApiClient();
  const toasts = useToast();
  const session = useSession();
  const staffName = useStaffNames();
  const [adding, setAdding] = React.useState(false);
  const canUpload = session.hasPermission('document.upload') && (doc.status === 'AVAILABLE' || doc.status === 'PENDING_SCAN');
  const versions = [...doc.versions].sort((a, b) => b.versionNo - a.versionNo);

  const scanLabel = (v: DocumentVersion) => (has(`people.documents.scan.${v.scanStatus}`) ? t(`people.documents.scan.${v.scanStatus}`) : v.scanStatus);

  return (
    <Section
      title={t('people.documents.versions.title')}
      flush
      action={
        canUpload ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Upload aria-hidden="true" />
            {t('people.documents.versions.add')}
          </Button>
        ) : null
      }
    >
      <ul className="divide-y">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                <span className="tabular">{t('people.documents.versions.number', { number: formatNumber(v.versionNo) })}</span>
                {v.isCurrent ? <Badge tone="info">{t('people.documents.versions.current')}</Badge> : null}
                <Badge tone={SCAN_TONE[v.scanStatus] ?? 'neutral'}>{scanLabel(v)}</Badge>
              </p>
              <p className="truncate text-sm text-muted-foreground" dir="auto" title={v.filename}>
                {v.filename}
              </p>
              <p className="text-sm text-muted-foreground">
                <bdi className="tabular">{formatFileSize(v.sizeBytes)}</bdi> · <bdi className="tabular">{formatDateTime(v.createdAt)}</bdi>
                {staffName(v.uploadedById) ? (
                  <>
                    {' · '}
                    <bdi>{staffName(v.uploadedById)}</bdi>
                  </>
                ) : null}
              </p>
              {v.scanStatus === 'INFECTED' && v.scanDetail ? <p className="text-sm text-destructive-text">{t('people.documents.versions.infected', { detail: v.scanDetail })}</p> : null}
            </div>
            {v.downloadable ? (
              <Button variant="ghost" size="sm" onClick={() => void downloadDocument(client, doc.id, v.isCurrent ? undefined : v.id).catch((error) => toasts.error(error))}>
                <Download aria-hidden="true" />
                {t('common.download')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {adding ? <NewVersionDialog document={doc} open onOpenChange={setAdding} /> : null}
    </Section>
  );
}

function NewVersionDialog({ document: doc, open, onOpenChange }: { document: DocumentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const upload = React.useCallback(
    (file: File, o: { onProgress: (fraction: number) => void; signal: AbortSignal }) =>
      uploadDocument(client, {
        file,
        replacesDocumentId: doc.id,
        documentTypeKey: doc.documentTypeKey,
        ...(doc.customerId ? { customerId: doc.customerId } : {}),
        ...(doc.corporateAccountId ? { corporateAccountId: doc.corporateAccountId } : {}),
        ...(doc.requestId ? { requestId: doc.requestId } : {}),
        ...o,
      }),
    [client, doc],
  );
  const onFilesChange = React.useCallback((items: UploadItem<UploadSummary>[]) => setBusy(items.some((i) => i.status === 'uploading' || i.status === 'queued')), []);
  const onUploaded = React.useCallback(() => {
    setDone(true);
    void queryClient.invalidateQueries({ queryKey: peopleKeys.documents.all });
  }, [queryClient]);

  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('people.documents.versions.addTitle')}</DialogTitle>
          <DialogDescription>{t('people.documents.versions.addText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <FileUpload<UploadSummary> upload={upload} multiple={false} onFilesChange={onFilesChange} onUploaded={onUploaded} accept={UPLOAD_ACCEPT} acceptLabel={UPLOAD_ACCEPT_LABEL} capture="environment" disabled={done} />
          {done ? (
            <Alert tone="success" live>
              {t('people.documents.versions.added')}
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant={done ? 'default' : 'outline'} onClick={() => onOpenChange(false)} disabled={busy}>
            {done ? t('common.done') : t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
