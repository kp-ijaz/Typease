import { pageTitle } from '@/lib/metadata';
import { TicketDetail } from './ticket-detail';

export const generateMetadata = () => pageTitle('account.titles.supportDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TicketDetail id={id} />;
}
