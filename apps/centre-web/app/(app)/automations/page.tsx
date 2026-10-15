import { pageTitle } from '@/lib/metadata';
import { AutomationsList } from './automations-list';

export const generateMetadata = () => pageTitle('ops.automations.title');

export default function Page() {
  return <AutomationsList />;
}
