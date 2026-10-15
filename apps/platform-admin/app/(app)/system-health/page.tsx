import { pageTitle } from '@/lib/metadata';
import { SystemHealthPage } from './health';

export const generateMetadata = () => pageTitle('nav.health');

export default function Page() {
  return <SystemHealthPage />;
}
