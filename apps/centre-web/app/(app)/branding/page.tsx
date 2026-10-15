import { pageTitle } from '@/lib/metadata';
import { BrandingPage } from './branding-page';

export const generateMetadata = () => pageTitle('adm.branding.title');

export default function Page() {
  return <BrandingPage />;
}
