'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z, updateServiceSchema } from '@typease/validation';
import { Button, Checkbox, Form, FormActions, FormError, FormField, FormSection, Input, Select, Switch, Textarea, ChoiceLabel, useApi, useI18n, useToast, useZodForm } from '@typease/ui';
import { useBranches } from '@/components/branch';
import { Panel } from '@/components/ops/common';
import type { ServiceCategory, ServiceDetail } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import type { ServiceTabProps } from './service-editor';

const schema = updateServiceSchema
  .pick({
    name: true, nameAr: true, description: true, descriptionAr: true, categoryId: true, code: true, eligibilityGuidance: true, estimatedProcessingHours: true, sortOrder: true,
    isActive: true, isPublic: true, onlineAvailable: true, allBranches: true, branchIds: true,
  })
  .required({ name: true, categoryId: true, code: true })
  .superRefine((v, ctx) => {
    if (v.allBranches === false && (v.branchIds?.length ?? 0) === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branchIds'], message: 'Choose at least one branch, or offer the service in all branches' });
  });

const toValues = (s: ServiceDetail) => ({
  name: s.name, nameAr: s.nameAr ?? '', description: s.description ?? '', descriptionAr: s.descriptionAr ?? '', categoryId: s.categoryId, code: s.code,
  eligibilityGuidance: s.eligibilityGuidance ?? '', estimatedProcessingHours: s.estimatedProcessingHours ?? ('' as unknown as number), sortOrder: s.sortOrder,
  isActive: s.isActive, isPublic: s.isPublic, onlineAvailable: s.onlineAvailable, allBranches: s.allBranches, branchIds: s.branchIds,
});

/** Names, description, category, code, guidance, processing time and where / how the service is offered. */
export function BasicsTab({ service, editable }: ServiceTabProps) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const branches = useBranches();
  const categories = useQuery({ queryKey: opsKeys.categories.list(true), queryFn: () => api.client.get<ServiceCategory[]>('/service-categories', { query: { includeInactive: true } }) });
  const form = useZodForm(schema, { defaultValues: toValues(service), emptyAs: 'null', disabled: !editable });

  // Follow the saved record (after a save, or when someone else changed it).
  React.useEffect(() => {
    form.reset(toValues(service));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.version]);

  const allBranches = form.watch('allBranches');
  const number = (onChange: (v: unknown) => void) => (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === '' ? '' : Number(e.target.value));

  return (
    <Panel title={t('ops.services.basics.title')} description={t('ops.services.basics.description')}>
      <Form
        form={form}
        className="space-y-7"
        onSubmit={async (values) => {
          await api.client.patch(`/services/${service.id}`, { ...values, branchIds: values.allBranches ? [] : values.branchIds, version: service.version });
          toasts.success(t('ops.services.saved'), values.name);
          await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.services.all }), queryClient.invalidateQueries({ queryKey: opsKeys.categories.all })]);
        }}
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <FormField name="name" label={t('ops.services.fields.name')} required>
            {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" />}
          </FormField>
          <FormField name="nameAr" label={t('ops.services.fields.nameAr')} optional>
            {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
          </FormField>
          <FormField name="description" label={t('ops.services.fields.description')} optional hint={t('ops.services.fields.descriptionHint')}>
            {(field) => <Textarea {...field} rows={4} dir="ltr" lang="en" />}
          </FormField>
          <FormField name="descriptionAr" label={t('ops.services.fields.descriptionAr')} optional>
            {(field) => <Textarea {...field} rows={4} dir="rtl" lang="ar" />}
          </FormField>
          <FormField name="categoryId" label={t('ops.services.fields.category')} required>
            {(field) => (
              <Select
                {...field}
                onValueChange={field.onChange}
                options={(categories.data ?? []).filter((c) => c.isActive || c.id === service.categoryId).map((c) => ({ value: c.id, label: pick(c.name, c.nameAr) }))}
              />
            )}
          </FormField>
          <FormField name="code" label={t('ops.services.fields.code')} required hint={t('ops.services.fields.codeHint')}>
            {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular uppercase" spellCheck={false} />}
          </FormField>
          <FormField name="eligibilityGuidance" label={t('ops.services.fields.eligibility')} optional hint={t('ops.services.fields.eligibilityHint')} className="sm:col-span-2">
            {(field) => <Textarea {...field} rows={3} dir="auto" />}
          </FormField>
          <FormField name="estimatedProcessingHours" label={t('ops.services.fields.processingHours')} optional hint={t('ops.services.fields.processingHoursHint')}>
            {(field) => <Input {...field} type="number" min={1} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
          </FormField>
          <FormField name="sortOrder" label={t('ops.services.fields.sortOrder')} hint={t('ops.services.fields.sortOrderHint')}>
            {(field) => <Input {...field} type="number" min={0} inputMode="numeric" dir="ltr" className="tabular" onChange={number(field.onChange)} />}
          </FormField>
        </div>

        <FormSection title={t('ops.services.basics.availability')}>
          <div className="grid gap-4">
            {(
              [
                ['isActive', 'ops.services.basics.active', 'ops.services.basics.activeHint'],
                ['isPublic', 'ops.services.basics.public', 'ops.services.basics.publicHint'],
                ['onlineAvailable', 'ops.services.basics.online', 'ops.services.basics.onlineHint'],
              ] as const
            ).map(([name, label, hint]) => (
              <FormField key={name} name={name} label={t(label)} hideLabel>
                {(field) => <ChoiceLabel htmlFor={field.id} control={<Switch id={field.id} checked={field.value === true} onCheckedChange={field.onChange} disabled={field.disabled} />} label={t(label)} description={t(hint)} />}
              </FormField>
            ))}
          </div>
        </FormSection>

        {(branches.data?.length ?? 0) > 1 ? (
          <FormSection title={t('ops.services.basics.branches')}>
            <FormField name="allBranches" label={t('ops.services.basics.allBranches')} hideLabel>
              {(field) => <ChoiceLabel htmlFor={field.id} control={<Switch id={field.id} checked={field.value === true} onCheckedChange={field.onChange} disabled={field.disabled} />} label={t('ops.services.basics.allBranches')} />}
            </FormField>
            {allBranches === false ? (
              <FormField name="branchIds" label={t('ops.services.basics.chooseBranches')}>
                {(field) => {
                  const selected: string[] = Array.isArray(field.value) ? field.value : [];
                  return (
                    <div role="group" aria-labelledby={`${field.id}-group`} className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {(branches.data ?? []).map((branch) => (
                        <ChoiceLabel
                          key={branch.id}
                          htmlFor={`${field.id}-${branch.id}`}
                          control={<Checkbox id={`${field.id}-${branch.id}`} checked={selected.includes(branch.id)} disabled={field.disabled} onCheckedChange={(on) => field.onChange(on === true ? [...selected, branch.id] : selected.filter((b) => b !== branch.id))} />}
                          label={pick(branch.name, branch.nameAr)}
                        />
                      ))}
                    </div>
                  );
                }}
              </FormField>
            ) : null}
          </FormSection>
        ) : null}

        <FormError />
        {editable ? (
          <FormActions>
            <Button variant="outline" onClick={() => form.reset(toValues(service))} disabled={!form.formState.isDirty}>
              {t('common.reset')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </FormActions>
        ) : null}
      </Form>
    </Panel>
  );
}
