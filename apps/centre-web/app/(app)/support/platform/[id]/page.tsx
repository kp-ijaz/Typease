import { pageTitle } from '@/lib/metadata';
import { PlatformTicketPage } from './platform-ticket';

export const generateMetadata = () => pageTitle('ops.support.platform.ticket');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlatformTicketPage id={id} />;
}
