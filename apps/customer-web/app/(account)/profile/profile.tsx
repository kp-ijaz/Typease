'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { updateOwnCustomerSchema } from '@typease/validation';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ChangePasswordForm, CountrySelect, DescriptionList, Form, FormActions, FormError, FormField, FormSection, Input,
  MfaSetupPanel, PageHeader, Select, SessionsPanel, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, countryName, formatPhone, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { LoadError } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { OwnCustomer } from '@/lib/types';
import { PrivacyTab } from './privacy';

const TABS = ['details', 'security', 'privacy'] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);

/** The customer's own record with the centre, sign-in security, and their privacy choices. */
export function Profile() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tabParam = search.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'details';
  const setTab = (next: string) => router.replace(next === 'details' ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  return (
    <>
      <PageHeader title={t('nav.profile')} description={t('account.sections.profile')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="-mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsTrigger value="details">{t('my.profile.tabs.details')}</TabsTrigger>
          <TabsTrigger value="security">{t('my.profile.tabs.security')}</TabsTrigger>
          <TabsTrigger value="privacy">{t('my.profile.tabs.privacy')}</TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <DetailsTab />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="privacy">
          <PrivacyTab />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- my details

function DetailsTab() {
  const { t } = useI18n();
  const api = usePortalApi();
  const me = useQuery({ queryKey: keys.profile.me, queryFn: () => api.me() });
  if (me.isPending) {
    return (
      <div className="space-y-5" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-72" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (me.isError) return <LoadError error={me.error} onRetry={() => void me.refetch()} />;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <Card className="min-w-0">
        <CardHeader>
          <div>
            <CardTitle>{t('my.profile.details.title')}</CardTitle>
            <CardDescription>{t('my.profile.details.text')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <DetailsForm customer={me.data} />
        </CardContent>
      </Card>
      <OnFile customer={me.data} />
    </div>
  );
}

function DetailsForm({ customer }: { customer: OwnCustomer }) {
  const { t, setLocale } = useI18n();
  const api = usePortalApi();
  const auth = useApi().auth;
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const defaults = React.useMemo(
    () => ({
      fullName: customer.fullName,
      fullNameAr: customer.fullNameAr ?? '',
      preferredLanguage: (customer.preferredLanguage === 'ar' ? 'ar' : 'en') as 'en' | 'ar',
      address: { line1: customer.address?.line1 ?? '', city: customer.address?.city ?? '', emirate: customer.address?.emirate ?? '', country: customer.address?.country ?? '' },
    }),
    [customer],
  );
  // An edit form: an emptied field clears the stored value.
  const form = useZodForm(updateOwnCustomerSchema, { defaultValues: defaults, emptyAs: 'null' });
  React.useEffect(() => form.reset(defaults), [form, defaults]);

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        const saved = await api.updateMe(values);
        queryClient.setQueryData(keys.profile.me, saved);
        // The sign-in account carries the same name and language (the greeting, the language of emails).
        const language = saved.preferredLanguage === 'ar' ? 'ar' : 'en';
        if (saved.fullName !== session.user?.fullName || language !== session.user?.preferredLanguage) {
          await auth.updateProfile({ fullName: saved.fullName.slice(0, 120), preferredLanguage: language });
          await session.reload();
        }
        // The interface follows the language the person just chose for themselves.
        setLocale(language);
        toasts.success(t('my.profile.details.saved'));
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField name="fullName" label={t('my.profile.details.fullName')} required hint={t('my.profile.details.fullNameHint')}>
          {(field) => <Input {...field} autoComplete="name" />}
        </FormField>
        <FormField name="fullNameAr" label={t('my.profile.details.fullNameAr')} optional>
          {(field) => <Input {...field} dir="rtl" lang="ar" autoComplete="off" />}
        </FormField>
      </div>
      <FormField name="preferredLanguage" label={t('my.profile.details.language')} hint={t('my.profile.details.languageHint')} className="max-w-xs">
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
      <FormSection title={t('my.profile.details.address')}>
        <FormField name="address.line1" label={t('my.profile.details.addressLine')} optional>
          {(field) => <Input {...field} dir="auto" autoComplete="street-address" />}
        </FormField>
        <div className="grid gap-5 sm:grid-cols-3">
          <FormField name="address.city" label={t('my.profile.details.city')} optional>
            {(field) => <Input {...field} dir="auto" autoComplete="address-level2" />}
          </FormField>
          <FormField name="address.emirate" label={t('my.profile.details.emirate')} optional>
            {(field) => <Input {...field} dir="auto" autoComplete="address-level1" />}
          </FormField>
          <FormField name="address.country" label={t('my.profile.details.country')} optional>
            {(field) => <CountrySelect {...field} onValueChange={field.onChange} clearable />}
          </FormField>
        </div>
      </FormSection>
      <FormError />
      <FormActions className="sm:justify-start">
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('common.saveChanges')}
        </Button>
      </FormActions>
    </Form>
  );
}

/** What the centre has on file and only the centre can change: contact and identity details. Identity numbers stay masked. */
function OnFile({ customer }: { customer: OwnCustomer }) {
  const { t, locale, formatDate } = useI18n();
  // Country names come from Intl and differ between server and browser: only after mount.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const country = (code: string | null) => (code ? (mounted ? countryName(code, locale) : code) : null);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('my.profile.onFile.title')}</CardTitle>
          <CardDescription>{t('my.profile.onFile.text')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <DescriptionList
          columns={1}
          items={[
            { label: t('my.profile.onFile.customerNo'), value: <span className="tabular ltr-value">{customer.customerNo}</span> },
            { label: t('auth.email'), value: customer.email ? <span className="ltr-value break-all">{customer.email}</span> : null },
            { label: t('my.profile.onFile.phone'), value: customer.phone ? <span className="tabular ltr-value">{formatPhone(customer.phone)}</span> : null },
            { label: t('my.profile.onFile.nationality'), value: country(customer.nationality) },
            { label: t('my.profile.onFile.dateOfBirth'), value: customer.dateOfBirth ? formatDate(customer.dateOfBirth) : null },
            ...(customer.hasEmiratesId
              ? [
                  {
                    label: t('my.profile.onFile.emiratesId'),
                    value: (
                      <>
                        <span className="tabular ltr-value">{customer.emiratesIdMasked}</span>
                        {customer.emiratesIdExpiry ? <span className="block text-sm text-muted-foreground">{t('my.checklist.validUntil', { date: formatDate(customer.emiratesIdExpiry) })}</span> : null}
                      </>
                    ),
                  },
                ]
              : []),
            ...(customer.hasPassport
              ? [
                  {
                    label: t('my.profile.onFile.passport'),
                    value: (
                      <>
                        <span className="tabular ltr-value">{customer.passportNoMasked}</span>
                        {customer.passportExpiry ? <span className="block text-sm text-muted-foreground">{t('my.checklist.validUntil', { date: formatDate(customer.passportExpiry) })}</span> : null}
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
        <Button asChild variant="outline" className="h-auto min-h-10 w-full whitespace-normal py-2 text-center">
          <Link href="/profile?tab=privacy">{t('my.profile.onFile.correct')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- security

function SecurityTab() {
  const { t } = useI18n();
  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('auth.changePassword.title')}</CardTitle>
            <CardDescription>{t('auth.changePassword.subtitle')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('auth.mfa.title')}</CardTitle>
            <CardDescription>{t('my.profile.security.mfaText')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <MfaSetupPanel />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('auth.sessions.title')}</CardTitle>
            <CardDescription>{t('auth.sessions.subtitle')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <SessionsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
