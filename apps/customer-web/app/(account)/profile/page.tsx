import { pageTitle } from '@/lib/metadata';
import { Profile } from './profile';

export const generateMetadata = () => pageTitle('nav.profile');

export default function Page() {
  return <Profile />;
}
