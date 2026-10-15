'use client';

import * as React from 'react';
import type { AppKey, PublicTenantConfig } from '@typease/types';
import type { QueryClient } from '@tanstack/react-query';
import { I18nProvider } from '../i18n/provider';
import type { Dictionaries, Locale } from '../i18n/core';
import { TooltipProvider } from '../components/menus';
import { Toaster } from '../components/toast';
import { AuthProvider } from './auth';
import { BrandingProvider } from './branding';
import { QueryProvider } from './query';
import { ThemeProvider } from './theme';

export interface AppProvidersProps {
  app: AppKey;
  /** From the app's config module. */
  apiBaseUrl: string;
  /** The locale the server rendered with (cookie / centre default / Accept-Language). */
  locale: Locale;
  /** Shared + app dictionaries: `mergeDictionaries(uiDictionaries, appDictionaries)`. */
  dictionaries: Dictionaries;
  /** The centre resolved on the server (portals, white-label domains); null for plain TypEase. */
  tenantConfig?: PublicTenantConfig | null;
  loginPath?: string;
  homePath?: string;
  queryClient?: QueryClient;
  children: React.ReactNode;
}

/**
 * The provider stack every TypEase app uses, in the order they depend on each other:
 * i18n -> theme -> data fetching -> branding -> session -> tooltips, plus the toast host.
 */
export function AppProviders({ app, apiBaseUrl, locale, dictionaries, tenantConfig = null, loginPath, homePath, queryClient, children }: AppProvidersProps) {
  // Marks the document once React has taken over, so browser tests and the
  // screenshot script know when the page reacts to input: `html[data-hydrated]`.
  React.useEffect(() => {
    document.documentElement.setAttribute('data-hydrated', 'true');
  }, []);
  return (
    <I18nProvider locale={locale} dictionaries={dictionaries} timeZone={tenantConfig?.timezone} currency={tenantConfig?.currency}>
      <ThemeProvider>
        <QueryProvider client={queryClient}>
          <BrandingProvider config={tenantConfig}>
            <AuthProvider app={app} apiBaseUrl={apiBaseUrl} loginPath={loginPath} homePath={homePath}>
              <TooltipProvider delayDuration={300} skipDelayDuration={200}>
                {children}
                <Toaster />
              </TooltipProvider>
            </AuthProvider>
          </BrandingProvider>
        </QueryProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
