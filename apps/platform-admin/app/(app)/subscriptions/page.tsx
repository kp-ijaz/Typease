import { pageTitle } from '@/lib/metadata';
import { Subscriptions } from './subscriptions';

export const generateMetadata = () => pageTitle('nav.subscriptions');

export default function Page() {
  return <Subscriptions />;
}
