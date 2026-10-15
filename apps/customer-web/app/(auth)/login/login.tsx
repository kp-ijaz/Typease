'use client';

import { AuthLink, RedirectIfAuthenticated, SignInFlow, useAfterSignIn, useBranding, useT } from '@typease/ui';
import { ROUTES } from '@/lib/config';

export function Login({ defaultEmail }: { defaultEmail?: string }) {
  const t = useT();
  const { config, name } = useBranding();
  // The API's landing hint for customers is always the dashboard.
  const afterSignIn = useAfterSignIn({ mapLanding: () => ROUTES.dashboard });
  const canRegister = config?.features.selfRegistration !== false;
  return (
    <RedirectIfAuthenticated>
      <SignInFlow
        tenantSlug={config?.slug}
        centreName={name}
        defaultEmail={defaultEmail}
        onSignedIn={afterSignIn}
        forgotHref="/forgot-password"
        footer={
          canRegister ? (
            <>
              {t('auth.noAccount')} <AuthLink href={ROUTES.register}>{t('auth.createAccount')}</AuthLink>
            </>
          ) : (
            t('auth.registrationClosed')
          )
        }
      />
    </RedirectIfAuthenticated>
  );
}
