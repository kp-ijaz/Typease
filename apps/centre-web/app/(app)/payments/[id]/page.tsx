import { pageTitle } from '@/lib/metadata';
import { PaymentDetail } from './payment-detail';

export const generateMetadata = () => pageTitle('fin.payments.detail.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaymentDetail id={id} />;
}
