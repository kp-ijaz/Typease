import { pageTitle } from '@/lib/metadata';
import { CashRegister } from './cash-register';

export const generateMetadata = () => pageTitle('cash.title');

export default function Page() {
  return <CashRegister />;
}
