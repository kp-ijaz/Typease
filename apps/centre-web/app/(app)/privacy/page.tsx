import { pageTitle } from '@/lib/metadata';
import { PrivacyPage } from './privacy-page';

export const generateMetadata = () => pageTitle('adm.privacy.title');

export default function Page() {
  return <PrivacyPage />;
}
