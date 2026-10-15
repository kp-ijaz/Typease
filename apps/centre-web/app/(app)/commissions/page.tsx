import { pageTitle } from '@/lib/metadata';
import { Commissions } from './commissions';

export const generateMetadata = () => pageTitle('commission.title');

export default function Page() {
  return <Commissions />;
}
