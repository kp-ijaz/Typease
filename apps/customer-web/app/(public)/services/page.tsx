import { pageTitle } from '@/lib/metadata';
import { ServicesList } from './services-list';

export const generateMetadata = () => pageTitle('services.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  const { q, category } = await searchParams;
  return <ServicesList initialQuery={q ?? ''} initialCategory={category ?? ''} />;
}
