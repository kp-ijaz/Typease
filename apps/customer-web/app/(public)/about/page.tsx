import { AboutPage } from '@/components/text-pages';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('nav.about');

export default function Page() {
  return <AboutPage />;
}
