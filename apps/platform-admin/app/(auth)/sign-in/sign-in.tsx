'use client';

import { RedirectIfAuthenticated, SignInFlow, useAfterSignIn, useT } from '@typease/ui';
import { ROUTES } from '@/lib/config';

/**
 * Maps the API's landing hint to this app's routes. Platform staff without
 * two-step verification are sent to set it up before anything else.
 */
export function mapLanding(landing: string): string {
  if (landing.startsWith('/settings/security')) return `${ROUTES.security}?setup=mfa`;
  return ROUTES.home;
}

export function SignIn() {
  const t = useT();
  const afterSignIn = useAfterSignIn({ mapLanding });
  return (
    <RedirectIfAuthenticated>
      {/* Email + password, then the two-step code (MFA_REQUIRED). No phone-code sign-in and no sign-up for staff. */}
      <SignInFlow onSignedIn={afterSignIn} forgotHref="/forgot-password" allowPhoneCode={false} footer={t('auth.staffOnly')} />
    </RedirectIfAuthenticated>
  );
}
