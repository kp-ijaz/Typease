import { FaqPage } from '@/components/text-pages';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('faq.title');

export default function Page() {
  return <FaqPage />;
}
