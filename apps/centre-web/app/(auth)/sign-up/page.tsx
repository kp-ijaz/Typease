import { pageTitle } from '@/lib/metadata';
import { SignUp } from './sign-up';

export const generateMetadata = () => pageTitle('auth.signup.title');

export default function Page() {
  return <SignUp />;
}
