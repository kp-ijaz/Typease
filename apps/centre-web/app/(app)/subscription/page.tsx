import { pageTitle } from '@/lib/metadata';
import { SubscriptionPage } from './subscription';

export const generateMetadata = () => pageTitle('fin.subscription.title');

export default function Page() {
  return <SubscriptionPage />;
}
