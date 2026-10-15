import { pageTitle } from '@/lib/metadata';
import { Leads } from './leads';

export const generateMetadata = () => pageTitle('leads.title');

export default function Page() {
  return <Leads />;
}
