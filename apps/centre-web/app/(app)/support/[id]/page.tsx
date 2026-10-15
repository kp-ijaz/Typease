import { pageTitle } from '@/lib/metadata';
import { TicketPage } from './ticket-page';

export const generateMetadata = () => pageTitle('ops.support.ticket');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TicketPage id={id} />;
}
