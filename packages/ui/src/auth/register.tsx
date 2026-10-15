'use client';

import * as React from 'react';
import { registerCustomerSchema } from '@typease/validation';
import type { PasswordPolicy } from '@typease/types';
import { useI18n } from '../i18n/provider';
import { useApi } from '../providers/auth';
import { Button } from '../components/button';
import { Checkbox, ChoiceLabel } from '../components/checkbox';
import { PasswordInput, PhoneInput } from '../components/fields';
import { Form, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { AuthCard, AuthLink } from './layout';
import { useNewPasswordRules } from './password-rules';

const baseSchema = registerCustomerSchema.omit({ tenantSlug: true, preferredLanguage: true });

export interface RegisterCustomerFormProps {
  /** The centre the account is created with (omit on tenant domains). */
  tenantSlug?: string;
  centreName?: string;
  termsHref: string;
  privacyHref: string;
  signInHref: string;
  /** Called after the account was created; show the "check your email" screen next. */
  onRegistered: (result: { email: string; devToken?: string }) => void;
  /** Default: the centre's published policy from the branding context, else the built-in rules. */
  passwordPolicy?: Partial<PasswordPolicy> | null;
}

/** Customer self-registration with acceptance of the terms and an optional marketing consent. */
export function RegisterCustomerForm({ tenantSlug, centreName, termsHref, privacyHref, signInHref, onRegistered, passwordPolicy }: RegisterCustomerFormProps) {
  const { t, locale } = useI18n();
  const api = useApi();
  const rules = useNewPasswordRules(passwordPolicy);
  const schema = React.useMemo(() => baseSchema.extend({ password: rules.field }), [rules.field]);
  const form = useZodForm(schema, {
    defaultValues: { fullName: '', email: '', phone: undefined, password: '', acceptTerms: false as unknown as true, marketingOptIn: false },
  });
  const termsId = React.useId();
  const marketingId = React.useId();
  const acceptTerms = form.watch('acceptTerms');
  const termsError = form.formState.errors.acceptTerms;

  return (
    <AuthCard
      title={t('auth.register.title')}
      subtitle={centreName ? t('auth.register.subtitleAt', { name: centreName }) : t('auth.register.subtitle')}
      footer={
        <>
          {t('auth.register.haveAccount')} <AuthLink href={signInHref}>{t('auth.signIn.submit')}</AuthLink>
        </>
      }
    >
      <Form
        form={form}
        onSubmit={async (values) => {
          const r = await api.auth.register({ ...values, phone: values.phone || undefined, tenantSlug, preferredLanguage: locale });
          onRegistered({ email: r.email, devToken: r.dev?.emailVerificationToken });
        }}
      >
        <FormField name="fullName" label={t('auth.fullName')} required>
          {(field) => <Input {...field} autoComplete="name" autoFocus />}
        </FormField>
        <FormField name="email" label={t('auth.email')} required>
          {(field) => <Input {...field} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder={t('auth.emailPlaceholder')} />}
        </FormField>
        <FormField name="phone" label={t('auth.phone')} optional>
          {(field) => <PhoneInput {...field} onChange={(v: string) => field.onChange(v || undefined)} />}
        </FormField>
        <FormField name="password" label={t('auth.password')} required hint={rules.hint}>
          {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" />}
        </FormField>

        <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
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
            label={t('auth.register.acceptTerms')}
            description={
              <>
                <AuthLink href={termsHref}>{t('auth.register.terms')}</AuthLink>
                <span aria-hidden="true"> / </span>
                <AuthLink href={privacyHref}>{t('auth.register.privacy')}</AuthLink>
              </>
            }
          />
          {termsError ? (
            <p id={`${termsId}-e`} role="alert" className="text-sm text-destructive-text">
              {t('auth.register.acceptTermsRequired')}
            </p>
          ) : null}
          <ChoiceLabel
            htmlFor={marketingId}
            control={<Checkbox id={marketingId} checked={!!form.watch('marketingOptIn')} onCheckedChange={(checked) => form.setValue('marketingOptIn', checked === true, { shouldDirty: true })} />}
            label={t('auth.register.marketing')}
          />
        </div>

        <FormError />
        <Button type="submit" variant="accent" size="lg" className="w-full" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
          {t('auth.register.submit')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">{t('auth.register.whatNext')}</p>
      </Form>
    </AuthCard>
  );
}
