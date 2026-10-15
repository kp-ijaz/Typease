import { VerifyEmailPanel } from '@typease/ui';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('auth.verifyEmail.pendingTitle');

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string; email?: string; dev?: string }> }) {
  const { token, email, dev } = await searchParams;
  return <VerifyEmailPanel token={token} email={email} devToken={dev} signInHref="/sign-in" />;
}
