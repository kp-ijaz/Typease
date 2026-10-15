import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, translate, type Locale } from '@typease/ui/server';
import { dictionaries } from './dictionaries';

/** The UI language of this request: saved cookie, else the browser's preference. */
export async function requestLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return resolveLocale({ cookie: c.get(LOCALE_COOKIE)?.value, acceptLanguage: h.get('accept-language') });
}

/**
 * Localised <title> for a page: `export const generateMetadata = () => pageTitle('requests.title');`
 * The root layout adds the "| TypEase" suffix.
 */
export async function pageTitle(key: string): Promise<Metadata> {
  return { title: translate(dictionaries, await requestLocale(), key) };
}
