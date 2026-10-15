import { pageTitle } from '@/lib/metadata';
import { BranchesPage } from './branches-page';

export const generateMetadata = () => pageTitle('adm.branches.title');

export default function Page() {
  return <BranchesPage />;
}
