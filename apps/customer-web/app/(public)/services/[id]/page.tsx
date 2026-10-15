import { pageTitle } from '@/lib/metadata';
import { ServiceDetail } from './service-detail';

export const generateMetadata = () => pageTitle('services.title');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServiceDetail id={id} />;
}
