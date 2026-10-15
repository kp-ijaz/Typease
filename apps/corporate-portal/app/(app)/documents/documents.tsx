'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Upload } from 'lucide-react';
import { uploadDocument, type UploadSummary } from '@typease/api-client';
import {
  Alert, Button, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileUpload, Label, PageHeader, Select, useApiClient, useI18n,
  useSession, useToast, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { UPLOAD_ACCEPT, UPLOAD_ACCEPT_LABEL } from '@/components/portal/checklist';
import { DocumentsTable } from '@/components/portal/documents-table';
import { Gate, useCompanyAccount, useDocumentTypeName, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { DocumentRow, DocumentType } from '@/lib/types';

/** Types nobody uploads here: the centre's results and the files the system produces. */
const SYSTEM_TYPES = new Set(['completed_document', 'data_export']);

export function DocumentVault() {
  return (
    <Gate anyOf={['corp.employees.read', 'corp.requests.read', 'corp.account.read', 'self.documents']}>
      <Vault />
    </Gate>
  );
}

/**
 * The files the centre holds: for an administrator the company's own documents and those of its
 * employees (what was provided for requests and what the centre completed), for an employee their
 * own. Opened through links that live for minutes; every access is recorded by the API.
 */
function Vault() {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const session = useSession();
  const queryClient = useQueryClient();
  const { active } = useCompanyAccount();
  const types = useQuery({ queryKey: keys.documentTypes, queryFn: () => api.documentTypes(), staleTime: 10 * 60_000 });
  const [upload, setUpload] = React.useState<{ replaces?: DocumentRow } | null>(null);
  // Uploads are for whoever may add files: an employee to their own record, an administrator to the company's.
  const canUpload = session.hasAnyPermission(['self.documents', 'corp.employees.manage', 'corp.requests.create']) && active;

  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'type', type: 'select', label: t('my.documents.columns.type'), options: (types.data ?? []).filter((d) => d.isActive).map((d) => ({ value: d.key, label: pick(d.name, d.nameAr) })) }],
    [t, pick, types.data],
  );
  const extraActions = React.useMemo<Array<RowAction<DocumentRow>>>(
    () => [
      { id: 'request', label: t('my.documents.openRequest'), icon: <ClipboardList aria-hidden="true" />, hidden: (d) => !d.requestId, href: (d) => `${ROUTES.requests}/${d.requestId}` },
      ...(canUpload
        ? [
            {
              id: 'replace',
              label: t('my.documents.newVersion'),
              icon: <Upload aria-hidden="true" />,
              onSelect: (d: DocumentRow) => setUpload({ replaces: d }),
              hidden: (d: DocumentRow) => d.isCompletionDocument || SYSTEM_TYPES.has(d.documentTypeKey) || (d.status !== 'AVAILABLE' && d.status !== 'QUARANTINED'),
            },
          ]
        : []),
    ],
    [t, canUpload],
  );

  const uploadButton = canUpload ? (
    <Button variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base" onClick={() => setUpload({})} data-action="upload-document">
      <Upload aria-hidden="true" />
      {t('my.documents.upload')}
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader title={role.company ? t('nav.documents') : t('my.documents.mineTitle')} description={role.company ? t('sections.documents') : t('my.documents.mineText')} action={uploadButton} />
      <DocumentsTable
        caption={t('nav.documents')}
        queryKey={keys.documents.all}
        filters={filters}
        extraActions={extraActions}
        empty={{ title: t('my.documents.emptyTitle'), description: role.company ? t('my.documents.emptyText') : t('my.documents.emptyTextSelf'), action: uploadButton }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('my.documents.privacyNote')}</p>

      {upload ? (
        <UploadDialog
          types={(types.data ?? []).filter((d) => d.isActive && !SYSTEM_TYPES.has(d.key))}
          replaces={upload.replaces}
          company={role.company}
          onClose={() => setUpload(null)}
          onUploaded={() => void queryClient.invalidateQueries({ queryKey: keys.documents.all })}
        />
      ) : null}
    </>
  );
}

function UploadDialog({ types, replaces, company, onClose, onUploaded }: { types: DocumentType[]; replaces?: DocumentRow; company: boolean; onClose: () => void; onUploaded: () => void }) {
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
          <DialogDescription>{replaces ? t('my.documents.newVersionText', { name: replaces.title }) : company ? t('my.documents.uploadTextCompany') : t('my.documents.uploadText')}</DialogDescription>
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
            // No owner is named: the API files it under the signed-in membership (the company, or the employee's own record).
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
