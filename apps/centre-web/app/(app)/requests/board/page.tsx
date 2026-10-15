import { pageTitle } from '@/lib/metadata';
import { RequestBoard } from '../request-board';

export const generateMetadata = () => pageTitle('requests.board.title');

export default function Page() {
  return <RequestBoard />;
}
