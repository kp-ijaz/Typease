import { pageTitle } from '@/lib/metadata';
import { StaffPage } from './staff-page';

export const generateMetadata = () => pageTitle('adm.staff.title');

export default function Page() {
  return <StaffPage />;
}
