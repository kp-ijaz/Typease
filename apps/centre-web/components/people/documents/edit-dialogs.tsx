'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { documentLegalHoldSchema, documentUpdateSchema } from '@typease/validation';
import { isApiError } from '@typease/api-client';
import { Alert, Button, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Textarea, normaliseEmpty, useApi, useI18n, useToast, useZodForm } from '@typease/ui';
import { DocumentTypePicker } from '@/components/pickers';
import { peopleKeys } from '@/lib/keys/people';
import { BooleanField } from '../form-bits';
import type { DocumentDetail } from '../types';

/** Title, type, category, dates and whether the customer may see the document (PATCH /documents/:id). */
export function EditDocumentDialog({ document: doc, open, onOpenChange }: { document: DocumentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const defaults = { title: doc.title, category: doc.category ?? '', documentTypeKey: doc.documentTypeKey, expiryDate: doc.expiryDate ?? '', issuedDate: doc.issuedDate ?? '', customerVisible: doc.customerVisible ?? true };
  const form = useZodForm(documentUpdateSchema, { defaultValues: defaults, emptyAs: 'null' });
  const expiryChanged = (form.watch('expiryDate') ?? '') !== (doc.expiryDate ?? '');

  const save = async (values: Record<string, unknown>) => {
    // Only what changed is sent: an unchanged expiry date must not reset its "confirmed" mark.
    const before = normaliseEmpty(defaults, 'null') as Record<string, unknown>;
    const body = Object.fromEntries(Object.entries(values).filter(([key, value]) => (value ?? null) !== (before[key] ?? null)));
    if (Object.keys(body).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await api.client.patch(`/documents/${doc.id}`, body);
    } catch (error) {
      // Categories starting with "restricted:" belong to files the system generates (422): said at the field.
      if (isApiError(error) && error.code === 'CATEGORY_RESERVED') {
        form.setError('category', { type: 'server', message: error.message });
        form.setFocus('category');
        return;
      }
      throw error;
    }
    toasts.success(t('people.documents.edit.saved'), doc.title);
    await queryClient.invalidateQueries({ queryKey: peopleKeys.documents.all });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={(values) => save(values as Record<string, unknown>)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('people.documents.edit.title')}</DialogTitle>
            <DialogDescription>{t('people.documents.edit.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="title" label={t('people.documents.fields.title')} required>
              {(field) => <Input {...field} autoComplete="off" maxLength={200} dir="auto" />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="documentTypeKey" label={t('people.documents.fields.type')} required>
                {(field) => <DocumentTypePicker {...field} onChange={(key) => field.onChange(key)} />}
              </FormField>
              <FormField name="category" label={t('people.documents.fields.category')} optional>
                {(field) => <Input {...field} autoComplete="off" maxLength={80} dir="auto" />}
              </FormField>
              <FormField name="issuedDate" label={t('people.documents.fields.issuedDate')} optional>
                {(field) => <DatePicker {...field} />}
              </FormField>
              <FormField name="expiryDate" label={t('people.documents.fields.expiryDate')} optional>
                {(field) => <DatePicker {...field} />}
              </FormField>
            </div>
            {expiryChanged && doc.expiryVerified ? <Alert tone="warning">{t('people.documents.edit.expiryResets')}</Alert> : null}
            <BooleanField name="customerVisible" variant="switch" label={t('people.documents.fields.customerVisible')} description={t('people.documents.upload.customerVisibleHint')} />
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Legal hold on / off, with the reason the API requires. A held document cannot be deleted or purged. */
export function LegalHoldDialog({ document: doc, open, onOpenChange }: { document: DocumentDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const turningOn = !doc.legalHold;
  const form = useZodForm(documentLegalHoldSchema, { defaultValues: { legalHold: turningOn, reason: '' } });

  const save = async (values: { legalHold: boolean; reason: string }) => {
    await api.client.put(`/documents/${doc.id}/legal-hold`, values);
    toasts.success(turningOn ? t('people.documents.legalHold.on') : t('people.documents.legalHold.off'), doc.title);
    await queryClient.invalidateQueries({ queryKey: peopleKeys.documents.all });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{turningOn ? t('people.documents.legalHold.setTitle') : t('people.documents.legalHold.releaseTitle')}</DialogTitle>
            <DialogDescription>{turningOn ? t('people.documents.legalHold.setText') : t('people.documents.legalHold.releaseText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="reason" label={t('people.documents.legalHold.reason')} required hint={t('people.documents.legalHold.reasonHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {turningOn ? t('people.documents.legalHold.set') : t('people.documents.legalHold.release')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
