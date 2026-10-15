'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { LAWFUL_BASES, staffConsentSchema } from '@typease/validation';
import {
  Alert, Badge, Button, ChoiceLabel, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, RadioGroup, RadioGroupItem, Select, Skeleton,
  Timeline, useApi, useI18n, useSession, useToast, useZodForm, type Tone,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, Section, useStaffNames } from '../shared';
import type { ConsentState, CustomerConsents, CustomerOverview, LawfulBasis } from '../types';

const STATUS_TONE: Record<ConsentState['status'], Tone> = { GRANTED: 'success', WITHDRAWN: 'danger', NOT_SET: 'neutral' };

/**
 * Consent per purpose with its history. Staff record a decision the customer gave at the counter or by
 * phone; the API stores it as "recorded by staff" with who and when, and appends it to a history that
 * cannot be changed.
 */
export function ConsentsCard({ customer, readOnly }: { customer: CustomerOverview; readOnly: boolean }) {
  const { t, formatDate } = useI18n();
  const api = useApi();
  const session = useSession();
  const canWrite = !readOnly && session.hasPermission('customer.update');
  const [recording, setRecording] = React.useState<ConsentState | null>(null);
  const [history, setHistory] = React.useState(false);

  const consents = useQuery({ queryKey: peopleKeys.customers.consents(customer.id), queryFn: () => api.client.get<CustomerConsents>(`/customers/${customer.id}/consents`) });

  return (
    <Section
      title={t('people.customer.consents.title')}
      description={t('people.customer.consents.description')}
      flush
      action={
        <Button variant="outline" size="sm" onClick={() => setHistory(true)} disabled={!consents.data}>
          <History aria-hidden="true" />
          {t('people.customer.consents.history')}
        </Button>
      }
    >
      {consents.isPending ? (
        <div className="space-y-3 p-5" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : consents.isError ? (
        <div className="p-4">
          <LoadError error={consents.error} onRetry={() => void consents.refetch()} />
        </div>
      ) : (
        <ul className="divide-y">
          {consents.data.consents.map((consent) => (
            <li key={consent.purpose} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-base font-medium text-foreground">{t(`people.customer.consents.purposes.${consent.purpose}.name`)}</p>
                <p className="text-sm text-muted-foreground">{t(`people.customer.consents.purposes.${consent.purpose}.text`)}</p>
              </div>
              <div className="flex shrink-0 flex-col items-start gap-0.5 sm:items-end">
                <Badge tone={STATUS_TONE[consent.status]}>{t(`people.customer.consents.status.${consent.status}`)}</Badge>
                {consent.updatedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {consent.lawfulBasis ? `${t(`people.customer.consents.basis.${consent.lawfulBasis}`)} · ` : ''}
                    <span className="tabular">{formatDate(consent.updatedAt)}</span>
                  </span>
                ) : null}
              </div>
              {canWrite ? (
                <Button variant="subtle" size="sm" onClick={() => setRecording(consent)}>
                  {t('people.customer.consents.record')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {recording ? <RecordConsentDialog customer={customer} consent={recording} open onOpenChange={(next) => !next && setRecording(null)} /> : null}
      {history && consents.data ? <ConsentHistoryDialog data={consents.data} open onOpenChange={setHistory} /> : null}
    </Section>
  );
}

const formSchema = staffConsentSchema;

function RecordConsentDialog({ customer, consent, open, onOpenChange }: { customer: CustomerOverview; consent: ConsentState; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const ids = React.useId();
  const defaultBasis: LawfulBasis = consent.lawfulBasis ?? (consent.purpose === 'SERVICE_PROCESSING' ? 'CONTRACT' : 'CONSENT');
  const form = useZodForm(formSchema, { defaultValues: { purpose: consent.purpose, granted: consent.status !== 'GRANTED', lawfulBasis: defaultBasis, noticeVersion: consent.noticeVersion ?? '' } });
  const granted = form.watch('granted');

  const save = async (values: { purpose: string; granted: boolean; lawfulBasis?: string; noticeVersion?: string }) => {
    const result = await api.client.put<{ changed: boolean }>(`/customers/${customer.id}/consents`, values);
    if (result.changed) toasts.success(values.granted ? t('people.customer.consents.savedGranted') : t('people.customer.consents.savedWithdrawn'), t(`people.customer.consents.purposes.${consent.purpose}.name`));
    else toasts.info(t('people.customer.consents.unchanged'));
    // MARKETING and WHATSAPP mirror flags on the profile, so the overview is refreshed too.
    await queryClient.invalidateQueries({ queryKey: peopleKeys.customers.detail(customer.id) });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('people.customer.consents.recordTitle')}</DialogTitle>
            <DialogDescription>
              {t(`people.customer.consents.purposes.${consent.purpose}.name`)}: {t(`people.customer.consents.purposes.${consent.purpose}.text`)}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="granted" label={t('people.customer.consents.decision')} required>
              {(field) => (
                <RadioGroup id={field.id} value={field.value === true ? 'yes' : 'no'} onValueChange={(v) => field.onChange(v === 'yes')} aria-label={t('people.customer.consents.decision')}>
                  <ChoiceLabel htmlFor={`${ids}-yes`} control={<RadioGroupItem id={`${ids}-yes`} value="yes" />} label={t('people.customer.consents.decisionGrant')} />
                  <ChoiceLabel htmlFor={`${ids}-no`} control={<RadioGroupItem id={`${ids}-no`} value="no" />} label={t('people.customer.consents.decisionWithdraw')} />
                </RadioGroup>
              )}
            </FormField>
            {consent.purpose === 'SERVICE_PROCESSING' && !granted ? <Alert tone="warning">{t('people.customer.consents.serviceWarning')}</Alert> : null}
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="lawfulBasis" label={t('people.customer.consents.lawfulBasis')} hint={t('people.customer.consents.lawfulBasisHint')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={LAWFUL_BASES.map((b) => ({ value: b, label: t(`people.customer.consents.basis.${b}`) }))} />}
              </FormField>
              <FormField name="noticeVersion" label={t('people.customer.consents.noticeVersion')} optional hint={t('people.customer.consents.noticeVersionHint')}>
                {(field) => <Input {...field} autoComplete="off" maxLength={20} dir="ltr" />}
              </FormField>
            </div>
            <Alert tone="info" title={t('people.customer.consents.captureTitle')}>
              {t('people.customer.consents.captureText', { name: session.user?.fullName ?? '' })}
            </Alert>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('people.customer.consents.save')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ConsentHistoryDialog({ data, open, onOpenChange }: { data: CustomerConsents; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, formatDateTime } = useI18n();
  const staffName = useStaffNames();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('people.customer.consents.historyTitle')}</DialogTitle>
          <DialogDescription>{t('people.customer.consents.historyText')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {data.history.length === 0 ? (
            <p className="text-base text-muted-foreground">{t('people.customer.consents.historyEmpty')}</p>
          ) : (
            <Timeline
              items={data.history.map((record) => {
                const who = staffName(record.capturedById);
                return {
                  id: record.id,
                  tone: record.status === 'WITHDRAWN' ? ('danger' as const) : undefined,
                  title: `${t(`people.customer.consents.purposes.${record.purpose}.name`)}: ${t(`people.customer.consents.status.${record.status}`)}`,
                  time: formatDateTime(record.createdAt),
                  description: (
                    <span className="text-muted-foreground">
                      {t(`people.customer.consents.capturedVia.${record.capturedVia}`)}
                      {who ? ` (${who})` : ''}
                      {record.lawfulBasis ? ` · ${t(`people.customer.consents.basis.${record.lawfulBasis}`)}` : ''}
                      {record.noticeVersion ? ` · ${t('people.customer.consents.noticeShort', { version: record.noticeVersion })}` : ''}
                    </span>
                  ),
                };
              })}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
