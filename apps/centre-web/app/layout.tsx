import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import './globals.css';
import { BrandStyle, TENANT_COOKIE, ThemeScript, dirOf, resolveTenant, translate } from '@typease/ui/server';
import { API_URL } from '@/lib/config';
import { dictionaries } from '@/lib/dictionaries';
import { requestLocale } from '@/lib/metadata';
import { Providers } from './providers';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return {
    title: { default: translate(dictionaries, locale, 'app.title'), template: '%s | TypEase' },
    description: translate(dictionaries, locale, 'app.description'),
    icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
    // A staff tool: nothing here belongs in a search engine.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F5F7FA' },
    { media: '(prefers-color-scheme: dark)', color: '#0A111C' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [h, c, locale] = await Promise.all([headers(), cookies(), requestLocale()]);
  const nonce = h.get('x-nonce') ?? undefined;
  // White-label centres see their own brand in the staff app too. The centre last used in this
  // browser is remembered in a cookie so that a reload paints its colours from the first byte.
  const { config } = await resolveTenant({ apiUrl: API_URL, cookieSlug: c.get(TENANT_COOKIE)?.value });

  return (
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
        <BrandStyle config={config} nonce={nonce} />
      </head>
      <body>
        <Providers apiBaseUrl={API_URL} locale={locale} tenantConfig={config}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
