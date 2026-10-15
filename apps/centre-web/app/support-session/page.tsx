import type { Metadata } from 'next';
import { pageTitle } from '@/lib/metadata';
import { SupportSessionLanding } from './landing';

/**
 * Where TypEase support staff arrive from the platform console: /support-session#code=<one-time code>.
 * Outside the (app) group on purpose: no shell, no navigation, nothing of the centre is shown before the
 * code has been exchanged. The code is in the URL fragment, which the browser never sends to this server.
 */
export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageTitle('adm.supportSession.title')), referrer: 'no-referrer' };
}

export default function Page() {
  return <SupportSessionLanding />;
}
