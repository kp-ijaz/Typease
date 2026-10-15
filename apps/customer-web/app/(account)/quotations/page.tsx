import { pageTitle } from '@/lib/metadata';
import { QuotationsList } from './quotations-list';

export const generateMetadata = () => pageTitle('nav.quotations');

export default function Page() {
  return <QuotationsList />;
}
