import { pageTitle } from '@/lib/metadata';
import { TicketPage } from './ticket';

export const generateMetadata = () => pageTitle('desk.ticket');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TicketPage id={id} />;
}
