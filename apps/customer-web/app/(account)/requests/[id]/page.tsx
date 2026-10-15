import { pageTitle } from '@/lib/metadata';
import { RequestDetail } from './request-detail';

export const generateMetadata = () => pageTitle('account.titles.requestDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestDetail id={id} />;
}
