'use client';

import type { PublicTenantConfig } from '@typease/types';
import { AppProviders, type Locale } from '@typease/ui';
import { APP, ROUTES } from '@/lib/config';
import { dictionaries } from '@/lib/dictionaries';

/** The provider stack of the staff app. `apiBaseUrl`, `locale` and the centre come from the server (root layout). */
export function Providers({ apiBaseUrl, locale, tenantConfig, children }: { apiBaseUrl: string; locale: Locale; tenantConfig: PublicTenantConfig | null; children: React.ReactNode }) {
  return (
    <AppProviders app={APP} apiBaseUrl={apiBaseUrl} locale={locale} dictionaries={dictionaries} tenantConfig={tenantConfig} loginPath={ROUTES.signIn} homePath={ROUTES.home}>
      {children}
    </AppProviders>
  );
}
