import { pageTitle } from '@/lib/metadata';
import { Roles } from './roles';

export const generateMetadata = () => pageTitle('nav.roles');

export default function Page() {
  return <Roles />;
}
