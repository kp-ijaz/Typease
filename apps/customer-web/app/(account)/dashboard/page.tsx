import { pageTitle } from '@/lib/metadata';
import { CustomerDashboard } from './dashboard';

export const generateMetadata = () => pageTitle('account.dashboard.title');

export default function Page() {
  return <CustomerDashboard />;
}
