import type { Metadata } from 'next';
import { translate } from '@typease/ui/server';
import { dictionaries } from './dictionaries';
import { getPortalRequest } from './tenant';

/** Localised <title> for a page: `export const generateMetadata = () => pageTitle('services.title');` */
export async function pageTitle(key: string): Promise<Metadata> {
  const { locale } = await getPortalRequest();
  return { title: translate(dictionaries, locale, key) };
}
