import { ContactPage } from '@/components/text-pages';
import { pageTitle } from '@/lib/metadata';

export const generateMetadata = () => pageTitle('contact.title');

export default function Page() {
  return <ContactPage />;
}
