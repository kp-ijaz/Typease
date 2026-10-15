import { pageTitle } from '@/lib/metadata';
import { WorkflowPage } from './workflow-page';

export const generateMetadata = () => pageTitle('ops.workflows.builder.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowPage id={id} />;
}
