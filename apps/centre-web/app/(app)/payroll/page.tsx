import { pageTitle } from '@/lib/metadata';
import { Payroll } from './payroll';

export const generateMetadata = () => pageTitle('payroll.title');

export default function Page() {
  return <Payroll />;
}
