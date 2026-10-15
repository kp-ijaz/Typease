'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSignature, Pencil, Plus, Trash2 } from 'lucide-react';
import { CORPORATE_AGREEMENT_STATUSES, corporateAgreementSchema } from '@typease/validation';
import {
  Badge, Button, Card, ConfirmDialog, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField, Input, Select, Skeleton,
  Textarea, useApi, useI18n, useSession, useToast, useZodForm, type Tone,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError } from '../shared';
import type { AgreementStatus, CorporateAccountDetail, CorporateAgreement } from '../types';

const STATUS_TONE: Record<AgreementStatus, Tone> = { DRAFT: 'neutral', ACTIVE: 'success', EXPIRED: 'warning', TERMINATED: 'danger' };

/** Service agreements: free-form records of what was agreed with the company (title, terms, period, status). */
export function AgreementsTab({ account }: { account: CorporateAccountDetail }) {
  const { t, formatDate, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const canManage = session.hasPermission('corporate.manage') && account.status !== 'ARCHIVED';
  const [editing, setEditing] = React.useState<CorporateAgreement | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<CorporateAgreement | null>(null);

  const agreements = useQuery({ queryKey: peopleKeys.corporate.agreements(account.id), queryFn: () => api.client.get<CorporateAgreement[]>(`/corporate-accounts/${account.id}/agreements`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.agreements(account.id) });
  const remove = async (agreement: CorporateAgreement) => {
    try {
      await api.client.delete(`/corporate-accounts/${account.id}/agreements/${agreement.id}`);
      toasts.success(t('people.corporate.agreements.deleted'), agreement.title);
      await refresh();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const add = canManage ? (
    <Button variant="outline" onClick={() => setEditing('new')}>
      <Plus aria-hidden="true" />
      {t('people.corporate.agreements.add')}
    </Button>
  ) : null;
  const list = agreements.data ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('people.corporate.agreements.text')}</p>
        {add}
      </div>
      {agreements.isPending ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : agreements.isError ? (
        <LoadError error={agreements.error} onRetry={() => void agreements.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={<FileSignature />} title={t('people.corporate.agreements.empty')} description={t('people.corporate.agreements.emptyText')} action={add} />
        </Card>
      ) : (
        <ul className="space-y-4">
          {list.map((agreement) => {
            const ended = agreement.status === 'ACTIVE' && !!agreement.endsOn && agreement.endsOn < today();
            return (
              <li key={agreement.id}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <h3 className="flex flex-wrap items-center gap-2 text-md font-semibold text-foreground">
                        <span dir="auto">{agreement.title}</span>
                        <Badge tone={STATUS_TONE[agreement.status] ?? 'neutral'}>{t(`people.corporate.agreements.status.${agreement.status}`)}</Badge>
                        {ended ? <Badge tone="warning">{t('people.corporate.agreements.pastEnd')}</Badge> : null}
                      </h3>
                      <p className="tabular mt-0.5 text-sm text-muted-foreground">
                        {agreement.endsOn ? t('people.corporate.agreements.period', { from: formatDate(agreement.startsOn), to: formatDate(agreement.endsOn) }) : t('people.corporate.agreements.periodOpen', { from: formatDate(agreement.startsOn) })}
                      </p>
                    </div>
                    {canManage ? (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(agreement)}>
                          <Pencil aria-hidden="true" />
                          {t('common.edit')}
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`${t('common.delete')}: ${agreement.title}`} title={t('common.delete')} onClick={() => setDeleting(agreement)}>
                          <Trash2 className="text-destructive-text" aria-hidden="true" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {agreement.terms ? (
                    <p className="mt-3 whitespace-pre-wrap break-words text-base text-foreground/90" dir="auto">
                      {agreement.terms}
                    </p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {editing ? <AgreementDialog accountId={account.id} agreement={editing === 'new' ? null : editing} open onOpenChange={(next) => !next && setEditing(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t('people.corporate.agreements.deleteTitle')}
        description={t('people.corporate.agreements.deleteText', { title: deleting?.title ?? '' })}
        confirmLabel={t('common.delete')}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}

function AgreementDialog({ accountId, agreement, open, onOpenChange, onSaved }: { accountId: string; agreement: CorporateAgreement | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown> }) {
  const { t, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const form = useZodForm(corporateAgreementSchema, {
    defaultValues: { title: agreement?.title ?? '', terms: agreement?.terms ?? '', startsOn: agreement?.startsOn ?? today(), endsOn: agreement?.endsOn ?? '', status: agreement?.status ?? 'ACTIVE' },
    emptyAs: 'null',
  });
  const startsOn = form.watch('startsOn');

  const save = async (values: Record<string, unknown>) => {
    if (agreement) {
      await api.client.patch(`/corporate-accounts/${accountId}/agreements/${agreement.id}`, values);
      toasts.success(t('people.corporate.agreements.saved'), String(values.title));
    } else {
      await api.client.post(`/corporate-accounts/${accountId}/agreements`, values);
      toasts.success(t('people.corporate.agreements.added'), String(values.title));
    }
    await onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={(values) => save(values as Record<string, unknown>)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{agreement ? t('people.corporate.agreements.editTitle') : t('people.corporate.agreements.addTitle')}</DialogTitle>
            <DialogDescription>{t('people.corporate.agreements.dialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="title" label={t('people.corporate.agreements.title')} required>
              {(field) => <Input {...field} autoComplete="off" maxLength={160} dir="auto" autoFocus={!agreement} />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-3">
              <FormField name="startsOn" label={t('people.corporate.agreements.startsOn')} required>
                {(field) => <DatePicker {...field} />}
              </FormField>
              <FormField name="endsOn" label={t('people.corporate.agreements.endsOn')} optional>
                {(field) => <DatePicker {...field} min={startsOn || undefined} />}
              </FormField>
              <FormField name="status" label={t('requests.columns.status')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={CORPORATE_AGREEMENT_STATUSES.map((s) => ({ value: s, label: t(`people.corporate.agreements.status.${s}`) }))} />}
              </FormField>
            </div>
            <FormField name="terms" label={t('people.corporate.agreements.terms')} optional hint={t('people.corporate.agreements.termsHint')}>
              {(field) => <Textarea {...field} rows={6} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {agreement ? t('common.saveChanges') : t('people.corporate.agreements.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
