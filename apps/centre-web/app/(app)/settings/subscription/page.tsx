import { redirect } from 'next/navigation';

/**
 * Links in subscription emails and the payment provider's return URL point to
 * /settings/subscription?invoice=...&result=... : the section lives at /subscription.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const qs = query.toString();
  redirect(qs ? `/subscription?${qs}` : '/subscription');
}
