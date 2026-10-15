import { pageTitle } from '@/lib/metadata';
import { TenantPage } from './tenant';

export const generateMetadata = () => pageTitle('titles.tenantDetail');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TenantPage id={id} />;
}
