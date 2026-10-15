import { pageTitle } from '@/lib/metadata';
import { StaffPage } from './staff';

export const generateMetadata = () => pageTitle('nav.staff');

export default function Page() {
  return <StaffPage />;
}
