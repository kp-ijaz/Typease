import { pageTitle } from '@/lib/metadata';
import { Reminders } from './reminders';

export const generateMetadata = () => pageTitle('nav.reminders');

export default function Page() {
  return <Reminders />;
}
