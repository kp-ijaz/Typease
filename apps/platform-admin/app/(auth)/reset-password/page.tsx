import { ResetPasswordForm } from '@typease/ui';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('auth.reset.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token} signInHref="/sign-in" forgotHref="/forgot-password" />;
}
