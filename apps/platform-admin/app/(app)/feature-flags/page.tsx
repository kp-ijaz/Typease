import { pageTitle } from '@/lib/metadata';
import { FeatureFlags } from './flags';

export const generateMetadata = () => pageTitle('nav.flags');

export default function Page() {
  return <FeatureFlags />;
}
