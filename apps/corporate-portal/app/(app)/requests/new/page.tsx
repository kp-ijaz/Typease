import { pageTitle } from '@/lib/metadata';
import { RequestWizard } from './request-wizard';

export const generateMetadata = () => pageTitle('titles.newRequest');

export default function Page() {
  return <RequestWizard />;
}
