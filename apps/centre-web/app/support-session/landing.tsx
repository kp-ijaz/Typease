'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, LifeBuoy, RefreshCw } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { BrandLogo, Button, Card, Spinner, cn, useApi, useI18n, useSession } from '@typease/ui';

/**
 * Answers of POST /auth/support-session/exchange that have their own sentence (docs/api/modules/platform.md,
 * "Support session hand-off"). Everything else, a network failure included, is "failed" and may be retried
 * while the code is still inside its minute.
 */
const REFUSALS = {
  HANDOFF_INVALID: 'invalid',
  VALIDATION_FAILED: 'invalid',
  SUPPORT_ACCESS_ENDED: 'ended',
  ACCESS_NOT_APPROVED: 'ended',
  ACCOUNT_DISABLED: 'disabled',
  TENANT_UNAVAILABLE: 'unavailable',
  RATE_LIMITED: 'rateLimited',
} as const;
type Refusal = (typeof REFUSALS)[keyof typeof REFUSALS] | 'failed';

type Step =
  | { kind: 'reading' }
  | { kind: 'noCode' }
  /** Somebody is signed in to the staff app in this browser: the exchange would replace that sign-in. */
  | { kind: 'confirm' }
  | { kind: 'exchanging' }
  | { kind: 'refused'; reason: Refusal };

/** Only a path of this app is accepted as the place to go next. */
const safeLanding = (landing: unknown): string => (typeof landing === 'string' && /^\/(?!\/)/.test(landing) ? landing : '/');

export function SupportSessionLanding() {
  const { t, locale } = useI18n();
  const api = useApi();
  const router = useRouter();
  const session = useSession();
  const [step, setStep] = React.useState<Step>({ kind: 'reading' });
  // The one-time code lives in memory only: never in state that is rendered, never in a query string, never logged.
  const code = React.useRef<string | null>(null);
  const read = React.useRef(false);
  const started = React.useRef(false);
  const heading = React.useRef<HTMLHeadingElement>(null);

  const exchange = React.useCallback(async () => {
    const value = code.current;
    if (!value || started.current) return;
    started.current = true;
    setStep({ kind: 'exchanging' });
    try {
      // Installs the session like a sign-in (access token in memory, refresh cookie set by the API).
      const result = await api.auth.exchangeSupportSession(value);
      code.current = null;
      router.replace(safeLanding(result.landing));
    } catch (error) {
      const reason: Refusal = isApiError(error) ? ((REFUSALS as Record<string, Refusal>)[error.code] ?? 'failed') : 'failed';
      // The API uses a code up when it refuses it. Only an answer that never arrived leaves it usable.
      if (isApiError(error) && error.status > 0) code.current = null;
      started.current = false;
      setStep({ kind: 'refused', reason });
    }
  }, [api, router]);

  // 1. Take the code out of the address bar before anything else happens (history, screenshots, shoulder surfing).
  React.useEffect(() => {
    if (read.current) return;
    read.current = true;
    const hash = window.location.hash.replace(/^#/, '');
    const value = new URLSearchParams(hash).get('code');
    if (hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    code.current = value && value.length >= 20 ? value : null;
    // A fragment with something that cannot be a code (cut off when it was copied) is an invalid link, not a missing one.
    if (!code.current) setStep(value ? { kind: 'refused', reason: 'invalid' } : { kind: 'noCode' });
  }, []);

  // 2. Once it is known who is signed in here: exchange at once, or ask first when a staff sign-in would be replaced.
  const { isLoading, isAuthenticated, supportGrant } = session;
  React.useEffect(() => {
    if (step.kind !== 'reading' || !code.current || isLoading) return;
    if (isAuthenticated && !supportGrant) setStep({ kind: 'confirm' });
    else void exchange();
  }, [step.kind, isLoading, isAuthenticated, supportGrant, exchange]);

  React.useEffect(() => {
    if (step.kind !== 'reading' && step.kind !== 'exchanging') heading.current?.focus();
  }, [step.kind]);

  const busy = step.kind === 'reading' || step.kind === 'exchanging';
  const refused = step.kind === 'refused' ? step.reason : null;
  const signedInAs = session.user?.fullName ?? session.user?.email ?? '';
  const centre = session.tenant?.name ?? '';

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background p-6" data-slot="support-session-landing" data-step={step.kind}>
      {/* TypEase's own logo, also for a white-label centre: it is TypEase staff who arrive here. */}
      <BrandLogo config={null} size={36} locale={locale} />
      <Card className="w-full max-w-md p-6 text-center">
        <span
          aria-hidden="true"
          className={cn('mx-auto mb-4 flex size-12 items-center justify-center rounded-full', refused || step.kind === 'noCode' ? 'bg-warning-soft text-warning-text' : 'bg-secondary-soft text-secondary-text')}
        >
          {busy ? <Spinner /> : refused || step.kind === 'noCode' ? <AlertTriangle className="size-6" /> : <LifeBuoy className="size-6" />}
        </span>

        {busy ? (
          <div role="status">
            <h1 className="text-xl font-semibold">{t('adm.supportSession.exchangingTitle')}</h1>
            <p className="mt-2 text-base text-muted-foreground">{t('adm.supportSession.exchangingText')}</p>
          </div>
        ) : step.kind === 'confirm' ? (
          <>
            <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
              {t('adm.supportSession.confirmTitle')}
            </h1>
            <p className="mt-2 text-base text-muted-foreground">{centre ? t('adm.supportSession.confirmText', { name: signedInAs, centre }) : t('adm.supportSession.confirmTextNoCentre', { name: signedInAs })}</p>
            <p className="mt-3 text-sm text-muted-foreground">{t('adm.supportSession.confirmHint')}</p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={() => void exchange()}>
                <LifeBuoy aria-hidden="true" />
                {t('adm.supportSession.continue')}
              </Button>
              <Button asChild variant="outline">
                <Link href="/">{t('adm.supportSession.stay', { name: signedInAs })}</Link>
              </Button>
            </div>
          </>
        ) : (
          <div role="alert">
            <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
              {step.kind === 'noCode' ? t('adm.supportSession.noCodeTitle') : t(`adm.supportSession.refused.${refused}.title`)}
            </h1>
            <p className="mt-2 text-base text-muted-foreground">{step.kind === 'noCode' ? t('adm.supportSession.noCodeText') : t(`adm.supportSession.refused.${refused}.text`)}</p>
            <div className="mt-5 flex flex-col gap-2">
              {refused === 'failed' && code.current ? (
                <Button onClick={() => void exchange()}>
                  <RefreshCw aria-hidden="true" />
                  {t('common.retry')}
                </Button>
              ) : null}
              {/* Somebody who is signed in here anyway (staff, or a support session that is still running) can carry on. */}
              {isAuthenticated ? (
                <Button asChild variant="outline">
                  <Link href="/">{supportGrant ? t('adm.supportSession.backToSession') : t('adm.supportSession.backToApp')}</Link>
                </Button>
              ) : (
                <Button variant="outline" onClick={() => window.close()}>
                  {t('adm.supportSession.closeTab')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Card>
      <p className="max-w-md text-center text-sm text-muted-foreground">{t('adm.supportSession.footnote')}</p>
    </main>
  );
}
