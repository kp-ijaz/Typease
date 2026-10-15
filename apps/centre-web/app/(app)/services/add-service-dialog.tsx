'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { serviceSchema } from '@typease/validation';
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Combobox, Form, FormError, FormField, FormSection, Input, MoneyInput, useApi, useI18n,
  useToast, useZodForm,
} from '@typease/ui';
import type { Service, ServiceCategory } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const EMPTY = { categoryId: '', code: '', name: '', nameAr: '', price: { serviceFee: '', governmentFeeEstimate: '0.00', thirdPartyFeeEstimate: '0.00' } };

/**
 * Creating a service asks only for what the API requires (name, category, code, service fee).
 * Everything else - documents, form, workflow, compliance - is set in the editor that opens next.
 */
export function AddServiceDialog({ open, onOpenChange, categories, categoryId }: { open: boolean; onOpenChange: (open: boolean) => void; categories: ServiceCategory[]; categoryId?: string }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useZodForm(serviceSchema, { defaultValues: EMPTY });

  React.useEffect(() => {
    if (open) form.reset({ ...EMPTY, categoryId: categoryId ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, categoryId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const service = await api.client.post<Service>('/services', values);
            toasts.success(t('ops.services.added'), t('ops.services.addedDescription', { name: service.name }));
            await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.services.all }), queryClient.invalidateQueries({ queryKey: opsKeys.categories.all })]);
            onOpenChange(false);
            router.push(`/services/${service.id}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.services.addTitle')}</DialogTitle>
            <DialogDescription>{t('ops.services.addDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField name="name" label={t('ops.services.fields.name')} required>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" autoFocus />}
              </FormField>
              <FormField name="nameAr" label={t('ops.services.fields.nameAr')} optional>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
              <FormField name="categoryId" label={t('ops.services.fields.category')} required>
                {(field) => <Combobox {...field} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={categories.map((c) => ({ value: c.id, label: pick(c.name, c.nameAr), keywords: [c.name, c.nameAr ?? ''] }))} />}
              </FormField>
              <FormField name="code" label={t('ops.services.fields.code')} required hint={t('ops.services.fields.codeHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular uppercase" spellCheck={false} placeholder="TEN-001" />}
              </FormField>
            </div>
            <FormSection title={t('ops.services.pricing.priceTitle')} description={t('ops.services.pricing.estimateNote')}>
              <div className="grid grid-cols-1 items-end gap-5 sm:grid-cols-3">
                <FormField name="price.serviceFee" label={t('ops.services.pricing.serviceFee')} required>
                  {(field) => <MoneyInput {...field} />}
                </FormField>
                <FormField name="price.governmentFeeEstimate" label={t('ops.services.pricing.governmentFee')}>
                  {(field) => <MoneyInput {...field} />}
                </FormField>
                <FormField name="price.thirdPartyFeeEstimate" label={t('ops.services.pricing.thirdPartyFee')}>
                  {(field) => <MoneyInput {...field} />}
                </FormField>
              </div>
            </FormSection>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.services.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
