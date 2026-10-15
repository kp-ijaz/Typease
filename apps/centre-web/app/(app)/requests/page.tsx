import { pageTitle } from '@/lib/metadata';
import { RequestsList } from './requests-list';

export const generateMetadata = () => pageTitle('requests.title');

export default function Page() {
  return <RequestsList />;
}
