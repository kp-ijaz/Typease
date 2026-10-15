'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { corporateCreditDecisionSchema, corporateStatusReasonSchema, verifyCorporateAccountSchema } from '@typease/validation';
import { isApiError } from '@typease/api-client';
import {
  Alert, Button, ChoiceLabel, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, MoneyInput, RadioGroup, RadioGroupItem, Textarea,
  useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import type { CorporateAccount, CorporateAccountDetail } from '../types';

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.all }), queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.detail(id) })]);
}

/** Verify the company's authorisation: a decision of its own, with a note saying what was checked. */
export function VerifyCorporateDialog({ account, open, onOpenChange }: { account: CorporateAccount; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const refresh = useRefresh(account.id);
  const form = useZodForm(verifyCorporateAccountSchema, { defaultValues: { note: '' } });
  const save = async (values: { note: string }) => {
    await api.client.post<CorporateAccount>(`/corporate-accounts/${account.id}/verify`, values);
    toasts.success(t('people.corporate.verify.done'), account.companyName);
    await refresh();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('people.corporate.verify.title')}</DialogTitle>
            <DialogDescription>{t('people.corporate.verify.text', { name: account.companyName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="note" label={t('people.corporate.verify.note')} required hint={t('people.corporate.verify.noteHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            <Alert tone="info">{t('people.corporate.verify.effect')}</Alert>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('people.corporate.verify.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Approve or withdraw the credit terms. Approving needs a verified company and a limit above zero. */
export function CreditDecisionDialog({ account, open, onOpenChange }: { account: CorporateAccount; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const refresh = useRefresh(account.id);
  const ids = React.useId();
  const form = useZodForm(corporateCreditDecisionSchema, {
    defaultValues: { approved: !account.creditApproved, creditLimit: account.creditLimit ? Number(account.creditLimit).toFixed(2) : '', paymentTermsDays: account.paymentTermsDays, note: '' },
  });
  const approved = form.watch('approved');

  const save = async (values: { approved: boolean; creditLimit?: string; paymentTermsDays?: number; note: string }) => {
    const body = values.approved ? values : { approved: false, note: values.note };
    await api.client.post<CorporateAccount>(`/corporate-accounts/${account.id}/credit`, body);
    toasts.success(values.approved ? t('people.corporate.credit.approvedDone') : t('people.corporate.credit.withdrawnDone'), account.companyName);
    await refresh();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('people.corporate.credit.title')}</DialogTitle>
            <DialogDescription>{t('people.corporate.credit.text', { name: account.companyName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="approved" label={t('people.corporate.credit.decision')}>
              {(field) => (
                <RadioGroup id={field.id} value={field.value === true ? 'yes' : 'no'} onValueChange={(v) => field.onChange(v === 'yes')} aria-label={t('people.corporate.credit.decision')}>
                  <ChoiceLabel htmlFor={`${ids}-yes`} control={<RadioGroupItem id={`${ids}-yes`} value="yes" />} label={t('people.corporate.credit.approve')} description={t('people.corporate.credit.approveHint')} />
                  <ChoiceLabel htmlFor={`${ids}-no`} control={<RadioGroupItem id={`${ids}-no`} value="no" />} label={t('people.corporate.credit.withdraw')} description={t('people.corporate.credit.withdrawHint')} />
                </RadioGroup>
              )}
            </FormField>
            {approved ? (
              <>
                {account.verifiedAt ? null : <Alert tone="warning">{t('people.corporate.credit.needsVerification')}</Alert>}
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField name="creditLimit" label={t('people.corporate.fields.creditLimit')} required>
                    {(field) => <MoneyInput {...field} />}
                  </FormField>
                  <FormField name="paymentTermsDays" label={t('people.corporate.fields.paymentTermsDays')} hint={t('people.corporate.form.termsHint')}>
                    {(field) => <Input {...field} type="number" inputMode="numeric" min={0} max={365} dir="ltr" className="tabular" onChange={(e) => field.onChange(e.target.value === '' ? 0 : Number(e.target.value))} />}
                  </FormField>
                </div>
              </>
            ) : null}
            <FormField name="note" label={t('people.corporate.credit.note')} required hint={t('people.corporate.credit.noteHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={approved ? 'default' : 'destructive'} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {approved ? t('people.corporate.credit.approveSubmit') : t('people.corporate.credit.withdrawSubmit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Suspend or archive: both need a reason; archiving is refused while the company has open requests. */
export function StatusReasonDialog({ account, action, open, onOpenChange }: { account: CorporateAccountDetail; action: 'suspend' | 'archive'; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const refresh = useRefresh(account.id);
  const form = useZodForm(corporateStatusReasonSchema, { defaultValues: { reason: '' } });
  const [blocked, setBlocked] = React.useState<string | null>(null);

  const save = async (values: { reason: string }) => {
    setBlocked(null);
    try {
      await api.client.post<CorporateAccount>(`/corporate-accounts/${account.id}/${action}`, values);
      toasts.success(t(`people.corporate.status.${action}.done`), account.companyName);
      await refresh();
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.code === 'CORPORATE_HAS_OPEN_REQUESTS') {
        setBlocked(error.message);
        return;
      }
      throw error;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t(`people.corporate.status.${action}.title`, { name: account.companyName })}</DialogTitle>
            <DialogDescription>{t(`people.corporate.status.${action}.text`)}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {action === 'archive' && account.counters.openRequests > 0 && !blocked ? <Alert tone="warning">{tn('people.corporate.status.archive.openRequests', account.counters.openRequests)}</Alert> : null}
            {blocked ? (
              <Alert tone="danger" live title={t('people.corporate.status.archive.blockedTitle')}>
                {blocked}
              </Alert>
            ) : null}
            <FormField name="reason" label={t('people.corporate.status.reason')} required>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t(`people.corporate.status.${action}.submit`)}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
