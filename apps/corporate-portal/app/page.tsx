import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/config';

export default function Page() {
  redirect(ROUTES.home);
}
