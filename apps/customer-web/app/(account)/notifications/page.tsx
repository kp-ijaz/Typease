import { pageTitle } from '@/lib/metadata';
import { Notifications } from './notifications';

export const generateMetadata = () => pageTitle('nav.notifications');

export default function Page() {
  return <Notifications />;
}
