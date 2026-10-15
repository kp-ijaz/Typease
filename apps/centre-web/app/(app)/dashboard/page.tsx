import { pageTitle } from '@/lib/metadata';
import { Dashboard } from './dashboard';

export const generateMetadata = () => pageTitle('dashboard.title');

export default function Page() {
  return <Dashboard />;
}
