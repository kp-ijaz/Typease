import { pageTitle } from '@/lib/metadata';
import { Inbox } from './inbox';

export const generateMetadata = () => pageTitle('ops.inbox.title');

export default function Page() {
  return <Inbox />;
}
