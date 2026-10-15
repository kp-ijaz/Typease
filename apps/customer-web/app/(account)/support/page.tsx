import { pageTitle } from '@/lib/metadata';
import { SupportList } from './support-list';

export const generateMetadata = () => pageTitle('nav.support');

export default function Page() {
  return <SupportList />;
}
