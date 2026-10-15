import { pageTitle } from '@/lib/metadata';
import { RefundsList } from './refunds-list';

export const generateMetadata = () => pageTitle('fin.refunds.title');

export default function Page() {
  return <RefundsList />;
}
