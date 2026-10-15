import { pageTitle } from '@/lib/metadata';
import { PaymentsOverview } from './payments';

export const generateMetadata = () => pageTitle('nav.payments');

export default function Page() {
  return <PaymentsOverview />;
}
