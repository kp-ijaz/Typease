import { pageTitle } from '@/lib/metadata';
import { QueueDisplay } from './queue-display';

export const generateMetadata = () => pageTitle('ops.queueDisplay.title');

/**
 * The public queue screen of a branch (a TV in the waiting area): no sign-in, no staff shell.
 * It is opened with a signed display link created on the Queue page: /queue-display?token=...&lang=ar
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; lang?: string | string[] }> }) {
  const params = await searchParams;
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const lang = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  return <QueueDisplay token={token ?? ''} lang={lang === 'ar' || lang === 'en' ? lang : undefined} />;
}
