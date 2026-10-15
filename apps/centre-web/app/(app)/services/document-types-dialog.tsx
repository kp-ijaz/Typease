'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { OCR_PROFILES, catalogueDocumentTypeSchema, updateCatalogueDocumentTypeSchema } from '@typease/validation';
import {
  Badge, Button, Checkbox, ChoiceLabel, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input,
  Select, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { ListSkeleton, Loadable, useRun } from '@/components/ops/common';
import type { DocumentTypeRow } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

/** Document types: the TypEase defaults (read-only) and the centre's own. */
export function DocumentTypesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const { run } = useRun();
  const [editing, setEditing] = React.useState<string | 'new' | null>(null);
  const [removing, setRemoving] = React.useState<DocumentTypeRow | null>(null);
  const types = useQuery({
    queryKey: opsKeys.documentTypes.manage,
    queryFn: () => api.client.get<DocumentTypeRow[]>('/document-types', { query: { includeInactive: true } }),
    enabled: open,
  });

  React.useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('ops.services.documentTypes.title')}</DialogTitle>
          <DialogDescription>{t('ops.services.documentTypes.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Loadable query={types} skeleton={<ListSkeleton rows={6} />}>
            {(list) => (
              <ul className="divide-y rounded-md border">
                {[...list]
                  .sort((a, b) => Number(a.source === 'PLATFORM') - Number(b.source === 'PLATFORM') || a.name.localeCompare(b.name))
                  .map((type) =>
                    editing === type.id ? (
                      <li key={type.id} className="bg-muted/30 p-3">
                        <DocumentTypeForm type={type} onDone={() => setEditing(null)} />
                      </li>
                    ) : (
                      <li key={type.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                        <div className="min-w-0 flex-1 basis-52">
                          <p className="truncate font-medium">{pick(type.name, type.nameAr)}</p>
                          <p className="ltr-value text-sm text-muted-foreground">{type.key}</p>
                        </div>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {type.hasExpiry ? <Badge tone="info">{t(type.reminderEnabled ? 'ops.services.documentTypes.expiryReminders' : 'ops.services.documentTypes.expiry')}</Badge> : null}
                          {type.isActive ? null : <Badge tone="warning">{t('ops.services.flags.inactive')}</Badge>}
                          <Badge tone={type.source === 'PLATFORM' ? 'neutral' : 'brand'}>{t(type.source === 'PLATFORM' ? 'ops.services.documentTypes.platform' : type.overridesPlatformDefault ? 'ops.services.documentTypes.override' : 'ops.services.documentTypes.own')}</Badge>
                        </span>
                        {type.source === 'TENANT' ? (
                          <span className="flex">
                            <Button variant="ghost" size="icon-sm" onClick={() => setEditing(type.id)} aria-label={`${t('common.edit')} ${type.name}`} title={t('common.edit')}>
                              <Pencil aria-hidden="true" />
                            </Button>
                            <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(type)} aria-label={`${t('common.delete')} ${type.name}`} title={t('common.delete')}>
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </span>
                        ) : (
                          <span className="w-16" aria-hidden="true" />
                        )}
                      </li>
                    ),
                  )}
              </ul>
            )}
          </Loadable>
          {editing === 'new' ? (
            <div className="rounded-md border bg-muted/30 p-3">
              <DocumentTypeForm onDone={() => setEditing(null)} />
            </div>
          ) : (
            <Button variant="outline" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              {t('ops.services.documentTypes.add')}
            </Button>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('ops.services.documentTypes.deleteTitle', { name: removing?.name ?? '' })}
        description={t(removing?.overridesPlatformDefault ? 'ops.services.documentTypes.deleteOverrideText' : 'ops.services.documentTypes.deleteText')}
        confirmLabel={t('ops.services.documentTypes.deleteConfirm')}
        onConfirm={async () => {
          await run('delete', () => api.client.delete(`/document-types/${removing!.id}`), { success: t('ops.services.documentTypes.deleted'), invalidate: [opsKeys.documentTypes.all], rethrow: true });
        }}
      />
    </Dialog>
  );
}

function DocumentTypeForm({ type, onDone }: { type?: DocumentTypeRow; onDone: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const id = React.useId();
  // One form for both cases: the key exists only when a type is created.
  const form = useZodForm(type ? updateCatalogueDocumentTypeSchema.extend({ key: catalogueDocumentTypeSchema.shape.key.optional() }) : catalogueDocumentTypeSchema, {
    defaultValues: {
      key: type?.key ?? '',
      name: type?.name ?? '',
      nameAr: type?.nameAr ?? '',
      hasExpiry: type?.hasExpiry ?? false,
      reminderEnabled: type?.reminderEnabled ?? false,
      ocrProfile: type?.ocrProfile ?? 'NONE',
      isActive: type?.isActive ?? true,
    },
    emptyAs: type ? 'null' : 'undefined',
  });
  const hasExpiry = form.watch('hasExpiry');

  return (
    <Form
      form={form}
      className="space-y-3"
      onSubmit={async (values) => {
        const { key, ...rest } = values as { key?: string } & Record<string, unknown>;
        const body = { ...rest, reminderEnabled: rest.hasExpiry ? rest.reminderEnabled : false };
        if (type) await api.client.patch(`/document-types/${type.id}`, body);
        else await api.client.post('/document-types', { key, ...body });
        toasts.success(t(type ? 'ops.services.documentTypes.saved' : 'ops.services.documentTypes.added'), String(values.name ?? ''));
        await queryClient.invalidateQueries({ queryKey: opsKeys.documentTypes.all });
        onDone();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField name="name" label={t('ops.services.documentTypes.name')} required>
          {(field) => <Input {...field} dir="ltr" lang="en" autoFocus autoComplete="off" />}
        </FormField>
        <FormField name="nameAr" label={t('ops.services.documentTypes.nameAr')} optional>
          {(field) => <Input {...field} dir="rtl" lang="ar" autoComplete="off" />}
        </FormField>
        {type ? null : (
          <FormField name="key" label={t('ops.services.documentTypes.key')} required hint={t('ops.services.documentTypes.keyHint')}>
            {(field) => <Input {...field} dir="ltr" className="font-mono text-sm" spellCheck={false} autoComplete="off" placeholder="salary_certificate" />}
          </FormField>
        )}
        <FormField name="ocrProfile" label={t('ops.services.documentTypes.ocr')} hint={t('ops.services.documentTypes.ocrHint')}>
          {(field) => <Select {...field} onValueChange={field.onChange} options={OCR_PROFILES.map((p) => ({ value: p, label: t(`ops.services.documentTypes.ocrProfiles.${p}`) }))} />}
        </FormField>
      </div>
      <div className="grid gap-2.5">
        <FormField name="hasExpiry" label={t('ops.services.documentTypes.hasExpiry')} hideLabel>
          {(field) => <ChoiceLabel htmlFor={field.id} control={<Checkbox id={field.id} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />} label={t('ops.services.documentTypes.hasExpiry')} />}
        </FormField>
        {hasExpiry ? (
          <FormField name="reminderEnabled" label={t('ops.services.documentTypes.reminders')} hideLabel>
            {(field) => (
              <ChoiceLabel htmlFor={field.id} control={<Checkbox id={field.id} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />} label={t('ops.services.documentTypes.reminders')} description={t('ops.services.documentTypes.remindersHint')} />
            )}
          </FormField>
        ) : null}
        {type ? (
          <FormField name="isActive" label={t('ops.services.flags.active')} hideLabel>
            {(field) => <ChoiceLabel htmlFor={`${id}-active`} control={<Checkbox id={`${id}-active`} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />} label={t('ops.services.documentTypes.activeLabel')} />}
          </FormField>
        ) : null}
      </div>
      <FormError />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t(type ? 'common.save' : 'ops.services.documentTypes.add')}
        </Button>
      </div>
    </Form>
  );
}
