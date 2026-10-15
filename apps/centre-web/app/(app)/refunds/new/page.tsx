import { pageTitle } from '@/lib/metadata';
import { RefundForm } from './refund-form';

export const generateMetadata = () => pageTitle('fin.refunds.form.title');

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <RefundForm paymentId={one(query.paymentId)} />;
}
