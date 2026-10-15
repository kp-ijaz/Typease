import { pageTitle } from '@/lib/metadata';
import { Paperwork } from './paperwork';

export const generateMetadata = () => pageTitle('paperwork.title');

export default function Page() {
  return <Paperwork />;
}
