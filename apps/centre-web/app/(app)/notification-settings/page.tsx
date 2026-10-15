import { pageTitle } from '@/lib/metadata';
import { NotificationSettingsPage } from './settings-page';

export const generateMetadata = () => pageTitle('ops.notify.title');

export default function Page() {
  return <NotificationSettingsPage />;
}
