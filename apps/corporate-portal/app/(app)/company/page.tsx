import { pageTitle } from '@/lib/metadata';
import { Company } from './company';

export const generateMetadata = () => pageTitle('nav.company');

export default function Page() {
  return <Company />;
}
