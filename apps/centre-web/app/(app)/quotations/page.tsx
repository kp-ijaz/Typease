import { pageTitle } from '@/lib/metadata';
import { QuotationsList } from './quotations-list';

export const generateMetadata = () => pageTitle('fin.quotations.title');

export default function Page() {
  return <QuotationsList />;
}
