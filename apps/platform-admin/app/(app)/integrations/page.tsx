import { pageTitle } from '@/lib/metadata';
import { Integrations } from './integrations';

export const generateMetadata = () => pageTitle('nav.integrations');

export default function Page() {
  return <Integrations />;
}
