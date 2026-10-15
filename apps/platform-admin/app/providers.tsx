'use client';

import { AppProviders, type Locale } from '@typease/ui';
import { APP, ROUTES } from '@/lib/config';
import { dictionaries } from '@/lib/dictionaries';

/** The provider stack of the platform console. No centre: always TypEase-branded. */
export function Providers({ apiBaseUrl, locale, children }: { apiBaseUrl: string; locale: Locale; children: React.ReactNode }) {
  return (
    <AppProviders app={APP} apiBaseUrl={apiBaseUrl} locale={locale} dictionaries={dictionaries} tenantConfig={null} loginPath={ROUTES.signIn} homePath={ROUTES.home}>
      {children}
    </AppProviders>
  );
}
