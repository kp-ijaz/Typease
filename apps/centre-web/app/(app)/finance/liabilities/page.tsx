import { pageTitle } from '@/lib/metadata';
import { Liabilities } from './liabilities';

export const generateMetadata = () => pageTitle('fin.liabilities.title');

export default function Page() {
  return <Liabilities />;
}
