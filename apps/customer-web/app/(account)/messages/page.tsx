import { pageTitle } from '@/lib/metadata';
import { Messages } from './messages';

export const generateMetadata = () => pageTitle('nav.messages');

export default function Page() {
  return <Messages />;
}
