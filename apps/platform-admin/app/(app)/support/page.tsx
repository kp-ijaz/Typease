import { pageTitle } from '@/lib/metadata';
import { SupportDesk } from './support';

export const generateMetadata = () => pageTitle('nav.support');

export default function Page() {
  return <SupportDesk />;
}
