import { pageTitle } from '@/lib/metadata';
import { ReconciliationDetail } from './reconciliation-detail';

export const generateMetadata = () => pageTitle('fin.reconciliation.detail.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReconciliationDetail id={id} />;
}
