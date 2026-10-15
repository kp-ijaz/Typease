import { pageTitle } from '@/lib/metadata';
import { SignIn } from './sign-in';

export const generateMetadata = () => pageTitle('auth.signIn.title');

export default function Page() {
  return <SignIn />;
}
