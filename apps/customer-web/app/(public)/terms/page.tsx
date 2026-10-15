import { LegalPage } from '@/components/text-pages';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('legal.terms.title');

export default function Page() {
  return <LegalPage kind="terms" />;
}
