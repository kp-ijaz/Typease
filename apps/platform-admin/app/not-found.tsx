import { NotFoundScreen } from '@typease/ui';
import { ROUTES } from '@/lib/config';

export default function NotFound() {
  return <NotFoundScreen homeHref={ROUTES.home} />;
}
