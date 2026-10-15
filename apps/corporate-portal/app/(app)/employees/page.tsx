import { pageTitle } from '@/lib/metadata';
import { EmployeesList } from './employees-list';

export const generateMetadata = () => pageTitle('nav.employees');

export default function Page() {
  return <EmployeesList />;
}
