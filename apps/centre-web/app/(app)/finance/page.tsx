import { pageTitle } from '@/lib/metadata';
import { FinanceIndex } from './finance-index';

export const generateMetadata = () => pageTitle('fin.tools.nav');

export default function Page() {
  return <FinanceIndex />;
}
