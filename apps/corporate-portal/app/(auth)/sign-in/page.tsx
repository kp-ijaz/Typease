import { pageTitle } from '@/lib/metadata';
import { SignIn } from './sign-in';

export const generateMetadata = () => pageTitle('auth.signIn.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return <SignIn defaultEmail={email} />;
}
