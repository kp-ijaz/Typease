'use client';

import type { PublicTenantConfig } from '@typease/types';
import { AppProviders, type Locale } from '@typease/ui';
import { APP, ROUTES } from '@/lib/config';
import { dictionaries } from '@/lib/dictionaries';

export function Providers({ apiBaseUrl, locale, tenantConfig, children }: { apiBaseUrl: string; locale: Locale; tenantConfig: PublicTenantConfig | null; children: React.ReactNode }) {
  return (
    <AppProviders app={APP} apiBaseUrl={apiBaseUrl} locale={locale} dictionaries={dictionaries} tenantConfig={tenantConfig} loginPath={ROUTES.login} homePath={ROUTES.dashboard}>
      {children}
    </AppProviders>
  );
}
