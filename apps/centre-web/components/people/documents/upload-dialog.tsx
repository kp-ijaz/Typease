'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { uploadDocument, type UploadSummary } from '@typease/api-client';
import {
  Alert, Button, ChoiceLabel, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileUpload, Input, Label, RadioGroup, RadioGroupItem, Select, Switch,
  useApi, useApiClient, useI18n, useSession, type UploadItem,
} from '@typease/ui';
import { CorporateAccountPicker, CustomerPicker, DocumentTypePicker, type DocumentTypeOption } from '@/components/pickers';
import { peopleKeys } from '@/lib/keys/people';
import { RecordLink } from '../shared';

export const UPLOAD_ACCEPT = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const UPLOAD_ACCEPT_LABEL = 'PDF, JPG, PNG, WebP';

export interface UploadOwner {
  customerId?: string;
  customerName?: string;
  corporateAccountId?: string;
  corporateName?: string;
  requestId?: string;
}

const NO_REQUEST = '__none__';

/**
 * Upload one or several files to the vault. The owner and the type are chosen first, because every file
 * starts uploading as soon as it is added (three steps per file: intent, the bytes to a one-time signed
 * URL, confirm). After the upload a file is checked for malware before anybody can open it.
 */
export function UploadDocumentDialog({ open, onOpenChange, owner, lockOwner = false }: { open: boolean; onOpenChange: (open: boolean) => void; owner?: UploadOwner; lockOwner?: boolean }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const client = useApiClient();
  const session = useSession();
  const queryClient = useQueryClient();
  const ids = React.useId();

  const [ownerKind, setOwnerKind] = React.useState<'customer' | 'company'>(owner?.corporateAccountId && !owner.customerId ? 'company' : 'customer');
  const [customerId, setCustomerId] = React.useState(owner?.customerId ?? '');
  const [corporateAccountId, setCorporateAccountId] = React.useState(owner?.corporateAccountId ?? '');
  const [type, setType] = React.useState<DocumentTypeOption | null>(null);
  const [typeKey, setTypeKey] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [requestId, setRequestId] = React.useState(owner?.requestId ?? '');
  const [expiryDate, setExpiryDate] = React.useState('');
  const [customerVisible, setCustomerVisible] = React.useState(true);
  const [uploaded, setUploaded] = React.useState<UploadSummary[]>([]);
  const [busy, setBusy] = React.useState(false);

  const canPickCompany = session.hasPermission('corporate.read');
  const ownerId = ownerKind === 'customer' ? customerId : corporateAccountId;
  const ready = !!ownerId && !!typeKey;

  // Open requests of the chosen customer, so the file can be filed under one of them.
  const requests = useQuery({
    queryKey: [...peopleKeys.customers.tab(customerId, 'requests'), 'upload-options'],
    queryFn: () => api.requests.list({ customerId, pageSize: 50, sort: 'createdAt:desc' }),
    enabled: open && ownerKind === 'customer' && !!customerId && session.hasAnyPermission(['request.read.all', 'request.read.assigned']),
  });
  const requestOptions = (requests.data?.data ?? []).filter((r) => !['COMPLETED', 'CANCELLED'].includes(r.status) || r.id === requestId);

  const upload = React.useCallback(
    (file: File, o: { onProgress: (fraction: number) => void; signal: AbortSignal }) =>
      uploadDocument(client, {
        file,
        ...(ownerKind === 'customer' ? { customerId } : { corporateAccountId }),
        ...(ownerKind === 'customer' && requestId ? { requestId } : {}),
        documentTypeKey: typeKey,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(expiryDate ? { expiryDate } : {}),
        customerVisible,
        ...o,
      }),
    [client, ownerKind, customerId, corporateAccountId, requestId, typeKey, title, expiryDate, customerVisible],
  );

  const onFilesChange = React.useCallback((items: UploadItem<UploadSummary>[]) => setBusy(items.some((i) => i.status === 'uploading' || i.status === 'queued')), []);
  const onUploaded = React.useCallback(
    (item: UploadItem<UploadSummary>) => {
      if (item.result) setUploaded((list) => [...list, item.result as UploadSummary]);
      void queryClient.invalidateQueries({ queryKey: peopleKeys.documents.all });
      void queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all });
    },
    [queryClient],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('people.documents.upload.title')}</DialogTitle>
          <DialogDescription>{t('people.documents.upload.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          <fieldset className="space-y-4" disabled={uploaded.length > 0 || busy}>
            <legend className="text-md font-semibold text-foreground">{t('people.documents.upload.stepDetails')}</legend>

            {lockOwner ? (
              <p className="text-base">
                <span className="text-muted-foreground">{t('people.documents.upload.belongsTo')} </span>
                <span className="font-medium text-foreground">{owner?.customerName ?? owner?.corporateName}</span>
              </p>
            ) : (
              <>
                {canPickCompany ? (
                  <RadioGroup value={ownerKind} onValueChange={(v) => setOwnerKind(v as 'customer' | 'company')} aria-label={t('people.documents.upload.belongsTo')} className="flex flex-wrap gap-x-8 gap-y-2">
                    <ChoiceLabel htmlFor={`${ids}-o-customer`} control={<RadioGroupItem id={`${ids}-o-customer`} value="customer" />} label={t('people.documents.upload.ownerCustomer')} />
                    <ChoiceLabel htmlFor={`${ids}-o-company`} control={<RadioGroupItem id={`${ids}-o-company`} value="company" />} label={t('people.documents.upload.ownerCompany')} />
                  </RadioGroup>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}-owner`} required>
                    {ownerKind === 'customer' ? t('people.documents.upload.customer') : t('people.documents.upload.company')}
                  </Label>
                  {ownerKind === 'customer' ? (
                    <CustomerPicker
                      id={`${ids}-owner`}
                      value={customerId}
                      selectedLabel={owner?.customerName}
                      onChange={(id) => {
                        setCustomerId(id);
                        setRequestId('');
                      }}
                    />
                  ) : (
                    <CorporateAccountPicker id={`${ids}-owner`} value={corporateAccountId} selectedLabel={owner?.corporateName} onChange={(id) => setCorporateAccountId(id)} />
                  )}
                </div>
              </>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-type`} required>
                  {t('people.documents.fields.type')}
                </Label>
                <DocumentTypePicker
                  id={`${ids}-type`}
                  value={typeKey}
                  onChange={(key, option) => {
                    setTypeKey(key);
                    setType(option);
                    if (!option?.hasExpiry) setExpiryDate('');
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-title`} optionalText={t('common.optional')}>
                  {t('people.documents.fields.title')}
                </Label>
                <Input id={`${ids}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoComplete="off" dir="auto" placeholder={type ? pick(type.name, type.nameAr) : undefined} />
              </div>
              {ownerKind === 'customer' && customerId && requestOptions.length > 0 ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}-request`} optionalText={t('common.optional')}>
                    {t('people.documents.upload.request')}
                  </Label>
                  <Select
                    id={`${ids}-request`}
                    value={requestId || NO_REQUEST}
                    onValueChange={(v) => setRequestId(v === NO_REQUEST ? '' : v)}
                    options={[{ value: NO_REQUEST, label: t('people.documents.upload.noRequest') }, ...requestOptions.map((r) => ({ value: r.id, label: `${r.requestNo} · ${pick(r.service.name, r.service.nameAr)}` }))]}
                  />
                </div>
              ) : null}
              {type?.hasExpiry ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}-expiry`} optionalText={t('common.optional')}>
                    {t('people.documents.fields.expiryDate')}
                  </Label>
                  <DatePicker id={`${ids}-expiry`} value={expiryDate} onChange={setExpiryDate} />
                  <p className="text-sm text-muted-foreground">{t('people.documents.upload.expiryHint')}</p>
                </div>
              ) : null}
            </div>
            <ChoiceLabel
              htmlFor={`${ids}-visible`}
              control={<Switch id={`${ids}-visible`} checked={customerVisible} onCheckedChange={setCustomerVisible} />}
              label={t('people.documents.fields.customerVisible')}
              description={t('people.documents.upload.customerVisibleHint')}
            />
          </fieldset>

          <div className="space-y-3">
            <p className="text-md font-semibold text-foreground">{t('people.documents.upload.stepFiles')}</p>
            {ready ? null : <p className="text-sm text-muted-foreground">{t('people.documents.upload.chooseFirst')}</p>}
            <FileUpload<UploadSummary> upload={upload} onFilesChange={onFilesChange} onUploaded={onUploaded} accept={UPLOAD_ACCEPT} acceptLabel={UPLOAD_ACCEPT_LABEL} capture="environment" disabled={!ready} />
          </div>

          {uploaded.length > 0 ? (
            <Alert tone="success" live title={t('people.documents.upload.doneTitle')}>
              <p className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {t('people.documents.upload.doneText')}
              </p>
              <ul className="mt-2 space-y-1">
                {uploaded.map((u) => (
                  <li key={u.versionId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate" dir="auto">
                      {u.filename}
                    </span>
                    <RecordLink href={`/documents/${u.documentId}`}>{t('people.documents.open')}</RecordLink>
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant={uploaded.length ? 'default' : 'outline'} onClick={() => onOpenChange(false)} disabled={busy}>
            {uploaded.length ? t('common.done') : t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
