import { pageTitle } from '@/lib/metadata';
import { RolesPage } from './roles-page';

export const generateMetadata = () => pageTitle('adm.roles.title');

export default function Page() {
  return <RolesPage />;
}
