import { QuotationForm } from '@/components/fin/quotation-form';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('fin.quotations.form.editTitle');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuotationForm quotationId={id} />;
}
