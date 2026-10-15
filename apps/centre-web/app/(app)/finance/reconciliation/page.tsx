import { pageTitle } from '@/lib/metadata';
import { Reconciliations } from './reconciliation';

export const generateMetadata = () => pageTitle('fin.reconciliation.title');

export default function Page() {
  return <Reconciliations />;
}
