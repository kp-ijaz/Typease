import { pageTitle } from '@/lib/metadata';
import { EmployeeDetail } from './employee-detail';

export const generateMetadata = () => pageTitle('titles.employeeDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EmployeeDetail id={id} />;
}
