import { pageTitle } from '@/lib/metadata';
import { WorkflowsList } from './workflows-list';

export const generateMetadata = () => pageTitle('ops.workflows.title');

export default function Page() {
  return <WorkflowsList />;
}
