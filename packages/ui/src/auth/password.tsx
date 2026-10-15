'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { changePasswordSchema, forgotPasswordSchema, z } from '@typease/validation';
import type { PasswordPolicy } from '@typease/types';
import { isApiError } from '@typease/api-client';
import { useI18n } from '../i18n/provider';
import { useApi } from '../providers/auth';
import { Alert } from '../components/alert';
import { Button } from '../components/button';
import { PasswordInput } from '../components/fields';
import { Form, FormActions, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { useToast } from '../components/toast';
import { AuthCard, AuthLink, DevTokenHint } from './layout';
import { useNewPasswordRules } from './password-rules';

const forgotStep = forgotPasswordSchema.pick({ email: true });

/** "Forgot your password?": always answers the same way, whether or not the address is registered. */
export function ForgotPasswordForm({ signInHref, tenantSlug, resetPath = '/reset-password' }: { signInHref: string; tenantSlug?: string; resetPath?: string }) {
  const { t } = useI18n();
  const api = useApi();
  const form = useZodForm(forgotStep, { defaultValues: { email: '' } });
  const [sent, setSent] = React.useState<{ email: string; devToken?: string } | null>(null);

  if (sent) {
    return (
      <AuthCard title={t('auth.forgot.sentTitle')} footer={<AuthLink href={signInHref}>{t('auth.forgot.backToSignIn')}</AuthLink>}>
        <div className="flex gap-3 text-base text-foreground">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" />
          <p role="status">{t('auth.forgot.sent', { email: sent.email })}</p>
        </div>
        {sent.devToken ? (
          <DevTokenHint>
            <AuthLink href={`${resetPath}?token=${encodeURIComponent(sent.devToken)}`}>{t('auth.dev.resetLink')}</AuthLink>
          </DevTokenHint>
        ) : null}
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('auth.forgot.title')} subtitle={t('auth.forgot.subtitle')} footer={<AuthLink href={signInHref}>{t('auth.forgot.backToSignIn')}</AuthLink>}>
      <Form
        form={form}
        onSubmit={async ({ email }) => {
          const r = await api.auth.forgotPassword({ email, tenantSlug });
          setSent({ email, devToken: r.dev?.passwordResetToken });
        }}
      >
        <FormField name="email" label={t('auth.email')} required>
          {(field) => <Input {...field} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder={t('auth.emailPlaceholder')} autoFocus />}
        </FormField>
        <FormError />
        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
          {t('auth.forgot.submit')}
        </Button>
      </Form>
    </AuthCard>
  );
}

/**
 * Opened from the emailed link: choose a new password. The rules come from the centre's published
 * password policy (branding context) unless `passwordPolicy` is given; built-in rules otherwise.
 */
export function ResetPasswordForm({ token, signInHref, forgotHref, passwordPolicy }: { token: string | null | undefined; signInHref: string; forgotHref: string; passwordPolicy?: Partial<PasswordPolicy> | null }) {
  const { t } = useI18n();
  const api = useApi();
  const rules = useNewPasswordRules(passwordPolicy);
  const resetStep = React.useMemo(
    () => z.object({ password: rules.field, confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'PASSWORDS_DIFFER' }),
    [rules.field],
  );
  const form = useZodForm(resetStep, { defaultValues: { password: '', confirm: '' } });
  const [done, setDone] = React.useState(false);

  if (!token) {
    return (
      <AuthCard title={t('auth.reset.title')} footer={<AuthLink href={forgotHref}>{t('auth.forgot.title')}</AuthLink>}>
        <Alert tone="warning">{t('auth.reset.missingToken')}</Alert>
      </AuthCard>
    );
  }
  if (done) {
    return (
      <AuthCard title={t('auth.reset.doneTitle')}>
        <div className="flex gap-3 text-base">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" />
          <p role="status">{t('auth.reset.done')}</p>
        </div>
        <Button asChild size="lg" className="mt-6 w-full">
          <Link href={signInHref}>{t('auth.signIn.submit')}</Link>
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('auth.reset.title')} subtitle={t('auth.reset.subtitle')}>
      <Form
        form={form}
        onSubmit={async ({ password }) => {
          await api.auth.resetPassword({ token, password });
          setDone(true);
        }}
      >
        <FormField name="password" label={t('auth.reset.newPassword')} required hint={rules.hint}>
          {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" autoFocus />}
        </FormField>
        <FormField name="confirm" label={t('auth.reset.confirmPassword')} required>
          {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" />}
        </FormField>
        <FormError />
        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('auth.reset.submit')}
        </Button>
      </Form>
    </AuthCard>
  );
}

/**
 * Account page: change the password while signed in. A wrong CURRENT password is reported on that
 * field, in words about the current password (the API's code for it is the one of a failed sign-in).
 */
export function ChangePasswordForm({ onChanged, passwordPolicy }: { onChanged?: () => void; passwordPolicy?: Partial<PasswordPolicy> | null }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const rules = useNewPasswordRules(passwordPolicy);
  const changeStep = React.useMemo(
    () =>
      z
        .object({ currentPassword: changePasswordSchema.shape.currentPassword, newPassword: rules.field, confirm: z.string() })
        .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'PASSWORDS_DIFFER' }),
    [rules.field],
  );
  const form = useZodForm(changeStep, { defaultValues: { currentPassword: '', newPassword: '', confirm: '' } });
  return (
    <Form
      form={form}
      className="max-w-md"
      onSubmit={async ({ currentPassword, newPassword }) => {
        try {
          await api.auth.changePassword({ currentPassword, newPassword });
        } catch (error) {
          if (isApiError(error) && error.code === 'INVALID_CREDENTIALS') {
            form.setError('currentPassword', { type: 'server', message: t('auth.changePassword.currentWrong') }, { shouldFocus: true });
            return;
          }
          throw error;
        }
        form.reset();
        toasts.success(t('auth.changePassword.done'));
        onChanged?.();
      }}
    >
      <FormField name="currentPassword" label={t('auth.changePassword.current')} required>
        {(field) => <PasswordInput {...field} autoComplete="current-password" dir="ltr" />}
      </FormField>
      <FormField name="newPassword" label={t('auth.changePassword.new')} required hint={rules.hint}>
        {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" />}
      </FormField>
      <FormField name="confirm" label={t('auth.changePassword.confirm')} required>
        {(field) => <PasswordInput {...field} autoComplete="new-password" dir="ltr" />}
      </FormField>
      <FormError />
      <FormActions className="sm:justify-start">
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('auth.changePassword.submit')}
        </Button>
      </FormActions>
    </Form>
  );
}
