import { pageTitle } from '@/lib/metadata';
import { IntegrationsPage } from './integrations-page';

export const generateMetadata = () => pageTitle('adm.integrations.title');

export default function Page() {
  return <IntegrationsPage />;
}
