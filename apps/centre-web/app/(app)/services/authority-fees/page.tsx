import { pageTitle } from '@/lib/metadata';
import { AuthorityFeeCatalogue } from './authority-fees';

export const generateMetadata = () => pageTitle('ops.services.fees.title');

export default function Page() {
  return <AuthorityFeeCatalogue />;
}
