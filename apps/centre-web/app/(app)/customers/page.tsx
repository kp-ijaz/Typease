import { pageTitle } from '@/lib/metadata';
import { CustomersList } from './customers-list';

export const generateMetadata = () => pageTitle('customers.title');

export default function Page() {
  return <CustomersList />;
}
