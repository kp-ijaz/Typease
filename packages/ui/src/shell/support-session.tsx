'use client';

import * as React from 'react';
import { Check, Eye, LifeBuoy, LogOut, Pencil } from 'lucide-react';
import type { SupportGrant } from '@typease/types';
import { TENANT_PERMISSIONS } from '@typease/permissions';
import { cn } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { useSession } from '../providers/auth';
import { useBranding } from '../providers/branding';
import { BrandLogo } from '../providers/brand-style';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { Popover, PopoverContent, PopoverTrigger } from '../components/menus';

/** How long after the grant's end (by this device's clock) an unreachable server is still given the benefit of the doubt. */
const OFFLINE_GRACE_MS = 2 * 60_000;
/** How often the server is asked again once this device's clock says the grant is over. */
const RECHECK_MS = 20_000;

/** "29:41", "1:02:07". Always Latin digits: this is a clock. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export interface SupportSessionClock {
  grant: SupportGrant | null;
  /** Milliseconds until `expiresAt` by this device's clock; never negative. null without a support session. */
  remainingMs: number | null;
  /** This device's clock says the grant is over and the server has not said otherwise yet. */
  checking: boolean;
  /** Over for certain as far as this tab can tell: the server could not be reached for two minutes after the end. */
  ended: boolean;
}

/**
 * The clock of a support session. The server decides when a session is over (its next answer is
 * 401 SUPPORT_ACCESS_ENDED, which ends the session in the session manager); this hook only makes sure
 * the question is asked the moment the grant should have run out, and copes with a clock that is fast.
 */
export function useSupportSessionClock(): SupportSessionClock {
  const session = useSession();
  const grant = session.supportGrant;
  const expiresAt = grant ? Date.parse(grant.expiresAt) : null;
  const [now, setNow] = React.useState(() => Date.now());
  /** The server confirmed the session after our clock said it was over: our clock is fast. */
  const [confirmedAt, setConfirmedAt] = React.useState<number | null>(null);
  const [ended, setEnded] = React.useState(false);

  React.useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  React.useEffect(() => {
    setConfirmedAt(null);
    setEnded(false);
  }, [grant?.id, expiresAt]);

  const overdue = expiresAt !== null && now >= expiresAt;
  const { reload, signOut } = session;
  React.useEffect(() => {
    if (!overdue || expiresAt === null) return;
    let cancelled = false;
    const ask = () => {
      // 401 here ends the session in the manager (and <RequireAuth> shows the "ended" page).
      reload()
        .then((info) => {
          if (!cancelled && info?.supportGrant) setConfirmedAt(Date.now());
        })
        .catch(() => {
          if (cancelled || Date.now() - expiresAt <= OFFLINE_GRACE_MS) return;
          // Still no answer two minutes after the end: close the session on this device as well
          // (the manager remembers it was a support session, so the "ended" page follows).
          setEnded(true);
          void signOut();
        });
    };
    ask();
    const timer = setInterval(ask, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [overdue, expiresAt, reload, signOut]);

  return {
    grant,
    remainingMs: expiresAt === null ? null : Math.max(0, expiresAt - now),
    checking: overdue && confirmedAt === null && !ended,
    ended,
  };
}

/**
 * The bar of a TypEase support session: who is looking, at which centre, how far the access goes and
 * until when. It is permanent (no way to dismiss it) and renders nothing outside a support session, so
 * `<AppShell>` shows it by itself; an app with its own frame renders `<SupportSessionBanner />` at the top.
 *
 * "TypEase" is meant literally here, also in a white-label app: it is TypEase staff who are inside.
 */
export function SupportSessionBanner({ className }: { className?: string }) {
  const { t, tn, formatTime, formatDateTime } = useI18n();
  const session = useSession();
  const { grant, remainingMs, checking } = useSupportSessionClock();
  const [ending, setEnding] = React.useState(false);
  if (!grant || remainingMs === null) return null;

  const expires = new Date(grant.expiresAt);
  const sameDay = Math.abs(expires.getTime() - Date.now()) < 20 * 3600_000;
  const until = sameDay ? formatTime(grant.expiresAt) : formatDateTime(grant.expiresAt);
  const minutes = Math.ceil(remainingMs / 60_000);
  const soon = remainingMs <= 5 * 60_000;
  const end = async () => {
    setEnding(true);
    // The session manager remembers that this was a support session: <RequireAuth> then shows the "ended" page.
    await session.signOut();
  };

  return (
    <aside
      role="region"
      aria-label={t('supportSession.label')}
      data-slot="support-session-banner"
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-black/10 bg-warning px-3 py-2 text-sm text-warning-foreground sm:px-5', className)}
    >
      <LifeBuoy className="size-5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-56 font-semibold leading-5">{t(grant.readOnly ? 'supportSession.readOnly' : 'supportSession.readWrite', { centre: grant.tenantName, time: until })}</p>
      <p className={cn('tabular shrink-0 rounded-md bg-black/10 px-2 py-0.5 font-semibold', soon && 'bg-black/25')} data-slot="support-session-countdown">
        {checking ? t('supportSession.checking') : t('supportSession.timeLeft', { time: formatCountdown(remainingMs) })}
      </p>
      {/* Said aloud only at five minutes and at one minute, not every second. */}
      <span className="sr-only" role="status" aria-live="polite">
        {!checking && (minutes === 5 || minutes === 1) ? tn('supportSession.minutesLeft', minutes) : ''}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="border-black/25 bg-transparent text-warning-foreground hover:bg-black/10 hover:text-warning-foreground">
              {t('supportSession.scopes')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))]">
            <SupportScopes grant={grant} />
          </PopoverContent>
        </Popover>
        <Button size="sm" variant="default" loading={ending} loadingText={t('supportSession.ending')} onClick={() => void end()}>
          <LogOut aria-hidden="true" />
          {t('supportSession.end')}
        </Button>
      </div>
    </aside>
  );
}

/** The scopes of a grant in words (the permission's description), each marked "view only" or "can change". */
export function SupportScopes({ grant }: { grant: SupportGrant }) {
  const { t } = useI18n();
  const write = new Set(grant.writeScopes);
  const describe = (scope: string) => (TENANT_PERMISSIONS as Record<string, { description: string } | undefined>)[scope]?.description;
  return (
    <div className="space-y-3 text-base">
      <div>
        <p className="font-semibold text-foreground">{t('supportSession.scopesTitle')}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('supportSession.scopesText')}</p>
      </div>
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {grant.scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-2.5">
            <span aria-hidden="true" className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', write.has(scope) ? 'bg-warning-soft text-warning-text' : 'bg-muted text-muted-foreground')}>
              {write.has(scope) ? <Pencil className="size-3" /> : <Eye className="size-3" />}
            </span>
            <span className="min-w-0 flex-1">
              {/* Permission descriptions exist in English only: isolate them so their punctuation stays put in Arabic. */}
              <bdi className="block text-sm text-foreground">{describe(scope) ?? scope}</bdi>
              <span className="block text-xs text-muted-foreground">
                <span className="ltr-value font-mono">{scope}</span>
                <span aria-hidden="true"> – </span>
                {write.has(scope) ? t('supportSession.canChange') : t('supportSession.viewOnly')}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {grant.reason ? (
        <div className="border-t pt-3">
          <p className="text-sm text-muted-foreground">{t('supportSession.reason')}</p>
          <p className="mt-0.5 text-sm text-foreground">
            <bdi>{grant.reason}</bdi>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Full page shown when a support session is over (the time ran out, the centre revoked the grant, or the
 * agent ended it). There is nothing to sign in to in this app: the way back is the platform console.
 */
export function SupportSessionEnded({ grant }: { grant?: SupportGrant | null }) {
  const { t, locale } = useI18n();
  const { config } = useBranding();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background p-6" data-slot="support-session-ended">
      <BrandLogo config={config} size={36} locale={locale} />
      <Card role="alert" className="w-full max-w-md p-6 text-center">
        <span aria-hidden="true" className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Check className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">{t('supportSession.endedTitle')}</h1>
        <p className="mt-2 text-base text-muted-foreground">{grant?.tenantName ? t('supportSession.endedText', { centre: grant.tenantName }) : t('supportSession.endedTextNoCentre')}</p>
        <p className="mt-3 text-sm text-muted-foreground">{t('supportSession.endedHint')}</p>
        {/* Works when the console opened this tab; otherwise the browser ignores it and the text above still holds. */}
        <Button variant="outline" className="mt-5 w-full" onClick={() => window.close()}>
          {t('supportSession.closeTab')}
        </Button>
      </Card>
    </div>
  );
}
