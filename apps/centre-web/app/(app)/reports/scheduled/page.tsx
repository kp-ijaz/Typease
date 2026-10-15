import { pageTitle } from '@/lib/metadata';
import { ScheduledReports } from './scheduled-reports';

export const generateMetadata = () => pageTitle('fin.reports.scheduled.title');

export default function Page() {
  return <ScheduledReports />;
}
