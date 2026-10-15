import { pageTitle } from '@/lib/metadata';
import { SecurityPage } from './security';

export const generateMetadata = () => pageTitle('account.securityTitle');

export default async function Page({ searchParams }: { searchParams: Promise<{ setup?: string }> }) {
  const { setup } = await searchParams;
  return <SecurityPage setupRequested={setup === 'mfa'} />;
}
