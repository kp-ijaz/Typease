'use client';

import { useRouter } from 'next/navigation';
import { Alert, AuthCard, AuthLink, RegisterCustomerForm, useBranding, useT } from '@typease/ui';
import { ROUTES } from '@/lib/config';

export function Register() {
  const t = useT();
  const router = useRouter();
  const { config, name } = useBranding();
  if (config?.features.selfRegistration === false) {
    return (
      <AuthCard title={t('auth.register.title')} footer={<AuthLink href={ROUTES.login}>{t('auth.forgot.backToSignIn')}</AuthLink>}>
        <Alert tone="info">{t('auth.registrationClosed')}</Alert>
      </AuthCard>
    );
  }
  return (
    <RegisterCustomerForm
      tenantSlug={config?.slug}
      centreName={name}
      termsHref={ROUTES.terms}
      privacyHref={ROUTES.privacy}
      signInHref={ROUTES.login}
      // What happens next is said on the next screen: "we sent you a link".
      onRegistered={({ email, devToken }) => router.push(`/verify-email?email=${encodeURIComponent(email)}${devToken ? `&dev=${encodeURIComponent(devToken)}` : ''}`)}
    />
  );
}
