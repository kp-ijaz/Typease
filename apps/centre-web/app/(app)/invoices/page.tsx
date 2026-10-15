import { pageTitle } from '@/lib/metadata';
import { InvoicesList } from './invoices-list';

export const generateMetadata = () => pageTitle('fin.invoices.title');

export default function Page() {
  return <InvoicesList />;
}
