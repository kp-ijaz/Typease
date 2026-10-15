import { pageTitle } from '@/lib/metadata';
import { Executions } from './executions';

export const generateMetadata = () => pageTitle('ops.automations.log.title');

export default function Page() {
  return <Executions />;
}
