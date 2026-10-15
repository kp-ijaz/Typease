import { pageTitle } from '@/lib/metadata';
import { ServicesCatalogue } from './services-catalogue';

export const generateMetadata = () => pageTitle('ops.services.title');

export default function Page() {
  return <ServicesCatalogue />;
}
