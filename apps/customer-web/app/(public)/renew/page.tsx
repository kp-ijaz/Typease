import { pageTitle } from '@/lib/metadata';
import { RenewalOffer } from './renewal-offer';

export const generateMetadata = () => pageTitle('renew.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string; paid?: string }> }) {
  const { t, paid } = await searchParams;
  return <RenewalOffer token={t ?? ''} returned={paid === '1'} />;
}
