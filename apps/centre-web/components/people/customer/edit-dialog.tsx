'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { customerSchema } from '@typease/validation';
import { isApiError, type DuplicateCandidate } from '@typease/api-client';
import {
  Alert, Button, Checkbox, ChoiceLabel, CountrySelect, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection,
  Input, PhoneInput, RadioGroup, RadioGroupItem, Select, normaliseEmpty, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { BooleanField } from '../form-bits';
import type { CustomerOverview, CustomerProfile } from '../types';
import { DuplicateWarning } from './duplicate-warning';

/** The same shared schema as "Add customer" (the API's PATCH accepts any subset of it). */
const schema = customerSchema.pick({
  type: true, fullName: true, fullNameAr: true, preferredLanguage: true, email: true, phone: true, nationality: true, dateOfBirth: true, address: true, taxRegistrationNo: true,
  emiratesId: true, emiratesIdExpiry: true, passportNo: true, passportCountry: true, passportExpiry: true, communicationPrefs: true, marketingOptIn: true,
});

const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'] as const;

function defaultsOf(c: CustomerOverview) {
  return {
    type: c.type,
    fullName: c.fullName,
    fullNameAr: c.fullNameAr ?? '',
    preferredLanguage: (c.preferredLanguage === 'ar' ? 'ar' : 'en') as 'en' | 'ar',
    email: c.email ?? '',
    phone: c.phone ?? '',
    nationality: c.nationality ?? '',
    dateOfBirth: c.dateOfBirth ?? '',
    address: { line1: c.address?.line1 ?? '', city: c.address?.city ?? '', emirate: c.address?.emirate ?? '', country: c.address?.country ?? '' },
    taxRegistrationNo: c.taxRegistrationNo ?? '',
    // Identity numbers arrive masked and are never put into a field: an empty field means "keep the stored number".
    emiratesId: '',
    emiratesIdExpiry: c.emiratesIdExpiry ?? '',
    passportNo: '',
    passportCountry: c.passportCountry ?? '',
    passportExpiry: c.passportExpiry ?? '',
    communicationPrefs: { email: c.communicationPrefs?.email ?? true, sms: c.communicationPrefs?.sms ?? true, whatsapp: c.communicationPrefs?.whatsapp ?? true, push: c.communicationPrefs?.push ?? true },
    marketingOptIn: c.marketingOptIn,
  };
}

/**
 * Edit profile. Only what changed is sent, together with the `version` that was loaded (optimistic
 * concurrency). Changing the mobile, email or an identity number to one another record already has is
 * answered with 409 POSSIBLE_DUPLICATE: the records are shown and the person decides.
 */
export function EditCustomerDialog({ customer, open, onOpenChange }: { customer: CustomerOverview; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, has, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(schema, { defaultValues: defaultsOf(customer), emptyAs: 'null' });
  const emirateLabel = (name: string) => (has(`people.emirates.${name.replace(/ /g, '')}`) ? t(`people.emirates.${name.replace(/ /g, '')}`) : name);
  const [duplicates, setDuplicates] = React.useState<DuplicateCandidate[] | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [removeEid, setRemoveEid] = React.useState(false);
  const [removePassport, setRemovePassport] = React.useState(false);
  const ids = React.useId();

  React.useEffect(() => {
    if (open) {
      form.reset(defaultsOf(customer));
      setDuplicates(null);
      setConflict(false);
      setRemoveEid(false);
      setRemovePassport(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (values: Record<string, unknown>, confirmNotDuplicate = false) => {
    // Compare with what was loaded, after the same normalisation the schema applies.
    const initial = schema.safeParse(normaliseEmpty(defaultsOf(customer), 'null'));
    const before: Record<string, unknown> = initial.success ? initial.data : {};
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'emiratesId' || key === 'passportNo') continue;
      if (!initial.success || JSON.stringify(value ?? null) !== JSON.stringify(before[key] ?? null)) body[key] = value;
    }
    if (values.emiratesId) body.emiratesId = values.emiratesId;
    else if (removeEid) body.emiratesId = null;
    if (values.passportNo) body.passportNo = values.passportNo;
    else if (removePassport) body.passportNo = null;

    if (Object.keys(body).length === 0) {
      toasts.info(t('people.customer.edit.nothingChanged'));
      onOpenChange(false);
      return;
    }
    try {
      const saved = await api.client.patch<CustomerProfile>(`/customers/${customer.id}`, { ...body, version: customer.version, ...(confirmNotDuplicate ? { confirmNotDuplicate: true } : {}) });
      toasts.success(t('people.customer.edit.saved'), saved.fullName);
      await queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all });
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.code === 'POSSIBLE_DUPLICATE') {
        setDuplicates((error.details as { candidates?: DuplicateCandidate[] } | undefined)?.candidates ?? []);
        return;
      }
      if (isApiError(error) && (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION')) {
        setConflict(true);
        return;
      }
      throw error;
    }
  };

  const business = form.watch('type') === 'BUSINESS';
  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form form={form} onSubmit={(values) => save(values as Record<string, unknown>)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('people.customer.edit.title')}</DialogTitle>
            <DialogDescription>{t('people.customer.edit.description', { number: customer.customerNo })}</DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-6">
            <FormField name="type" label={t('customers.form.type')}>
              {(field) => (
                <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('customers.form.type')} className="flex flex-wrap gap-x-8 gap-y-2">
                  {(['INDIVIDUAL', 'BUSINESS'] as const).map((value) => (
                    <ChoiceLabel key={value} htmlFor={`${ids}-${value}`} control={<RadioGroupItem id={`${ids}-${value}`} value={value} />} label={t(`customers.types.${value}`)} />
                  ))}
                </RadioGroup>
              )}
            </FormField>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="fullName" label={t('customers.form.fullName')} required hint={t('customers.form.fullNameHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" />}
              </FormField>
              <FormField name="fullNameAr" label={t('customers.form.fullNameAr')} optional>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
            </div>

            <FormSection title={t('customers.form.contact')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="phone" label={t('customers.form.phone')}>
                  {(field) => <PhoneInput {...field} />}
                </FormField>
                <FormField name="email" label={t('customers.form.email')}>
                  {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
                </FormField>
                <FormField name="preferredLanguage" label={t('customers.form.preferredLanguage')}>
                  {(field) => (
                    <Select
                      {...field}
                      onValueChange={field.onChange}
                      options={[
                        { value: 'en', label: 'English' },
                        { value: 'ar', label: 'العربية' },
                      ]}
                    />
                  )}
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('people.customer.edit.messages')} description={t('people.customer.edit.messagesHint')}>
              <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                <BooleanField name="communicationPrefs.email" label={t('people.channels.EMAIL')} />
                <BooleanField name="communicationPrefs.sms" label={t('people.channels.SMS')} />
                <BooleanField name="communicationPrefs.whatsapp" label={t('people.channels.WHATSAPP')} />
                <BooleanField name="communicationPrefs.push" label={t('people.channels.PUSH')} />
              </div>
              <BooleanField name="marketingOptIn" label={t('people.customer.edit.marketing')} description={t('people.customer.edit.marketingHint')} />
            </FormSection>

            {business ? (
              <FormSection title={t('customers.form.tax')}>
                <FormField name="taxRegistrationNo" label={t('customers.form.trn')} hint={t('customers.form.trnHint')} className="sm:max-w-xs">
                  {(field) => <Input {...field} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="100000000000003" className="tabular" />}
                </FormField>
              </FormSection>
            ) : null}

            {business ? null : (
              <FormSection title={t('people.customer.edit.personal')}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField name="nationality" label={t('customers.form.nationality')}>
                    {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                  </FormField>
                  <FormField name="dateOfBirth" label={t('people.customer.fields.dateOfBirth')}>
                    {(field) => <DatePicker {...field} max={today()} />}
                  </FormField>
                </div>
              </FormSection>
            )}

            <FormSection title={t('people.customer.fields.address')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="address.line1" label={t('people.customer.fields.addressLine')} className="sm:col-span-2">
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="address.city" label={t('people.customer.fields.city')}>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="address.emirate" label={t('people.customer.fields.emirate')}>
                  {(field) => <Select {...field} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={[...new Set([...(field.value ? [field.value as string] : []), ...EMIRATES])].map((e) => ({ value: e, label: emirateLabel(e) }))} />}
                </FormField>
                <FormField name="address.country" label={t('people.customer.fields.country')}>
                  {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                </FormField>
              </div>
            </FormSection>

            {business ? null : (
              <FormSection title={t('people.customer.identity.title')} description={t('people.customer.edit.identityHint')}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <FormField
                      name="emiratesId"
                      label={customer.hasEmiratesId ? t('people.customer.edit.newEmiratesId') : t('customers.form.emiratesId')}
                      hint={customer.hasEmiratesId ? t('people.customer.edit.onFile', { masked: customer.emiratesIdMasked ?? '' }) : t('people.customer.edit.emiratesIdFormat')}
                    >
                      {(field) => <Input {...field} disabled={removeEid} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="784-0000-0000000-0" className="tabular" />}
                    </FormField>
                    {customer.hasEmiratesId ? (
                      <ChoiceLabel htmlFor={`${ids}-rm-eid`} control={<Checkbox id={`${ids}-rm-eid`} checked={removeEid} onCheckedChange={(v) => setRemoveEid(v === true)} />} label={t('people.customer.edit.removeNumber')} />
                    ) : null}
                  </div>
                  <FormField name="emiratesIdExpiry" label={t('people.customer.fields.emiratesIdExpiry')}>
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                  <div className="space-y-2">
                    <FormField
                      name="passportNo"
                      label={customer.hasPassport ? t('people.customer.edit.newPassportNo') : t('people.customer.fields.passportNo')}
                      hint={customer.hasPassport ? t('people.customer.edit.onFile', { masked: customer.passportNoMasked ?? '' }) : undefined}
                    >
                      {(field) => <Input {...field} disabled={removePassport} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" />}
                    </FormField>
                    {customer.hasPassport ? (
                      <ChoiceLabel htmlFor={`${ids}-rm-pp`} control={<Checkbox id={`${ids}-rm-pp`} checked={removePassport} onCheckedChange={(v) => setRemovePassport(v === true)} />} label={t('people.customer.edit.removeNumber')} />
                    ) : null}
                  </div>
                  <FormField name="passportCountry" label={t('people.customer.fields.passportCountry')}>
                    {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                  </FormField>
                  <FormField name="passportExpiry" label={t('people.customer.fields.passportExpiry')}>
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                </div>
              </FormSection>
            )}

            {duplicates ? (
              <DuplicateWarning candidates={duplicates} confirming={submitting} confirmLabel={t('people.customer.edit.confirmDifferent')} onConfirm={() => void form.handleSubmit((values) => save(values as Record<string, unknown>, true))()} />
            ) : null}

            {conflict ? (
              <Alert
                tone="warning"
                live
                title={t('people.customer.edit.conflictTitle')}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await queryClient.invalidateQueries({ queryKey: peopleKeys.customers.detail(customer.id) });
                      onOpenChange(false);
                    }}
                  >
                    {t('people.customer.edit.conflictReload')}
                  </Button>
                }
              >
                {t('people.customer.edit.conflictText')}
              </Alert>
            ) : null}

            <FormError />
          </DialogBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={submitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
