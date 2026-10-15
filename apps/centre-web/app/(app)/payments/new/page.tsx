import { pageTitle } from '@/lib/metadata';
import { PaymentForm } from './payment-form';

export const generateMetadata = () => pageTitle('fin.payments.form.title');

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <PaymentForm invoiceId={one(query.invoiceId)} customerId={one(query.customerId)} corporateAccountId={one(query.corporateAccountId)} />;
}
