import { pageTitle } from '@/lib/metadata';
import { RefundDetail } from './refund-detail';

export const generateMetadata = () => pageTitle('fin.refunds.detail.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RefundDetail id={id} />;
}
