import { pageTitle } from '@/lib/metadata';
import { RemindersPage } from './reminders-page';

export const generateMetadata = () => pageTitle('ops.reminders.title');

export default function Page() {
  return <RemindersPage />;
}
