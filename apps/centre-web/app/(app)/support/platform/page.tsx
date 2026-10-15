import { pageTitle } from '@/lib/metadata';
import { PlatformTickets } from './platform-tickets';

export const generateMetadata = () => pageTitle('ops.support.platform.title');

export default function Page() {
  return <PlatformTickets />;
}
