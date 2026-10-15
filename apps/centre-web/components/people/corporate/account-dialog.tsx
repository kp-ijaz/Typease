'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { corporateAccountSchema } from '@typease/validation';
import { isApiError } from '@typease/api-client';
import {
  Alert, Button, CountrySelect, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection, Input, MoneyInput, Select, Textarea,
  normaliseEmpty, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { UpgradeAlert, isPlanLimit } from '../shared';
import type { CorporateAccount } from '../types';

const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'] as const;

function defaultsOf(a?: CorporateAccount | null) {
  return {
    companyName: a?.companyName ?? '',
    companyNameAr: a?.companyNameAr ?? '',
    tradeLicenceNo: a?.tradeLicenceNo ?? '',
    tradeLicenceAuthority: a?.tradeLicenceAuthority ?? '',
    tradeLicenceExpiry: a?.tradeLicenceExpiry ?? '',
    taxRegistrationNo: a?.taxRegistrationNo ?? '',
    billingEmail: a?.billingEmail ?? '',
    billingAddress: { line1: a?.billingAddress?.line1 ?? '', city: a?.billingAddress?.city ?? '', emirate: a?.billingAddress?.emirate ?? '', country: a?.billingAddress?.country ?? (a ? '' : 'AE'), poBox: a?.billingAddress?.poBox ?? '' },
    paymentTermsDays: a?.paymentTermsDays ?? 0,
    creditLimit: a?.creditLimit ? Number(a.creditLimit).toFixed(2) : '',
    notes: a?.notes ?? '',
  };
}

/**
 * Create or edit a company. Verification, status and credit approval are not part of this form: they are
 * separate decisions (`corporate.verify`). Changing the credit limit or the payment terms of a company
 * whose credit is approved withdraws that approval: the form says so before saving.
 */
export function CorporateAccountDialog({ account, open, onOpenChange }: { account?: CorporateAccount | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, has } = useI18n();
  const api = useApi();
  const router = useRouter();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(corporateAccountSchema, { defaultValues: defaultsOf(account), emptyAs: 'null' });
  const [limitReached, setLimitReached] = React.useState(false);

  const creditLimit = form.watch('creditLimit');
  const terms = form.watch('paymentTermsDays');
  const termsChanged = !!account?.creditApproved && (Number(creditLimit || 0) !== Number(account.creditLimit || 0) || Number(terms) !== account.paymentTermsDays);
  const emirateLabel = (name: string) => (has(`people.emirates.${name.replace(/ /g, '')}`) ? t(`people.emirates.${name.replace(/ /g, '')}`) : name);

  const save = async (values: Record<string, unknown>) => {
    setLimitReached(false);
    try {
      if (account) {
        const before = corporateAccountSchema.safeParse(normaliseEmpty(defaultsOf(account), 'null'));
        const initial: Record<string, unknown> = before.success ? before.data : {};
        const body = Object.fromEntries(Object.entries(values).filter(([key, value]) => !before.success || JSON.stringify(value ?? null) !== JSON.stringify(initial[key] ?? null)));
        if (Object.keys(body).length === 0) {
          onOpenChange(false);
          return;
        }
        const saved = await api.client.patch<CorporateAccount>(`/corporate-accounts/${account.id}`, body);
        if (saved.creditApprovalWithdrawn) toasts.warning(t('people.corporate.form.creditWithdrawn'), t('people.corporate.form.creditWithdrawnText'));
        else toasts.success(t('people.corporate.form.saved'), saved.companyName);
        await queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.all });
        onOpenChange(false);
      } else {
        const created = await api.client.post<CorporateAccount>('/corporate-accounts', values);
        toasts.success(t('people.corporate.form.added'), t('people.corporate.form.addedText', { name: created.companyName, number: created.accountNo }));
        await Promise.all([queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.all }), queryClient.invalidateQueries({ queryKey: peopleKeys.plan })]);
        onOpenChange(false);
        router.push(`/corporate/${created.id}`);
      }
    } catch (error) {
      if (isPlanLimit(error)) {
        setLimitReached(true);
        return;
      }
      if (isApiError(error) && error.code === 'DUPLICATE_TRADE_LICENCE') {
        form.setError('tradeLicenceNo', { type: 'server', message: error.message });
        form.setFocus('tradeLicenceNo');
        return;
      }
      throw error;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form form={form} onSubmit={(values) => save(values as Record<string, unknown>)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{account ? t('people.corporate.form.editTitle') : t('people.corporate.form.addTitle')}</DialogTitle>
            <DialogDescription>{account ? t('people.corporate.form.editText') : t('people.corporate.form.addText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="companyName" label={t('people.corporate.fields.companyName')} required hint={t('people.corporate.form.companyNameHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" autoFocus={!account} />}
              </FormField>
              <FormField name="companyNameAr" label={t('people.corporate.fields.companyNameAr')} optional>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
            </div>

            <FormSection title={t('people.corporate.sections.licence')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="tradeLicenceNo" label={t('people.corporate.fields.tradeLicenceNo')}>
                  {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
                </FormField>
                <FormField name="tradeLicenceExpiry" label={t('people.corporate.fields.tradeLicenceExpiry')}>
                  {(field) => <DatePicker {...field} />}
                </FormField>
                <FormField name="tradeLicenceAuthority" label={t('people.corporate.fields.tradeLicenceAuthority')} hint={t('people.corporate.form.authorityHint')}>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="taxRegistrationNo" label={t('people.corporate.fields.taxRegistrationNo')}>
                  {(field) => <Input {...field} autoComplete="off" dir="ltr" inputMode="numeric" className="tabular" />}
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('people.corporate.sections.billing')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="billingEmail" label={t('people.corporate.fields.billingEmail')}>
                  {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
                </FormField>
                <FormField name="billingAddress.poBox" label={t('people.corporate.fields.poBox')}>
                  {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
                </FormField>
                <FormField name="billingAddress.line1" label={t('people.customer.fields.addressLine')} className="sm:col-span-2">
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="billingAddress.city" label={t('people.customer.fields.city')}>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="billingAddress.emirate" label={t('people.customer.fields.emirate')}>
                  {(field) => <Select {...field} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={[...new Set([...(field.value ? [field.value as string] : []), ...EMIRATES])].map((e) => ({ value: e, label: emirateLabel(e) }))} />}
                </FormField>
                <FormField name="billingAddress.country" label={t('people.customer.fields.country')}>
                  {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('people.corporate.sections.credit')} description={t('people.corporate.form.creditHint')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="paymentTermsDays" label={t('people.corporate.fields.paymentTermsDays')} hint={t('people.corporate.form.termsHint')}>
                  {(field) => <Input {...field} type="number" inputMode="numeric" min={0} max={365} dir="ltr" className="tabular" onChange={(e) => field.onChange(e.target.value === '' ? 0 : Number(e.target.value))} />}
                </FormField>
                <FormField name="creditLimit" label={t('people.corporate.fields.creditLimit')}>
                  {(field) => <MoneyInput {...field} />}
                </FormField>
              </div>
              {termsChanged ? (
                <Alert tone="warning" live title={t('people.corporate.form.withdrawTitle')}>
                  {t('people.corporate.form.withdrawText')}
                </Alert>
              ) : null}
            </FormSection>

            <FormField name="notes" label={t('people.corporate.fields.notes')} optional hint={t('people.corporate.form.notesHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>

            {limitReached ? <UpgradeAlert title={t('people.corporate.limit.title')}>{t('people.corporate.limit.apiText')}</UpgradeAlert> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {account ? t('common.saveChanges') : t('people.corporate.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
