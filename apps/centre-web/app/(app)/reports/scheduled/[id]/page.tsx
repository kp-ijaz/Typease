import { pageTitle } from '@/lib/metadata';
import { ScheduledReportDetail } from './scheduled-report-detail';

export const generateMetadata = () => pageTitle('fin.reports.scheduled.detailTitle');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScheduledReportDetail id={id} />;
}
