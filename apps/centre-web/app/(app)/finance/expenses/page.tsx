import { pageTitle } from '@/lib/metadata';
import { Expenses } from './expenses';

export const generateMetadata = () => pageTitle('fin.expenses.title');

export default function Page() {
  return <Expenses />;
}
