import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/config';

export default function IndexPage() {
  redirect(ROUTES.home);
}
