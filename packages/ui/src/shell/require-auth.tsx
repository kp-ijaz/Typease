'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, ShieldAlert } from 'lucide-react';
import { useI18n } from '../i18n/provider';
import { safeNextPath } from '../lib/errors';
import { useSession } from '../providers/auth';
import { useBranding } from '../providers/branding';
import { BrandLogo } from '../providers/brand-style';
import { demoLoginEmail } from '../auth/sign-in';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { LoadingBlock } from '../components/spinner';
import { SupportSessionEnded } from './support-session';

export interface RequireAuthProps {
  /** Membership kinds that may use this app ("STAFF" for the staff app, "CUSTOMER" / "CORPORATE" for the portals). */
  kinds?: ReadonlyArray<'STAFF' | 'CUSTOMER' | 'CORPORATE'>;
  /** The platform console: requires a platform role instead of a centre membership. */
  platform?: boolean;
  /** Where people whose role requires two-step verification are sent until they have set it up. */
  mfaSetupPath?: string;
  children: React.ReactNode;
}

function FullScreen({ children }: { children: React.ReactNode }) {
  const { config } = useBranding();
  const { locale } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-background p-6">
      <BrandLogo config={config} size={36} locale={locale} />
      {children}
    </div>
  );
}

/**
 * Wraps the signed-in part of an app.
 *  - still checking: a calm full-screen loader (no flash of the login page);
 *  - signed out: go to the login page and remember the page that was asked for (`?next=`);
 *  - session ended while working: say so clearly and offer to sign in again, back to the same page;
 *  - wrong kind of account for this app: explain, offer to sign out;
 *  - two-step verification required by the role but not set up: go to the setup page.
 */
export function RequireAuth({ kinds, platform, mfaSetupPath, children }: RequireAuthProps) {
  const session = useSession();
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  const loginUrl = React.useCallback(() => {
    const current = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : pathname;
    const next = current && current !== '/' && !current.startsWith(session.loginPath) ? `?next=${encodeURIComponent(current)}` : '';
    return `${session.loginPath}${next}`;
  }, [pathname, session.loginPath]);

  const needsMfaSetup = session.isAuthenticated && !!session.session?.mfaRequiredSetup && !!mfaSetupPath && pathname !== mfaSetupPath;

  // A TypEase support session that is over (expired, revoked, ended by the agent): there is nothing to sign in to.
  const supportEnded = session.endedSupportGrant;

  React.useEffect(() => {
    if (supportEnded) return;
    if (session.status === 'anonymous') router.replace(loginUrl());
    else if (needsMfaSetup && mfaSetupPath) router.replace(mfaSetupPath);
  }, [session.status, supportEnded, needsMfaSetup, mfaSetupPath, router, loginUrl]);

  if (supportEnded && !session.isAuthenticated) return <SupportSessionEnded grant={supportEnded} />;

  if (session.status === 'loading' || session.status === 'anonymous' || needsMfaSetup) {
    return (
      <FullScreen>
        <LoadingBlock label={t('session.checking')} className="min-h-0" />
      </FullScreen>
    );
  }

  if (session.status === 'expired') {
    return (
      <FullScreen>
        <Card role="alert" className="w-full max-w-md p-6 text-center">
          <h1 className="text-xl font-semibold">{t('session.expiredTitle')}</h1>
          <p className="mt-2 text-base text-muted-foreground">{session.endedReason === 'SIGNED_OUT_ELSEWHERE' ? t('session.signedOutElsewhere') : t('session.expiredDescription')}</p>
          <Button className="mt-5 w-full" onClick={() => router.replace(loginUrl())} autoFocus>
            {t('session.signInAgain')}
          </Button>
        </Card>
      </FullScreen>
    );
  }

  const kind = session.membership?.kind;
  // A support session has no membership: TypEase staff are inside a centre under an access grant, whatever
  // kinds of account the app is for. (Not in the platform console, which has no centre.)
  const allowed = platform ? !!session.user?.platformRole && !session.tenant : !!session.supportGrant || !kinds || (!!kind && kinds.includes(kind));
  if (!allowed) {
    return (
      <FullScreen>
        <Card className="w-full max-w-md p-6 text-center">
          <span aria-hidden="true" className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning-text">
            <ShieldAlert className="size-6" />
          </span>
          <h1 className="text-xl font-semibold">{t('session.wrongAppTitle')}</h1>
          <p className="mt-2 text-base text-muted-foreground">{t('session.wrongAppDescription')}</p>
          <Button variant="outline" className="mt-5 w-full" onClick={() => void session.signOut().then(() => router.replace(session.loginPath))}>
            <LogOut aria-hidden="true" />
            {t('shell.signOut')}
          </Button>
        </Card>
      </FullScreen>
    );
  }

  return <>{children}</>;
}

/**
 * For login pages. Someone who arrives already signed in (the silent refresh on
 * load succeeded) is sent on to the page they asked for (`?next=`) or the app's
 * home instead of seeing the form. While that check runs a loader is shown, so
 * the form never flashes. A sign-in that happens ON this page is not redirected
 * here: the form's own `onSignedIn` decides where to go.
 */
export function RedirectIfAuthenticated({ to, children }: { to?: string; children: React.ReactNode }) {
  const session = useSession();
  const { t } = useI18n();
  const router = useRouter();
  /** "arrived signed in" | "arrived signed out" | not known yet */
  const [arrival, setArrival] = React.useState<'in' | 'out' | null>(null);
  const { signOut } = session;

  React.useEffect(() => {
    if (arrival !== null || session.status === 'loading') return;
    if (session.status === 'authenticated' && demoLoginEmail()) {
      // A demo login for another role: leave the current session first.
      void signOut().finally(() => setArrival('out'));
    } else if (session.status === 'authenticated') {
      setArrival('in');
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(safeNextPath(next, to ?? session.homePath));
    } else setArrival('out');
  }, [arrival, session.status, session.homePath, to, router, signOut]);

  if (arrival !== 'out') return <LoadingBlock label={t('session.checking')} className="min-h-64" />;
  return <>{children}</>;
}

/** A page-level permission check inside the shell: shows a friendly "no access" card instead of a failing page. */
export function RequirePermission({ anyOf, children }: { anyOf: readonly string[]; children: React.ReactNode }) {
  const session = useSession();
  const { t } = useI18n();
  if (session.hasAnyPermission(anyOf)) return <>{children}</>;
  return (
    <Card className="mx-auto mt-10 max-w-md p-6 text-center">
      <span aria-hidden="true" className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ShieldAlert className="size-6" />
      </span>
      <h1 className="text-xl font-semibold">{t('session.noPermissionTitle')}</h1>
      <p className="mt-2 text-base text-muted-foreground">{t('session.noPermissionDescription')}</p>
    </Card>
  );
}
