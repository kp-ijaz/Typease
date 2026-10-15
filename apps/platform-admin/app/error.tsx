'use client';

import { ErrorScreen } from '@typease/ui';
import { ROUTES } from '@/lib/config';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} homeHref={ROUTES.home} />;
}
