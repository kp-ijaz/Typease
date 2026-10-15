import { pageTitle } from '@/lib/metadata';
import { TrackRequest } from './track';

export const generateMetadata = () => pageTitle('track.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ no?: string; code?: string }> }) {
  const { no, code } = await searchParams;
  return <TrackRequest initialNo={no ?? ''} initialCode={code ?? ''} />;
}
