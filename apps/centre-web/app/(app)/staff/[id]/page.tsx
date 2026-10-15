import { pageTitle } from '@/lib/metadata';
import { StaffDetail } from './staff-detail';

export const generateMetadata = () => pageTitle('adm.staff.detail.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StaffDetail id={id} />;
}
