import { pageTitle } from '@/lib/metadata';
import { Accounting } from './accounting';

export const generateMetadata = () => pageTitle('fin.accounting.title');

export default function Page() {
  return <Accounting />;
}
