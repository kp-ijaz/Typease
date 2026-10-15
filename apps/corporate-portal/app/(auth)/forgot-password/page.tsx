import { pageTitle } from '@/lib/metadata';
import { ForgotPassword } from './forgot';

export const generateMetadata = () => pageTitle('auth.forgot.title');

export default function Page() {
  return <ForgotPassword />;
}
