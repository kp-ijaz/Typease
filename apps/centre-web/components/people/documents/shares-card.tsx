'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Share2 } from 'lucide-react';
import { documentShareSchema } from '@typease/validation';
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField, Input, Select, Skeleton,
  useApi, useI18n, useSession, useToast, useZodForm, type Tone,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, Section } from '../shared';
import type { DocumentDetail, DocumentShare } from '../types';

const HOURS = [1, 24, 72, 168] as const;

type ShareState = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'USED';
const STATE_TONE: Record<ShareState, Tone> = { ACTIVE: 'success', REVOKED: 'neutral', EXPIRED: 'neutral', USED: 'neutral' };
function stateOf(share: DocumentShare, now: number): ShareState {
  if (share.revokedAt) return 'REVOKED';
  if (Date.parse(share.expiresAt) <= now) return 'EXPIRED';
  if (share.downloadCount >= share.maxDownloads) return 'USED';
  return 'ACTIVE';
}

/**
 * Secure sharing: a link that expires and allows a limited number of downloads. There are no permanent
 * links. The address is shown once, right after it was created; the API only keeps a hash of it.
 */
export function SharesCard({ document: doc }: { document: DocumentDetail }) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState<DocumentShare | null>(null);
  // "Now" for the expired / active labels, taken after mount and refreshed with the list.
  const [now, setNow] = React.useState(0);

  const shares = useQuery({ queryKey: peopleKeys.documents.shares(doc.id), queryFn: () => api.client.get<DocumentShare[]>(`/documents/${doc.id}/shares`) });
  React.useEffect(() => setNow(Date.now()), [shares.dataUpdatedAt]);

  const revoke = async (share: DocumentShare) => {
    try {
      await api.client.delete(`/documents/${doc.id}/shares/${share.id}`);
      toasts.success(t('people.documents.share.revoked'));
      await queryClient.invalidateQueries({ queryKey: peopleKeys.documents.detail(doc.id) });
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  if (!session.hasPermission('document.share')) return null;
  const canCreate = doc.status === 'AVAILABLE' && doc.downloadable;
  const list = shares.data ?? [];

  return (
    <Section
      title={t('people.documents.share.title')}
      description={t('people.documents.share.description')}
      flush
      action={
        <Button variant="outline" size="sm" onClick={() => setCreating(true)} disabled={!canCreate}>
          <Share2 aria-hidden="true" />
          {t('people.documents.share.create')}
        </Button>
      }
    >
      {shares.isPending ? (
        <div className="space-y-2 p-5" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : shares.isError ? (
        <div className="p-4">
          <LoadError error={shares.error} onRetry={() => void shares.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState className="py-8" icon={<Link2 />} title={t('people.documents.share.empty')} description={canCreate ? t('people.documents.share.emptyText') : t('people.documents.share.notAvailable')} />
      ) : (
        <ul className="divide-y">
          {list.map((share) => {
            const state = now ? stateOf(share, now) : share.active ? 'ACTIVE' : 'REVOKED';
            return (
              <li key={share.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                    <span dir="auto">{share.recipient || t('people.documents.share.noRecipient')}</span>
                    <Badge tone={STATE_TONE[state]}>{t(`people.documents.share.states.${state}`)}</Badge>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('people.documents.share.line', { downloads: formatNumber(share.downloadCount), max: formatNumber(share.maxDownloads), expires: formatDateTime(share.expiresAt) })}
                  </p>
                </div>
                {state === 'ACTIVE' ? (
                  <Button variant="destructive-outline" size="sm" onClick={() => setRevoking(share)}>
                    {t('people.documents.share.revoke')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {creating ? <CreateShareDialog document={doc} open onOpenChange={setCreating} /> : null}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(next) => !next && setRevoking(null)}
        title={t('people.documents.share.revokeTitle')}
        description={t('people.documents.share.revokeText')}
        confirmLabel={t('people.documents.share.revoke')}
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
      />
    </Section>
  );
}

function CreateShareDialog({ document: doc, open, onOpenChange }: { document: DocumentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [created, setCreated] = React.useState<DocumentShare | null>(null);
  const form = useZodForm(documentShareSchema, { defaultValues: { expiresInHours: 24, maxDownloads: 3, recipient: '' }, emptyAs: 'null' });

  const create = async (values: { expiresInHours: number; maxDownloads: number; recipient?: string | null }) => {
    const share = await api.client.post<DocumentShare>(`/documents/${doc.id}/shares`, values);
    setCreated(share);
    toasts.success(t('people.documents.share.created'));
    await queryClient.invalidateQueries({ queryKey: peopleKeys.documents.detail(doc.id) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('people.documents.share.readyTitle')}</DialogTitle>
              <DialogDescription>{t('people.documents.share.line', { downloads: formatNumber(created.downloadCount), max: formatNumber(created.maxDownloads), expires: formatDateTime(created.expiresAt) })}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <Alert tone="warning" title={t('people.documents.share.onceTitle')}>
                {t('people.documents.share.onceText')}
              </Alert>
              <div className="flex items-center gap-2">
                <Input readOnly value={created.url ?? ''} dir="ltr" aria-label={t('people.documents.share.link')} onFocus={(e) => e.currentTarget.select()} className="tabular text-sm" />
                <CopyButton value={created.url ?? ''} label={t('people.documents.share.copy')} variant="outline" size="icon" />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('common.done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <Form form={form} onSubmit={create} className="flex min-h-0 flex-1 flex-col space-y-0">
            <DialogHeader>
              <DialogTitle>{t('people.documents.share.createTitle')}</DialogTitle>
              <DialogDescription dir="auto">{doc.title}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-5">
              <Alert tone="warning" title={t('people.documents.share.warningTitle')}>
                {t('people.documents.share.warningText')}
              </Alert>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="expiresInHours" label={t('people.documents.share.expires')}>
                  {(field) => <Select {...field} value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))} options={HOURS.map((h) => ({ value: String(h), label: h < 24 ? tn('people.documents.share.hours', h) : tn('people.documents.share.days', h / 24) }))} />}
                </FormField>
                <FormField name="maxDownloads" label={t('people.documents.share.maxDownloads')} hint={t('people.documents.share.maxDownloadsHint')}>
                  {(field) => <Input {...field} type="number" inputMode="numeric" min={1} max={20} dir="ltr" className="tabular" />}
                </FormField>
              </div>
              <FormField name="recipient" label={t('people.documents.share.recipient')} optional hint={t('people.documents.share.recipientHint')}>
                {(field) => <Input {...field} autoComplete="off" maxLength={200} dir="auto" />}
              </FormField>
              <FormError />
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
                {t('people.documents.share.create')}
              </Button>
            </DialogFooter>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
