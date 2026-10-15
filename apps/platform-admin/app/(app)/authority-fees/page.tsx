import { pageTitle } from '@/lib/metadata';
import { AuthorityFees } from './authority-fees';

export const generateMetadata = () => pageTitle('nav.fees');

export default function Page() {
  return <AuthorityFees />;
}
