import { pageTitle } from '@/lib/metadata';
import { QuotationDetail } from './quotation-detail';

export const generateMetadata = () => pageTitle('account.titles.quotationDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuotationDetail id={id} />;
}
