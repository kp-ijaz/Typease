import { pageTitle } from '@/lib/metadata';
import { CorporateDetail } from './corporate-detail';

export const generateMetadata = () => pageTitle('people.corporate.pageTitle');

export default function Page() {
  return <CorporateDetail />;
}
