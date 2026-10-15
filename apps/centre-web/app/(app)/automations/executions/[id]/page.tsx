import { pageTitle } from '@/lib/metadata';
import { ExecutionPage } from './execution-page';

export const generateMetadata = () => pageTitle('ops.automations.execution.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExecutionPage id={id} />;
}
