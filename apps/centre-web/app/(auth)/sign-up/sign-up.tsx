'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { slug as slugRule, tenantSignupSchema } from '@typease/validation';
import {
  AuthCard, AuthLink, Button, Checkbox, ChoiceLabel, Form, FormError, FormField, Input, PasswordInput, PhoneInput, Spinner, useApi, useI18n, useZodForm,
} from '@typease/ui';

const schema = tenantSignupSchema.omit({ preferredLanguage: true });

/** "Al Noor Typing Centre" -> "al-noor-typing-centre" */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Self-service sign-up of a new typing centre (POST /public/signup), with a live check of the web address. */
export function SignUp() {
  const { t, locale } = useI18n();
  const api = useApi();
  const router = useRouter();
  const form = useZodForm(schema, { defaultValues: { businessName: '', slug: '', ownerName: '', email: '', phone: '', password: '', acceptTerms: false as unknown as true } });
  const termsId = React.useId();

  // The web address follows the centre name until the person edits it.
  const slugTouched = React.useRef(false);
  const businessName = form.watch('businessName');
  React.useEffect(() => {
    if (!slugTouched.current) form.setValue('slug', suggestSlug(businessName ?? ''), { shouldValidate: form.formState.isSubmitted });
  }, [businessName, form]);

  const slug = useDebounced(form.watch('slug') ?? '', 350);
  const wellFormed = slugRule.safeParse(slug).success;
  const availability = useQuery({ queryKey: ['slug-available', slug], queryFn: () => api.public.slugAvailable(slug), enabled: wellFormed, staleTime: 15_000, retry: false });
  const taken = wellFormed && availability.data?.available === false;

  const acceptTerms = form.watch('acceptTerms');
  const termsError = form.formState.errors.acceptTerms;

  return (
    <AuthCard
      title={t('auth.signup.title')}
      subtitle={t('auth.signup.subtitle')}
      footer={
        <>
          {t('auth.haveAccount')} <AuthLink href="/sign-in">{t('auth.signIn.submit')}</AuthLink>
        </>
      }
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          if (taken) {
            form.setError('slug', { type: 'server', message: t('auth.signup.slugTaken') });
            form.setFocus('slug');
            return;
          }
          const result = await api.public.signup({ ...values, preferredLanguage: locale });
          const dev = result.dev?.emailVerificationToken;
          router.push(`/verify-email?email=${encodeURIComponent(result.email)}${dev ? `&dev=${encodeURIComponent(dev)}` : ''}`);
        }}
      >
        <FormField name="businessName" label={t('auth.signup.businessName')} required>
          {(field) => <Input {...field} autoComplete="organization" autoFocus />}
        </FormField>
        <FormField
          name="slug"
          label={t('auth.signup.slug')}
          required
          hint={
            !wellFormed || !slug ? (
              t('auth.signup.slugHint')
            ) : availability.isFetching ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="xs" /> {t('auth.signup.slugChecking')}
              </span>
            ) : taken ? (
              <span className="inline-flex items-center gap-1.5 text-destructive-text" role="status">
                <XCircle className="size-4" aria-hidden="true" /> {t('auth.signup.slugTaken')}
              </span>
            ) : availability.data?.available ? (
              <span className="inline-flex items-center gap-1.5 text-success-text" role="status">
                <CheckCircle2 className="size-4" aria-hidden="true" /> {t('auth.signup.slugAvailable')}
              </span>
            ) : (
              t('auth.signup.slugHint')
            )
          }
        >
          {(field) => (
            <Input
              {...field}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                slugTouched.current = true;
                field.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
              }}
              aria-invalid={field['aria-invalid'] || taken}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              dir="ltr"
              className="tabular"
            />
          )}
        </FormField>
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField name="ownerName" label={t('auth.signup.ownerName')} required>
            {(field) => <Input {...field} autoComplete="name" />}
          </FormField>
          <FormField name="phone" label={t('auth.phone')} required>
            {(field) => <PhoneInput {...field} />}
          </FormField>
        </div>
        <FormField name="email" label={t('auth.email')} required>
          {(field) => <Input {...field} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder={t('auth.emailPlaceholder')} />}
        </FormField>
        <FormField name="password" label={t('auth.password')} required hint={t('form.passwordRules')}>
          {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" />}
        </FormField>

        <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
          <ChoiceLabel
            htmlFor={termsId}
            control={
              <Checkbox
                id={termsId}
                checked={!!acceptTerms}
                onCheckedChange={(checked) => form.setValue('acceptTerms', (checked === true) as true, { shouldValidate: form.formState.isSubmitted, shouldDirty: true })}
                aria-invalid={!!termsError}
                aria-describedby={termsError ? `${termsId}-e` : undefined}
                aria-required
              />
            }
            label={t('auth.signup.acceptTerms')}
          />
          {termsError ? (
            <p id={`${termsId}-e`} role="alert" className="text-sm text-destructive-text">
              {t('validation.acceptTerms')}
            </p>
          ) : null}
        </div>

        <FormError />
        <Button type="submit" variant="accent" size="lg" className="w-full" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
          {t('auth.signup.submit')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">{t('auth.signup.whatNext')}</p>
      </Form>
    </AuthCard>
  );
}
