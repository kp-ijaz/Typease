import { pageTitle } from '@/lib/metadata';
import { SupportPage } from './support-page';

export const generateMetadata = () => pageTitle('ops.support.title');

export default function Page() {
  return <SupportPage />;
}
