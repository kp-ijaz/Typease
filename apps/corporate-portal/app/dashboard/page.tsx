import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/config';

// Links written for the other apps ("/dashboard") land on this portal's home.
export default function Page() {
  redirect(ROUTES.home);
}
