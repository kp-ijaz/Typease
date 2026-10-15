'use client';

import { ForgotPasswordForm, useBranding } from '@typease/ui';

export function ForgotPassword() {
  const { config } = useBranding();
  return <ForgotPasswordForm signInHref="/login" tenantSlug={config?.slug} />;
}
