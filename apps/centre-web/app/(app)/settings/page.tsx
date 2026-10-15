import { pageTitle } from '@/lib/metadata';
import { SettingsPage } from './settings-page';

export const generateMetadata = () => pageTitle('adm.settings.title');

export default function Page() {
  return <SettingsPage />;
}
