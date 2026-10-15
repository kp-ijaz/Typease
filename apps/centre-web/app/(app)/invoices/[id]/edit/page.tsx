import { InvoiceForm } from '@/components/fin/invoice-form';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('fin.invoices.form.editTitle');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceForm invoiceId={id} />;
}
