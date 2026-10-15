import { pageTitle } from '@/lib/metadata';
import { SignDocument } from './sign-document';

export const generateMetadata = () => pageTitle('sign.title');

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  return <SignDocument token={t ?? ''} />;
}
