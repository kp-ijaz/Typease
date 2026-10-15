import { pageTitle } from '@/lib/metadata';
import { Register } from './register';

export const generateMetadata = () => pageTitle('auth.register.title');

export default function Page() {
  return <Register />;
}
