import { pageTitle } from '@/lib/metadata';
import { PaymentReturn } from './payment-return';

export const generateMetadata = () => pageTitle('titles.paymentReturn');

export default async function Page({ searchParams }: { searchParams: Promise<{ payment?: string; invoice?: string }> }) {
  const { payment, invoice } = await searchParams;
  // Both values come from the address bar: they are only ever used as ids of records the API then has to confirm.
  const id = (value?: string) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : '');
  return <PaymentReturn paymentId={id(payment)} invoiceId={id(invoice)} />;
}
