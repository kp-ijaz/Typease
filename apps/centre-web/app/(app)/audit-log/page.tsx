import { pageTitle } from '@/lib/metadata';
import { AuditLog } from './audit-log';

export const generateMetadata = () => pageTitle('fin.audit.title');

export default function Page() {
  return <AuditLog />;
}
