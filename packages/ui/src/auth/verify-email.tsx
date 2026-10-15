'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { resendVerificationSchema } from '@typease/validation';
import { useI18n } from '../i18n/provider';
import { useApi } from '../providers/auth';
import { Alert } from '../components/alert';
import { Button } from '../components/button';
import { Form, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { LoadingBlock } from '../components/spinner';
import { AuthCard, AuthLink, DevTokenHint } from './layout';

export interface VerifyEmailPanelProps {
  /** From the emailed link (`?token=`). With a token the address is confirmed right away. */
  token?: string | null;
  /** Without a token: the address a link was just sent to ("check your inbox" after registration). */
  email?: string | null;
  /** Development servers only: the token returned by the registration call. */
  devToken?: string | null;
  signInHref: string;
  verifyPath?: string;
}

/**
 * Two uses of one screen:
 *  - arriving from the emailed link: confirms the address and says what to do next;
 *  - right after registration: "we sent you a link", with a way to get a new one.
 */
export function VerifyEmailPanel({ token, email, devToken, signInHref, verifyPath = '/verify-email' }: VerifyEmailPanelProps) {
  const { t } = useI18n();
  const api = useApi();
  const [state, setState] = React.useState<'working' | 'done' | 'failed' | 'pending'>(token ? 'working' : 'pending');
  const [resent, setResent] = React.useState<{ devToken?: string } | null>(null);
  const started = React.useRef<string | null>(null);
  const form = useZodForm(resendVerificationSchema, { defaultValues: { email: email ?? '' } });

  React.useEffect(() => {
    // The token is single-use: React's development double-invocation must not send it twice.
    if (!token || started.current === token) return;
    started.current = token;
    api.auth
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  }, [token, api]);

  if (state === 'working') {
    return (
      <AuthCard title={t('auth.verifyEmail.title')}>
        <LoadingBlock label={t('auth.verifyEmail.working')} className="min-h-24" />
      </AuthCard>
    );
  }
  if (state === 'done') {
    return (
      <AuthCard title={t('auth.verifyEmail.doneTitle')}>
        <div className="flex gap-3 text-base">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" />
          <p role="status">{t('auth.verifyEmail.done')}</p>
        </div>
        <Button asChild size="lg" className="mt-6 w-full">
          <Link href={signInHref}>{t('auth.signIn.submit')}</Link>
        </Button>
      </AuthCard>
    );
  }

  const resendForm = (
    <Form
      form={form}
      onSubmit={async ({ email: address }) => {
        const r = await api.auth.resendVerification(address);
        setResent({ devToken: r.dev?.emailVerificationToken });
      }}
    >
      <FormField name="email" label={t('auth.email')} required hideLabel={state === 'pending' && !!email}>
        {(field) => <Input {...field} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder={t('auth.emailPlaceholder')} />}
      </FormField>
      <FormError />
      {resent ? (
        <Alert tone="success" live>
          {t('auth.verifyEmail.resent')}
        </Alert>
      ) : null}
      {resent?.devToken ? (
        <DevTokenHint>
          <AuthLink href={`${verifyPath}?token=${encodeURIComponent(resent.devToken)}`}>{t('auth.dev.verifyLink')}</AuthLink>
        </DevTokenHint>
      ) : null}
      <Button type="submit" variant="outline" className="w-full" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
        {t('auth.verifyEmail.resend')}
      </Button>
    </Form>
  );

  if (state === 'failed') {
    return (
      <AuthCard title={t('auth.verifyEmail.failedTitle')} subtitle={t('auth.verifyEmail.failed')} footer={<AuthLink href={signInHref}>{t('auth.forgot.backToSignIn')}</AuthLink>}>
        {resendForm}
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('auth.verifyEmail.pendingTitle')} footer={<AuthLink href={signInHref}>{t('auth.forgot.backToSignIn')}</AuthLink>}>
      <div className="mb-5 flex gap-3 text-base">
        <MailCheck className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" />
        <p role="status">{t('auth.verifyEmail.pending', { email: email ?? '' })}</p>
      </div>
      {devToken && !resent ? (
        <div className="mb-5">
          <DevTokenHint>
            <AuthLink href={`${verifyPath}?token=${encodeURIComponent(devToken)}`}>{t('auth.dev.verifyLink')}</AuthLink>
          </DevTokenHint>
        </div>
      ) : null}
      {resendForm}
    </AuthCard>
  );
}
