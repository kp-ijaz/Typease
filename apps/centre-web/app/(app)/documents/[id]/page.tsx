import { pageTitle } from '@/lib/metadata';
import { DocumentDetailPage } from './document-detail';

export const generateMetadata = () => pageTitle('people.documents.pageTitle');

export default function Page() {
  return <DocumentDetailPage />;
}
