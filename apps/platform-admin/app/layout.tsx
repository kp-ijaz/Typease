import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import './globals.css';
import { NONCE_HEADER, ThemeScript, dirOf, translate } from '@typease/ui/server';
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
    // Internal tool: never indexed.
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

// The platform console is always TypEase-branded: no centre is resolved and no brand style is inlined.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [h, locale] = await Promise.all([headers(), requestLocale()]);
  return (
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning>
      <head>
        <ThemeScript nonce={h.get(NONCE_HEADER) ?? undefined} />
      </head>
      <body>
        <Providers apiBaseUrl={API_URL} locale={locale}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
