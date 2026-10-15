import { pageTitle } from '@/lib/metadata';
import { AuditPage } from './audit';

export const generateMetadata = () => pageTitle('nav.audit');

export default function Page() {
  return <AuditPage />;
}
