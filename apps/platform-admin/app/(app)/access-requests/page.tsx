import { pageTitle } from '@/lib/metadata';
import { AccessRequests } from './access-requests';

export const generateMetadata = () => pageTitle('nav.access');

export default function Page() {
  return <AccessRequests />;
}
