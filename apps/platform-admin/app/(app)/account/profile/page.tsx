import { pageTitle } from '@/lib/metadata';
import { ProfilePage } from './profile';

export const generateMetadata = () => pageTitle('account.profileTitle');

export default function Page() {
  return <ProfilePage />;
}
