import { pageTitle } from '@/lib/metadata';
import { ReportsCatalogue } from './reports-catalogue';

export const generateMetadata = () => pageTitle('fin.reports.title');

export default function Page() {
  return <ReportsCatalogue />;
}
