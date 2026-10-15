import { pageTitle } from '@/lib/metadata';
import { AcceptInvitation } from './accept';

export const generateMetadata = () => pageTitle('auth.invitation.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <AcceptInvitation token={token} />;
}
