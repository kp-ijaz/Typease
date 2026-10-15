import { pageTitle } from '@/lib/metadata';
import { QueuePage } from './queue-page';

export const generateMetadata = () => pageTitle('ops.queue.title');

export default function Page() {
  return <QueuePage />;
}
