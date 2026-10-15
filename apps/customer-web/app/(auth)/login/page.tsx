import { pageTitle } from '@/lib/metadata';
import { Login } from './login';

export const generateMetadata = () => pageTitle('auth.loginTitle');

export default async function Page({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return <Login defaultEmail={email} />;
}
