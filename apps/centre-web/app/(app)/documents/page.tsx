import { pageTitle } from '@/lib/metadata';
import { DocumentsList } from './documents-list';

export const generateMetadata = () => pageTitle('nav.documents');

export default function Page() {
  return <DocumentsList />;
}
