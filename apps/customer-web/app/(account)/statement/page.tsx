import { pageTitle } from '@/lib/metadata';
import { MyStatement } from './statement';

export const generateMetadata = () => pageTitle('nav.statement');

export default function Page() {
  return <MyStatement />;
}
