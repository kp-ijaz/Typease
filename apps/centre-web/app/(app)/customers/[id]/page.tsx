import { pageTitle } from '@/lib/metadata';
import { CustomerDetail } from './customer-detail';

export const generateMetadata = () => pageTitle('people.customer.pageTitle');

export default function Page() {
  return <CustomerDetail />;
}
