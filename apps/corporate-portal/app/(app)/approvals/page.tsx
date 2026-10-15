import { pageTitle } from '@/lib/metadata';
import { Approvals } from './approvals';

export const generateMetadata = () => pageTitle('nav.approvals');

export default function Page() {
  return <Approvals />;
}
