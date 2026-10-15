'use client';

import { AuthLink, RedirectIfAuthenticated, SignInFlow, useAfterSignIn, useT } from '@typease/ui';
import { ROUTES } from '@/lib/config';

/** Maps the API's landing hint to this app's routes. */
export function mapLanding(landing: string): string {
  if (landing.startsWith('/settings/security')) return `${ROUTES.security}?setup=mfa`;
  if (landing === '/onboarding') return ROUTES.onboarding;
  return ROUTES.home;
}

export function SignIn() {
  const t = useT();
  const afterSignIn = useAfterSignIn({ mapLanding });
  return (
    <RedirectIfAuthenticated>
      <SignInFlow
        onSignedIn={afterSignIn}
        forgotHref="/forgot-password"
        footer={
          <>
            {t('auth.newCentre')} <AuthLink href="/sign-up">{t('auth.signupLink')}</AuthLink>
          </>
        }
      />
    </RedirectIfAuthenticated>
  );
}
