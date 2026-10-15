import { pageTitle } from '@/lib/metadata';
import { PaymentsList } from './payments-list';

export const generateMetadata = () => pageTitle('fin.payments.title');

export default function Page() {
  return <PaymentsList />;
}
