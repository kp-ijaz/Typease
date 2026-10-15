import { pageTitle } from '@/lib/metadata';
import { InvoiceDetail } from './invoice-detail';

export const generateMetadata = () => pageTitle('fin.invoices.detail.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDetail id={id} />;
}
