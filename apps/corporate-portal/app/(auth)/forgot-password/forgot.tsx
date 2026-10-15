'use client';

import { ForgotPasswordForm, useBranding } from '@typease/ui';

export function ForgotPassword() {
  const { config } = useBranding();
  return <ForgotPasswordForm signInHref="/sign-in" tenantSlug={config?.slug} />;
}
