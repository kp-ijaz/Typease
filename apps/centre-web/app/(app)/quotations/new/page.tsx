import { QuotationForm } from '@/components/fin/quotation-form';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('fin.quotations.form.newTitle');

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <QuotationForm requestId={one(query.requestId)} customerId={one(query.customerId)} />;
}
