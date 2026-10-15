'use client';

import * as React from 'react';
import { ArrowLeft, Building2, ChevronRight, Smartphone } from 'lucide-react';
import type { AuthMembership, LoginResult } from '@typease/types';
import { loginSchema, otpRequestSchema } from '@typease/validation';
import { isApiError, type LoginOk } from '@typease/api-client';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { useApi, useSession } from '../providers/auth';
import { useBranding } from '../providers/branding';
import { describeError } from '../lib/errors';
import { Alert } from '../components/alert';
import { Button } from '../components/button';
import { PasswordInput, PhoneInput } from '../components/fields';
import { Form, FormActions, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { Label } from '../components/label';
import { AuthCard, AuthLink, CodeInput, DevTokenHint } from './layout';

const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD;

/** The `?demo=` account to sign in as, when this build is a demo (the password is set) and it is a seeded `.test` account. */
export function demoLoginEmail(): string | null {
  if (!DEMO_PASSWORD || typeof window === 'undefined') return null;
  const email = new URLSearchParams(window.location.search).get('demo')?.trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.test$/.test(email) ? email : null;
}

const passwordStep = loginSchema.pick({ email: true, password: true });
const phoneStep = otpRequestSchema.pick({ phone: true });

type Step =
  | { name: 'password' }
  | { name: 'otp-request' }
  | { name: 'otp-verify'; phone: string; devCode?: string }
  | { name: 'mfa'; challengeToken: string }
  | { name: 'select-tenant'; selectionToken: string; memberships: AuthMembership[] };

export interface SignInFlowProps {
  /** The centre being signed in to (portals). Omit on tenant domains and in the staff app: the API resolves it. */
  tenantSlug?: string;
  /** Called after the session is stored. Navigate from here (see `useAfterSignIn`). */
  onSignedIn: (result: LoginOk) => void;
  forgotHref: string;
  /** Offer "sign in with a code sent to your phone". */
  allowPhoneCode?: boolean;
  /** Name shown in the subtitle ("Sign in to Al Noor Typing Centre."). */
  centreName?: string;
  /** Links under the form: create account, register a centre. */
  footer?: React.ReactNode;
  /** Prefill (after registration or email verification). */
  defaultEmail?: string;
}

/**
 * The whole sign-in conversation as one component:
 * email + password -> (two-step code) -> (choose a centre) -> signed in,
 * with the alternative "code sent to your phone" route.
 * It reacts to the three answers of POST /auth/login: OK, MFA_REQUIRED, SELECT_TENANT.
 */
export function SignInFlow({ tenantSlug, onSignedIn, forgotHref, allowPhoneCode = true, centreName, footer, defaultEmail }: SignInFlowProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApi();
  const session = useSession();
  const [step, setStep] = React.useState<Step>({ name: 'password' });
  const [unverifiedEmail, setUnverifiedEmail] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [devVerifyToken, setDevVerifyToken] = React.useState<string | null>(null);

  const handle = (result: LoginResult) => {
    if (result.status === 'OK') {
      session.acceptLogin(result);
      onSignedIn(result);
    } else if (result.status === 'MFA_REQUIRED') setStep({ name: 'mfa', challengeToken: result.challengeToken });
    else setStep({ name: 'select-tenant', selectionToken: result.selectionToken, memberships: result.memberships });
  };
  const restart = () => {
    setStep({ name: 'password' });
    setNotice(null);
  };

  // ---- email + password
  const passwordForm = useZodForm(passwordStep, { defaultValues: { email: defaultEmail ?? '', password: '' } });
  const formId = React.useId();
  // Demo sites only: `?demo=<email>` (from the landing page) signs straight in with the shared demo password.
  React.useEffect(() => {
    const email = demoLoginEmail();
    if (!email) return;
    passwordForm.setValue('email', email);
    passwordForm.setValue('password', DEMO_PASSWORD!);
    (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit();
  }, [formId, passwordForm]);
  const submitPassword = async (values: { email: string; password: string }) => {
    setUnverifiedEmail(null);
    setNotice(null);
    try {
      handle(await api.auth.login({ ...values, tenantSlug }));
    } catch (error) {
      // Never keep a wrong password in the field; the email stays.
      passwordForm.resetField('password');
      if (isApiError(error) && error.code === 'EMAIL_NOT_VERIFIED') {
        // One message, with the way out next to it (not the form's general error as well).
        setUnverifiedEmail(values.email);
        return;
      }
      throw error;
    }
  };
  const [resending, setResending] = React.useState(false);
  const resend = async () => {
    if (!unverifiedEmail) return;
    setResending(true);
    try {
      const r = await api.auth.resendVerification(unverifiedEmail);
      setDevVerifyToken(r.dev?.emailVerificationToken ?? null);
      setNotice(t('auth.signIn.resent'));
      setUnverifiedEmail(null);
      passwordForm.clearErrors();
    } catch (error) {
      setNotice(describeError(error, i18n));
    } finally {
      setResending(false);
    }
  };

  // ---- phone code
  const phoneForm = useZodForm(phoneStep, { defaultValues: { phone: '' } });
  const requestCode = async (phone: string) => {
    const r = await api.auth.requestOtp({ phone, tenantSlug });
    setStep({ name: 'otp-verify', phone, devCode: r.dev?.otp });
  };

  if (step.name === 'mfa') return <MfaChallenge challengeToken={step.challengeToken} onResult={handle} onRestart={restart} />;
  if (step.name === 'select-tenant') return <TenantPicker selectionToken={step.selectionToken} memberships={step.memberships} onResult={handle} onRestart={restart} />;

  if (step.name === 'otp-request') {
    return (
      <AuthCard title={t('auth.otp.title')} subtitle={t('auth.otp.subtitle')}>
        <Form form={phoneForm} onSubmit={(v) => requestCode(v.phone)}>
          <FormField name="phone" label={t('auth.phone')} required>
            {(field) => <PhoneInput {...field} autoFocus />}
          </FormField>
          <FormError />
          <FormActions className="sm:flex-col-reverse">
            <Button variant="ghost" onClick={restart}>
              <ArrowLeft className="rtl-mirror" aria-hidden="true" />
              {t('auth.signIn.withPassword')}
            </Button>
            <Button type="submit" size="lg" loading={phoneForm.formState.isSubmitting} loadingText={t('auth.otp.sending')}>
              {t('auth.otp.send')}
            </Button>
          </FormActions>
        </Form>
      </AuthCard>
    );
  }
  if (step.name === 'otp-verify') {
    return (
      <OtpVerify
        phone={step.phone}
        devCode={step.devCode}
        tenantSlug={tenantSlug}
        onResult={handle}
        onResend={() => requestCode(step.phone)}
        onChangeNumber={() => setStep({ name: 'otp-request' })}
      />
    );
  }

  return (
    <AuthCard title={t('auth.signIn.title')} subtitle={centreName ? t('auth.signIn.subtitleTo', { name: centreName }) : t('auth.signIn.subtitle')} footer={footer}>
      <Form form={passwordForm} onSubmit={submitPassword} id={formId}>
        <FormField name="email" label={t('auth.email')} required>
          {(field) => <Input {...field} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder={t('auth.emailPlaceholder')} autoFocus />}
        </FormField>
        <div className="space-y-1.5">
          <FormField name="password" label={t('auth.password')} required>
            {(field) => <PasswordInput {...field} autoComplete="current-password" dir="ltr" />}
          </FormField>
          <div className="text-end">
            <AuthLink href={forgotHref} className="text-sm">
              {t('auth.signIn.forgot')}
            </AuthLink>
          </div>
        </div>
        <FormError />
        {unverifiedEmail ? (
          <Alert
            tone="warning"
            live
            title={t('auth.signIn.needVerificationTitle')}
            action={
              <Button size="sm" variant="outline" loading={resending} onClick={() => void resend()}>
                {t('auth.signIn.resend')}
              </Button>
            }
          >
            {t('auth.signIn.needVerification')}
          </Alert>
        ) : null}
        {notice ? (
          <Alert tone="info" live>
            {notice}
          </Alert>
        ) : null}
        {devVerifyToken ? (
          <DevTokenHint>
            <AuthLink href={`/verify-email?token=${encodeURIComponent(devVerifyToken)}`}>{t('auth.dev.verifyLink')}</AuthLink>
          </DevTokenHint>
        ) : null}
        <Button type="submit" size="lg" className="w-full" loading={passwordForm.formState.isSubmitting} loadingText={t('auth.signIn.submitting')}>
          {t('auth.signIn.submit')}
        </Button>
        {allowPhoneCode ? (
          <Button variant="ghost" className="w-full text-muted-foreground" onClick={() => setStep({ name: 'otp-request' })}>
            <Smartphone aria-hidden="true" />
            {t('auth.signIn.withPhone')}
          </Button>
        ) : null}
      </Form>
    </AuthCard>
  );
}

function OtpVerify({ phone, devCode, tenantSlug, onResult, onResend, onChangeNumber }: {
  phone: string;
  devCode?: string;
  tenantSlug?: string;
  onResult: (result: LoginResult) => void;
  onResend: () => Promise<void>;
  onChangeNumber: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApi();
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return setError(t('validation.otp'));
    setBusy(true);
    setError(null);
    try {
      onResult(await api.auth.verifyOtp({ phone, code, tenantSlug }));
    } catch (err) {
      setError(describeError(err, i18n));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t('auth.otp.title')} subtitle={t('auth.otp.sent')}>
      <form onSubmit={submit} noValidate className="space-y-5">
        <p className="ltr-value text-md font-semibold text-foreground">{phone}</p>
        <div className="space-y-1.5">
          <Label htmlFor={id}>{t('auth.otp.code')}</Label>
          <CodeInput id={id} value={code} onChange={setCode} autoFocus aria-invalid={!!error} aria-describedby={error ? `${id}-e` : undefined} />
          {error ? (
            <p id={`${id}-e`} role="alert" className="text-sm text-destructive-text">
              {error}
            </p>
          ) : null}
        </div>
        {devCode ? <DevTokenHint>{t('auth.dev.otp', { code: devCode })}</DevTokenHint> : null}
        <Button type="submit" size="lg" className="w-full" loading={busy} loadingText={t('auth.signIn.submitting')}>
          {t('auth.otp.verify')}
        </Button>
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="link" onClick={() => void onResend().catch((err) => setError(describeError(err, i18n)))}>
            {t('auth.otp.resend')}
          </Button>
          <Button variant="link" onClick={onChangeNumber}>
            {t('auth.otp.changeNumber')}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}

/** Second step of sign-in: a code from the authenticator app, or one of the recovery codes. */
export function MfaChallenge({ challengeToken, onResult, onRestart }: { challengeToken: string; onResult: (result: LoginResult) => void; onRestart: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApi();
  const { brandName } = useBranding();
  const [mode, setMode] = React.useState<'app' | 'recovery'>('app');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (mode === 'app' ? value.length !== 6 : value.length < 6) return setError(t('validation.otp'));
    setBusy(true);
    setError(null);
    try {
      onResult(await api.auth.verifyMfa({ challengeToken, code: value }));
    } catch (err) {
      if (isApiError(err) && (err.code === 'MFA_CHALLENGE_EXPIRED' || err.code === 'RATE_LIMITED')) setExpired(true);
      setError(describeError(err, i18n));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t('auth.mfa.title')} subtitle={mode === 'app' ? t('auth.mfa.subtitle', { brand: brandName }) : t('auth.mfa.recoveryHint')}>
      <form onSubmit={submit} noValidate className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor={id}>{mode === 'app' ? t('auth.mfa.code') : t('auth.mfa.recoveryCode')}</Label>
          {mode === 'app' ? (
            <CodeInput id={id} value={code} onChange={setCode} autoFocus aria-invalid={!!error} aria-describedby={`${id}-h`} disabled={expired} />
          ) : (
            <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" spellCheck={false} dir="ltr" className="font-mono" aria-invalid={!!error} aria-describedby={`${id}-h`} disabled={expired} />
          )}
          {error ? (
            <p id={`${id}-h`} role="alert" className="text-sm text-destructive-text">
              {error}
            </p>
          ) : (
            <p id={`${id}-h`} className="text-sm text-muted-foreground">
              {mode === 'app' ? t('auth.mfa.codeHint') : t('auth.mfa.recoveryHint')}
            </p>
          )}
        </div>
        {expired ? (
          <Button size="lg" className="w-full" onClick={onRestart}>
            {t('auth.mfa.startAgain')}
          </Button>
        ) : (
          <Button type="submit" size="lg" className="w-full" loading={busy} loadingText={t('auth.signIn.submitting')}>
            {t('auth.mfa.submit')}
          </Button>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="link"
            onClick={() => {
              setMode(mode === 'app' ? 'recovery' : 'app');
              setCode('');
              setError(null);
            }}
          >
            {mode === 'app' ? t('auth.mfa.useRecovery') : t('auth.mfa.useAuthenticator')}
          </Button>
          <Button variant="link" onClick={onRestart}>
            {t('auth.forgot.backToSignIn')}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}

/** Shown when the API answers SELECT_TENANT: the person belongs to several centres. */
export function TenantPicker({ selectionToken, memberships, onResult, onRestart }: {
  selectionToken: string;
  memberships: AuthMembership[];
  onResult: (result: LoginResult) => void;
  onRestart: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApi();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const choose = async (membershipId: string) => {
    setBusy(membershipId);
    setError(null);
    try {
      onResult(await api.auth.selectTenant({ selectionToken, membershipId }));
    } catch (err) {
      setError(describeError(err, i18n));
      setBusy(null);
    }
  };
  return (
    <AuthCard title={t('auth.selectTenant.title')} subtitle={t('auth.selectTenant.subtitle')}>
      <ul className="space-y-2">
        {memberships.map((m) => (
          <li key={m.membershipId}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void choose(m.membershipId)}
              aria-label={t('auth.selectTenant.continue', { name: m.tenantName })}
              className={cn('flex w-full items-center gap-3 rounded-lg border bg-card p-3.5 text-start transition-colors hover:border-secondary hover:bg-secondary-soft/50 disabled:opacity-60', focusRing)}
            >
              <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
                <Building2 className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-md font-semibold text-foreground">{m.tenantName}</span>
                <span className="block truncate text-sm text-muted-foreground">{t('auth.selectTenant.role', { role: m.roleName })}</span>
              </span>
              <ChevronRight className="rtl-mirror size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <Alert tone="danger" live className="mt-4">
          {error}
        </Alert>
      ) : null}
      <Button variant="link" className="mt-5" onClick={onRestart}>
        {t('auth.forgot.backToSignIn')}
      </Button>
    </AuthCard>
  );
}
