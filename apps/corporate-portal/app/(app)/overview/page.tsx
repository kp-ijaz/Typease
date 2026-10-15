import { pageTitle } from '@/lib/metadata';
import { Overview } from './overview';

export const generateMetadata = () => pageTitle('overview.title');

export default function Page() {
  return <Overview />;
}
