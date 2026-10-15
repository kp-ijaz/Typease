import { pageTitle } from '@/lib/metadata';
import { Invoices } from './invoices';

export const generateMetadata = () => pageTitle('nav.invoices');

export default function Page() {
  return <Invoices />;
}
