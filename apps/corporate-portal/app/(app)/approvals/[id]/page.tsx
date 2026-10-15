import { pageTitle } from '@/lib/metadata';
import { ApprovalDetail } from './approval-detail';

export const generateMetadata = () => pageTitle('titles.quotationDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ApprovalDetail id={id} />;
}
