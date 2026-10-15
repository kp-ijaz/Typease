import { InvoiceForm } from '@/components/fin/invoice-form';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('fin.invoices.form.newTitle');

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <InvoiceForm customerId={one(query.customerId)} requestId={one(query.requestId)} />;
}
