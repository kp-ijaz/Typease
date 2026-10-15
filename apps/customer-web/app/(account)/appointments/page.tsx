import { pageTitle } from '@/lib/metadata';
import { Appointments } from './appointments';

export const generateMetadata = () => pageTitle('nav.appointments');

export default function Page() {
  return <Appointments />;
}
