'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileCheck2, Pencil, Plus, Trash2 } from 'lucide-react';
import { serviceRequirementSchema } from '@typease/validation';
import {
  Badge, Button, Checkbox, ChoiceLabel, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField,
  Input, Textarea, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { DocumentTypePicker, useDocumentTypes } from '@/components/pickers';
import { MoveButtons, Panel, moveItem, useRun } from '@/components/ops/common';
import type { Requirement } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import type { ServiceTabProps } from './service-editor';

/** The document checklist of a service: which documents a customer has to provide, in which order. */
export function RequirementsTab({ service, editable }: ServiceTabProps) {
  const { t, tn, pick } = useI18n();
  const api = useApi();
  const { run, busy } = useRun();
  const types = useDocumentTypes();
  const [editing, setEditing] = React.useState<Requirement | 'new' | null>(null);
  const [removing, setRemoving] = React.useState<Requirement | null>(null);
  const list = service.requirements;
  const typeName = (key: string) => {
    const type = (types.data ?? []).find((d) => d.key === key);
    return type ? pick(type.name, type.nameAr) : key;
  };
  const invalidate = [opsKeys.services.detail(service.id)];

  const addButton = editable ? (
    <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
      <Plus aria-hidden="true" />
      {t('ops.services.documents.add')}
    </Button>
  ) : undefined;

  return (
    <Panel title={t('ops.services.documents.title')} description={t('ops.services.documents.description')} action={list.length ? addButton : undefined}>
      {list.length === 0 ? (
        <EmptyState icon={<FileCheck2 />} title={t('ops.services.documents.emptyTitle')} description={t('ops.services.documents.emptyText')} action={addButton} />
      ) : (
        <ol className="divide-y rounded-md border">
          {list.map((item, index) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
              {editable ? (
                <MoveButtons
                  index={index}
                  count={list.length}
                  name={item.label}
                  disabled={busy !== null}
                  onMove={(from, to) => void run('order', () => api.client.put(`/services/${service.id}/requirements/order`, { ids: moveItem(list, from, to).map((r) => r.id) }), { invalidate })}
                />
              ) : null}
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-medium">
                  {item.label}
                  {item.labelAr ? (
                    <span lang="ar" dir="rtl" className="ms-2 font-normal text-muted-foreground">
                      {item.labelAr}
                    </span>
                  ) : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {typeName(item.documentTypeKey)}
                  {item.description ? ` · ${item.description}` : ''}
                </p>
              </div>
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={item.isMandatory ? 'warning' : 'neutral'}>{t(item.isMandatory ? 'ops.services.documents.mandatory' : 'ops.services.documents.optionalItem')}</Badge>
                {item.allowReuse ? <Badge tone="info">{item.maxAgeDays ? tn('ops.services.documents.reuseMaxAge', item.maxAgeDays) : t('ops.services.documents.reuse')}</Badge> : <Badge tone="neutral">{t('ops.services.documents.newUpload')}</Badge>}
              </span>
              {editable ? (
                <span className="flex">
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(item)} aria-label={`${t('common.edit')} ${item.label}`} title={t('common.edit')}>
                    <Pencil aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(item)} aria-label={`${t('common.remove')} ${item.label}`} title={t('common.remove')}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <RequirementDialog serviceId={service.id} item={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('ops.services.documents.removeTitle', { name: removing?.label ?? '' })}
        description={t('ops.services.documents.removeText')}
        confirmLabel={t('common.remove')}
        onConfirm={async () => {
          await run('remove', () => api.client.delete(`/services/${service.id}/requirements/${removing!.id}`), { success: t('ops.services.documents.removed'), invalidate, rethrow: true });
        }}
      />
    </Panel>
  );
}

function RequirementDialog({ serviceId, item, onClose }: { serviceId: string; item: Requirement | 'new' | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const existing = item && item !== 'new' ? item : null;
  const form = useZodForm(serviceRequirementSchema, { emptyAs: 'null' });
  const reuse = form.watch('allowReuse');

  React.useEffect(() => {
    if (item) {
      form.reset({
        documentTypeKey: existing?.documentTypeKey ?? '',
        label: existing?.label ?? '',
        labelAr: existing?.labelAr ?? '',
        description: existing?.description ?? '',
        isMandatory: existing?.isMandatory ?? true,
        allowReuse: existing?.allowReuse ?? true,
        maxAgeDays: existing?.maxAgeDays ?? ('' as unknown as number),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const body = { ...values, maxAgeDays: values.allowReuse ? values.maxAgeDays : null };
            if (existing) await api.client.patch(`/services/${serviceId}/requirements/${existing.id}`, body);
            else await api.client.post(`/services/${serviceId}/requirements`, body);
            toasts.success(t(existing ? 'ops.services.documents.saved' : 'ops.services.documents.added'), values.label);
            await queryClient.invalidateQueries({ queryKey: opsKeys.services.detail(serviceId) });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(existing ? 'ops.services.documents.editTitle' : 'ops.services.documents.addTitle')}</DialogTitle>
            <DialogDescription>{t('ops.services.documents.dialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="documentTypeKey" label={t('ops.services.documents.type')} required>
              {(field) => (
                <DocumentTypePicker
                  {...field}
                  value={field.value}
                  onChange={(key, type) => {
                    field.onChange(key);
                    // A new line starts with the name of the document type as its label.
                    if (type && !form.getValues('label')) {
                      form.setValue('label', type.name, { shouldDirty: true });
                      if (type.nameAr && !form.getValues('labelAr')) form.setValue('labelAr', type.nameAr, { shouldDirty: true });
                    }
                  }}
                />
              )}
            </FormField>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField name="label" label={t('ops.services.documents.label')} required hint={t('ops.services.documents.labelHint')}>
                {(field) => <Input {...field} dir="ltr" lang="en" autoComplete="off" />}
              </FormField>
              <FormField name="labelAr" label={t('ops.services.documents.labelAr')} optional>
                {(field) => <Input {...field} dir="rtl" lang="ar" autoComplete="off" />}
              </FormField>
            </div>
            <FormField name="description" label={t('ops.services.documents.note')} optional hint={t('ops.services.documents.noteHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <div className="grid gap-3">
              <FormField name="isMandatory" label={t('ops.services.documents.mandatoryLabel')} hideLabel>
                {(field) => (
                  <ChoiceLabel htmlFor={field.id} control={<Checkbox id={field.id} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />} label={t('ops.services.documents.mandatoryLabel')} description={t('ops.services.documents.mandatoryHint')} />
                )}
              </FormField>
              <FormField name="allowReuse" label={t('ops.services.documents.reuseLabel')} hideLabel>
                {(field) => (
                  <ChoiceLabel htmlFor={field.id} control={<Checkbox id={field.id} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />} label={t('ops.services.documents.reuseLabel')} description={t('ops.services.documents.reuseHint')} />
                )}
              </FormField>
            </div>
            {reuse ? (
              <FormField name="maxAgeDays" label={t('ops.services.documents.maxAge')} optional hint={t('ops.services.documents.maxAgeHint')} className="sm:max-w-xs">
                {(field) => <Input {...field} type="number" min={1} inputMode="numeric" dir="ltr" className="tabular" onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))} />}
              </FormField>
            ) : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t(existing ? 'common.save' : 'ops.services.documents.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
