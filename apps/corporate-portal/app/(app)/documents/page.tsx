import { pageTitle } from '@/lib/metadata';
import { DocumentVault } from './documents';

export const generateMetadata = () => pageTitle('nav.documents');

export default function Page() {
  return <DocumentVault />;
}
