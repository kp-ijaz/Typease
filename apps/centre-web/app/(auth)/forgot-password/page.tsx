import { ForgotPasswordForm } from '@typease/ui';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('auth.forgot.title');

export default function Page() {
  return <ForgotPasswordForm signInHref="/sign-in" />;
}
