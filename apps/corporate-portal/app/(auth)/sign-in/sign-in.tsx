'use client';

import { RedirectIfAuthenticated, SignInFlow, useAfterSignIn, useBranding, useT } from '@typease/ui';
import { ROUTES } from '@/lib/config';

/** Maps the API's landing hint to this portal's routes. */
export function mapLanding(landing: string): string {
  if (landing.startsWith('/settings/security')) return `${ROUTES.security}?setup=mfa`;
  return ROUTES.home;
}

export function SignIn({ defaultEmail }: { defaultEmail?: string }) {
  const t = useT();
  const { config, name } = useBranding();
  const afterSignIn = useAfterSignIn({ mapLanding });
  return (
    <RedirectIfAuthenticated>
      <SignInFlow
        tenantSlug={config?.slug}
        centreName={name}
        defaultEmail={defaultEmail}
        onSignedIn={afterSignIn}
        forgotHref="/forgot-password"
        // Company users are invited by the centre; there is no self sign-up and no phone-code sign-in.
        allowPhoneCode={false}
        footer={
          <>
            {t('auth.noAccount')} {t('auth.askCentre', { centre: name })}
          </>
        }
      />
    </RedirectIfAuthenticated>
  );
}
