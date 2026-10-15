import { pageTitle } from '@/lib/metadata';
import { InvoiceDetail } from './invoice-detail';

export const generateMetadata = () => pageTitle('account.titles.invoiceDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetail id={id} />;
}
