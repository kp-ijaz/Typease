import { pageTitle } from '@/lib/metadata';
import { AutomationRulePage } from './rule-page';

export const generateMetadata = () => pageTitle('ops.automations.editor.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationRulePage id={id} />;
}
