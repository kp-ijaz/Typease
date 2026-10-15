'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { documentVerifySchema } from '@typease/validation';
import { Alert, Button, ChoiceLabel, DatePicker, Form, FormError, FormField, RadioGroup, RadioGroupItem, StatusBadge, Textarea, Timeline, useApi, useI18n, useSession, useToast, useZodForm } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { Section, useStaffNames } from '../shared';
import type { DocumentDetail } from '../types';

const DECISIONS = ['APPROVED', 'CORRECTION_REQUESTED', 'REJECTED'] as const;

/**
 * Verification of a document by a person: approve, ask for a correction or reject, with a reason the
 * customer can read, and the dates the reviewer confirmed against the document. Every decision is kept.
 */
export function VerificationCard({ document: doc, hasExpiry }: { document: DocumentDetail; hasExpiry: boolean }) {
  const { t, formatDateTime, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const staffName = useStaffNames();
  const ids = React.useId();
  const canVerify = session.hasPermission('document.verify') && doc.status === 'AVAILABLE';
  // A document that already has a decision shows it; the form opens on request.
  const [changing, setChanging] = React.useState(false);
  const showForm = canVerify && (doc.verificationStatus === 'UNVERIFIED' || changing);

  const form = useZodForm(documentVerifySchema, { defaultValues: { decision: 'APPROVED', reason: '', expiryDate: doc.expiryDate ?? '', issuedDate: doc.issuedDate ?? '' }, emptyAs: 'null' });
  const decision = form.watch('decision');

  // A new version or changed dates arrive from the server: start from them.
  React.useEffect(() => {
    form.reset({ decision: 'APPROVED', reason: '', expiryDate: doc.expiryDate ?? '', issuedDate: doc.issuedDate ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.updatedAt]);

  const save = async (values: { decision: (typeof DECISIONS)[number]; reason?: string | null; expiryDate?: string | null; issuedDate?: string | null }) => {
    const body = values.decision === 'APPROVED' ? { decision: values.decision, ...(values.reason ? { reason: values.reason } : {}), ...(values.expiryDate ? { expiryDate: values.expiryDate } : {}), ...(values.issuedDate ? { issuedDate: values.issuedDate } : {}) } : { decision: values.decision, reason: values.reason };
    await api.client.post(`/documents/${doc.id}/verify`, body);
    toasts.success(t(`people.documents.verify.done.${values.decision}`), doc.title);
    setChanging(false);
    await Promise.all([queryClient.invalidateQueries({ queryKey: peopleKeys.documents.all }), queryClient.invalidateQueries({ queryKey: ['requests'] })]);
  };

  const history = doc.verifications ?? [];
  return (
    <Section
      title={t('people.documents.verify.title')}
      action={<StatusBadge kind="verification" status={doc.verificationStatus} />}
      description={doc.verifiedAt ? t('people.documents.verify.lastChecked', { when: formatDateTime(doc.verifiedAt) }) : t('people.documents.verify.notChecked')}
    >
      {showForm ? (
        <Form form={form} onSubmit={save} className="space-y-4">
          <FormField name="decision" label={t('people.documents.verify.decision')}>
            {(field) => (
              <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('people.documents.verify.decision')}>
                {DECISIONS.map((value) => (
                  <ChoiceLabel key={value} htmlFor={`${ids}-${value}`} control={<RadioGroupItem id={`${ids}-${value}`} value={value} />} label={t(`people.documents.verify.decisions.${value}.label`)} description={t(`people.documents.verify.decisions.${value}.text`)} />
                ))}
              </RadioGroup>
            )}
          </FormField>

          {decision === 'APPROVED' ? (
            hasExpiry || doc.expiryDate || doc.issuedDate ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField name="issuedDate" label={t('people.documents.fields.issuedDate')} optional>
                  {(field) => <DatePicker {...field} />}
                </FormField>
                <FormField name="expiryDate" label={t('people.documents.fields.expiryDate')} optional hint={t('people.documents.verify.expiryHint')}>
                  {(field) => <DatePicker {...field} />}
                </FormField>
              </div>
            ) : null
          ) : (
            <FormField name="reason" label={t('people.documents.verify.reason')} required hint={t('people.documents.verify.reasonHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
          )}
          <FormError />
          <div className="flex flex-wrap justify-end gap-2">
            {changing ? (
              <Button variant="outline" onClick={() => setChanging(false)} disabled={form.formState.isSubmitting}>
                {t('common.cancel')}
              </Button>
            ) : null}
            <Button type="submit" variant={decision === 'APPROVED' ? 'default' : 'destructive'} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t(`people.documents.verify.submit.${decision}`)}
            </Button>
          </div>
        </Form>
      ) : canVerify ? (
        <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
          {t('people.documents.verify.change')}
        </Button>
      ) : doc.status !== 'AVAILABLE' ? (
        <Alert tone="info">{t('people.documents.verify.notAvailable')}</Alert>
      ) : null}

      {history.length ? (
        <div className={canVerify || doc.status !== 'AVAILABLE' ? 'mt-6 border-t pt-5' : undefined}>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('people.documents.verify.history')}</h3>
          <Timeline
            items={history.map((v) => ({
              id: v.id,
              tone: v.decision === 'APPROVED' ? undefined : ('danger' as const),
              title: t(`people.documents.verify.decisions.${v.decision}.past`),
              time: `${formatDateTime(v.createdAt)}${staffName(v.reviewerId) ? ` · ${staffName(v.reviewerId)}` : ''}`,
              description: v.reason ? <span dir="auto">{v.reason}</span> : undefined,
            }))}
          />
        </div>
      ) : !canVerify && doc.status === 'AVAILABLE' ? (
        <p className="text-base text-muted-foreground">{t('people.documents.verify.noHistory')}</p>
      ) : null}
      {doc.expiryDate && doc.expiryVerified ? <p className="mt-4 text-sm text-muted-foreground">{t('people.documents.verify.expiryConfirmed', { date: formatDate(doc.expiryDate) })}</p> : null}
    </Section>
  );
}
