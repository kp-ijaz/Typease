import { pageTitle } from '@/lib/metadata';
import { Appointments } from './appointments';

export const generateMetadata = () => pageTitle('ops.appointments.title');

export default function Page() {
  return <Appointments />;
}
