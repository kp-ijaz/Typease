import { pageTitle } from '@/lib/metadata';
import { CorporateList } from './corporate-list';

export const generateMetadata = () => pageTitle('nav.corporate');

export default function Page() {
  return <CorporateList />;
}
