import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import './globals.css';
import { BrandStyle, ThemeScript, dirOf, translate } from '@typease/ui/server';
import { CentreNotFound } from '@/components/centre-not-found';
import { dictionaries } from '@/lib/dictionaries';
import { faviconFor } from '@/lib/favicon';
import { getPortalRequest } from '@/lib/tenant';
import { Providers } from './providers';

export async function generateMetadata(): Promise<Metadata> {
  const { config, locale } = await getPortalRequest();
  const name = config ? (locale === 'ar' && config.nameAr) || config.websiteTitle || config.name : 'TypEase';
  return {
    title: { default: name, template: `%s | ${name}` },
    description: translate(dictionaries, locale, 'app.description'),
    icons: { icon: [{ url: faviconFor(config) }] },
    // Without a centre there is nothing to index.
    robots: config ? undefined : { index: false, follow: false },
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { config, locale, nonce, apiBaseUrl } = await getPortalRequest();
  return (
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
        {/* The centre's colours are part of the first response: no flash of TypEase branding on its domain. */}
        <BrandStyle config={config} nonce={nonce} />
      </head>
      <body>
        <Providers apiBaseUrl={apiBaseUrl} locale={locale} tenantConfig={config}>
          {config ? children : <CentreNotFound />}
        </Providers>
      </body>
    </html>
  );
}
