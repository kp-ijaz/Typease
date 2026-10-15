import { pageTitle } from '@/lib/metadata';
import { Coupons } from './coupons';

export const generateMetadata = () => pageTitle('titles.coupons');

export default function Page() {
  return <Coupons />;
}
