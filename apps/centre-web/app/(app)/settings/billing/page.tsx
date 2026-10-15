import { redirect } from 'next/navigation';

/**
 * Some subscription emails link to /settings/billing?invoice=...&result=... :
 * the page lives at /subscription. The query string travels along.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const qs = query.toString();
  redirect(qs ? `/subscription?${qs}` : '/subscription');
}
