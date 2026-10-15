'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { updateTenantSchema } from '@typease/validation';
import {
  Button, Card, CardContent, CardFooter, Combobox, CopyButton, Form, FormError, FormField, FormSection, Input, PhoneInput, Select, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { CardSkeleton, LoadError, useEmirateOptions } from '@/components/adm/shared';
import type { TenantDetail } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { keys } from '@/lib/query-keys';

const schema = updateTenantSchema.omit({ aiEnabled: true });
const FALLBACK_ZONES = ['Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Muscat', 'UTC'];

/** Centre profile: names, licence, tax, contacts, language and time zone (PATCH /tenant). */
export function ProfileTab() {
  const api = useApi();
  const tenant = useQuery({ queryKey: admKeys.tenant.detail, queryFn: () => api.client.get<TenantDetail>('/tenant') });
  if (tenant.isPending) return <CardSkeleton lines={8} />;
  if (tenant.isError) return <LoadError error={tenant.error} onRetry={() => void tenant.refetch()} />;
  return <ProfileForm key={tenant.data.updatedAt} tenant={tenant.data} />;
}

function ProfileForm({ tenant }: { tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const emirates = useEmirateOptions();
  const form = useZodForm(schema, {
    emptyAs: 'null',
    defaultValues: {
      name: tenant.name,
      legalName: tenant.legalName ?? '',
      emirate: tenant.emirate ?? '',
      contactEmail: tenant.contactEmail ?? '',
      contactPhone: tenant.contactPhone ?? '',
      tradeLicenceNo: tenant.tradeLicenceNo ?? '',
      taxRegistrationNo: tenant.taxRegistrationNo ?? '',
      // The field holds what was typed (a string); the schema coerces it to a number.
      taxRatePercent: tenant.taxRatePercent as unknown as number,
      defaultLanguage: tenant.defaultLanguage as 'en' | 'ar',
      timezone: tenant.timezone,
    },
  });
  // The browser's list of time zones is not the server's: it is built after mount.
  const [zones, setZones] = React.useState<string[]>([tenant.timezone]);
  React.useEffect(() => {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK_ZONES;
    setZones([...new Set([tenant.timezone, ...FALLBACK_ZONES, ...supported])]);
  }, [tenant.timezone]);

  return (
    <Card>
      <Form
        form={form}
        className="space-y-0"
        onSubmit={async (values) => {
          if (String(form.getValues('taxRatePercent') ?? '').trim() === '') {
            form.setError('taxRatePercent', { type: 'manual', message: 'Required' });
            return;
          }
          await api.client.patch('/tenant', values);
          toasts.success(t('adm.settings.profile.saved'));
          await queryClient.invalidateQueries({ queryKey: admKeys.tenant.all });
          await queryClient.invalidateQueries({ queryKey: keys.tenantConfig(tenant.slug) });
          await session.reload();
        }}
      >
        <CardContent className="space-y-8">
          <FormSection title={t('adm.settings.profile.identity')} description={t('adm.settings.profile.identityText')}>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="name" label={t('adm.settings.profile.name')} required hint={t('adm.settings.profile.nameHint')}>
                {(field) => <Input {...field} autoComplete="organization" />}
              </FormField>
              <FormField name="legalName" label={t('adm.settings.profile.legalName')} hint={t('adm.settings.profile.legalNameHint')}>
                {(field) => <Input {...field} autoComplete="off" />}
              </FormField>
              <FormField name="tradeLicenceNo" label={t('adm.settings.profile.tradeLicence')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
              </FormField>
              <FormField name="emirate" label={t('adm.settings.profile.emirate')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={emirates} placeholder={t('common.selectPlaceholder')} />}
              </FormField>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{t('adm.settings.profile.slug')}</span>
              <span className="ltr-value tabular font-medium text-foreground">{tenant.slug}</span>
              <CopyButton value={tenant.slug} label={t('adm.settings.profile.copySlug')} />
              <span>{t('adm.settings.profile.slugNote')}</span>
            </div>
          </FormSection>

          <FormSection title={t('adm.settings.profile.tax')} description={t('adm.settings.profile.taxText')}>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="taxRegistrationNo" label={t('adm.settings.profile.trn')} hint={t('adm.settings.profile.trnHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
              </FormField>
              <FormField name="taxRatePercent" label={t('adm.settings.profile.taxRate')} required hint={t('adm.settings.profile.taxRateHint')}>
                {(field) => (
                  <div className="sm:max-w-32">
                    <Input {...field} inputMode="decimal" autoComplete="off" dir="ltr" className="tabular" endAdornment={<span className="pe-2 text-sm">%</span>} />
                  </div>
                )}
              </FormField>
            </div>
          </FormSection>

          <FormSection title={t('adm.settings.profile.contact')} description={t('adm.settings.profile.contactText')}>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="contactEmail" label={t('adm.settings.profile.email')} required>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="contactPhone" label={t('adm.settings.profile.phone')} required>
                {(field) => <PhoneInput {...field} />}
              </FormField>
            </div>
          </FormSection>

          <FormSection title={t('adm.settings.profile.regional')}>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="defaultLanguage" label={t('adm.settings.profile.language')} hint={t('adm.settings.profile.languageHint')}>
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
              <FormField name="timezone" label={t('adm.settings.profile.timezone')} hint={t('adm.settings.profile.timezoneHint')}>
                {(field) => <Combobox {...field} onValueChange={(value) => field.onChange(value)} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} searchPlaceholder={t('adm.settings.profile.timezoneSearch')} />}
              </FormField>
            </div>
          </FormSection>
          <FormError />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {t('common.saveChanges')}
          </Button>
        </CardFooter>
      </Form>
    </Card>
  );
}
