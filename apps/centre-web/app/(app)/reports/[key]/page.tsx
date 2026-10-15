import { pageTitle } from '@/lib/metadata';
import { ReportView } from './report-view';

export const generateMetadata = () => pageTitle('fin.reports.view.title');

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <ReportView reportKey={key} />;
}
