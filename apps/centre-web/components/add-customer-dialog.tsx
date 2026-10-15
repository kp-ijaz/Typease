'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { customerSchema } from '@typease/validation';
import { isApiError, type CustomerProfile, type DuplicateCandidate } from '@typease/api-client';
import {
  Alert, Button, ChoiceLabel, CountrySelect, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection,
  Input, PhoneInput, RadioGroup, RadioGroupItem, Select, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { keys } from '@/lib/query-keys';

/** The fields this dialog asks for: a subset of the shared schema, so the browser and the API apply the same rules. */
const schema = customerSchema.pick({ type: true, fullName: true, fullNameAr: true, phone: true, email: true, nationality: true, preferredLanguage: true, emiratesId: true, taxRegistrationNo: true });

const EMPTY = { type: 'INDIVIDUAL', fullName: '', fullNameAr: '', phone: '', email: '', nationality: '', preferredLanguage: 'en', emiratesId: '', taxRegistrationNo: '' } as const;

export interface AddCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the new record right after it was saved, before the dialog closes. Use it to carry on
   * with that customer (select them in a picker, open their page) instead of looking the record up again.
   */
  onCreated?: (customer: CustomerProfile) => void;
}

/**
 * "Add customer", usable from any screen of the staff app:
 *
 *   const [adding, setAdding] = React.useState(false);
 *   <AddCustomerDialog open={adding} onOpenChange={setAdding} onCreated={(customer) => setCustomerId(customer.id)} />
 *
 * (To send someone to the customers list with the dialog open, link to `/customers?add=1`.)
 *
 * REFERENCE IMPLEMENTATION OF A FORM.
 *  - React Hook Form + the shared Zod schema (`useZodForm`).
 *  - `<Form>` shows API field errors (VALIDATION_FAILED) on their fields and
 *    anything else as a message above the buttons; what was typed stays.
 *  - A business rule with its own answer (409 POSSIBLE_DUPLICATE) is caught
 *    before `<Form>` sees it and gets its own explanation and next steps.
 *  - On success: toast, invalidate the list, hand the record to `onCreated`, close.
 */
export function AddCustomerDialog({ open, onOpenChange, onCreated }: AddCustomerDialogProps) {
  const { t, locale } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(schema, { defaultValues: { ...EMPTY, preferredLanguage: locale } });
  const [duplicates, setDuplicates] = React.useState<DuplicateCandidate[] | null>(null);
  const typeId = React.useId();

  // A fresh form every time the dialog opens.
  React.useEffect(() => {
    if (open) {
      form.reset({ ...EMPTY, preferredLanguage: locale });
      setDuplicates(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (values: Parameters<typeof api.customers.create>[0], confirmNotDuplicate = false) => {
    try {
      const customer = await api.customers.create({ ...values, confirmNotDuplicate });
      toasts.success(t('customers.form.added'), t('customers.form.addedDescription', { name: customer.fullName, number: customer.customerNo }));
      await queryClient.invalidateQueries({ queryKey: keys.customers.all });
      onCreated?.(customer);
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.code === 'POSSIBLE_DUPLICATE') {
        setDuplicates((error.details as { candidates?: DuplicateCandidate[] } | undefined)?.candidates ?? []);
        return;
      }
      throw error;
    }
  };

  const business = form.watch('type') === 'BUSINESS';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form form={form} onSubmit={(values) => save(values)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{t('customers.form.title')}</DialogTitle>
            <DialogDescription>{t('customers.form.description')}</DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-6">
            <FormField name="type" label={t('customers.form.type')}>
              {(field) => (
                <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('customers.form.type')} className="flex flex-wrap gap-x-8 gap-y-2">
                  {(['INDIVIDUAL', 'BUSINESS'] as const).map((value) => (
                    <ChoiceLabel key={value} htmlFor={`${typeId}-${value}`} control={<RadioGroupItem id={`${typeId}-${value}`} value={value} />} label={t(`customers.types.${value}`)} />
                  ))}
                </RadioGroup>
              )}
            </FormField>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="fullName" label={t('customers.form.fullName')} required hint={t('customers.form.fullNameHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" autoFocus />}
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
                {business ? null : (
                  <FormField name="nationality" label={t('customers.form.nationality')}>
                    {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                  </FormField>
                )}
              </div>
            </FormSection>

            {business ? (
              <FormSection title={t('customers.form.tax')}>
                <FormField name="taxRegistrationNo" label={t('customers.form.trn')} hint={t('customers.form.trnHint')} className="sm:max-w-xs">
                  {(field) => <Input {...field} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="100000000000003" className="tabular" />}
                </FormField>
              </FormSection>
            ) : null}

            {business ? null : (
              <FormSection title={t('customers.form.identity')}>
                <FormField name="emiratesId" label={t('customers.form.emiratesId')} hint={t('customers.form.emiratesIdHint')} className="sm:max-w-xs">
                  {(field) => <Input {...field} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="784-0000-0000000-0" className="tabular" />}
                </FormField>
              </FormSection>
            )}

            {duplicates ? (
              <Alert tone="warning" live title={t('customers.duplicate.title')}>
                <p>{t('customers.duplicate.text')}</p>
                <ul className="mt-3 space-y-2">
                  {duplicates.map(({ customer, signals }) => (
                    <li key={customer.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-warning/40 bg-card px-3 py-2">
                      <span className="min-w-0">
                        <span className="block font-medium text-foreground">
                          {customer.fullName} <span className="tabular font-normal text-muted-foreground">{customer.customerNo}</span>
                        </span>
                        <span className="block text-sm text-muted-foreground">{signals.map((s) => t(`customers.duplicate.signals.${s}`)).join(', ')}</span>
                      </span>
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/customers/${customer.id}`}>{t('customers.duplicate.open')}</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button variant="link" className="mt-3" loading={form.formState.isSubmitting} onClick={() => void form.handleSubmit((values) => save(values, true))()}>
                  {t('customers.duplicate.confirm')}
                </Button>
              </Alert>
            ) : null}

            <FormError />
          </DialogBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('customers.form.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
