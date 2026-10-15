import { pageTitle } from '@/lib/metadata';
import { DomainsPage } from './domains-page';

export const generateMetadata = () => pageTitle('adm.domains.title');

export default function Page() {
  return <DomainsPage />;
}
