import { pageTitle } from '@/lib/metadata';
import { Plans } from './plans';

export const generateMetadata = () => pageTitle('plans.title');

export default function Page() {
  return <Plans />;
}
