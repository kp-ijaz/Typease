'use client';

import { AcceptInvitationForm, useAfterSignIn } from '@typease/ui';
import { ROUTES } from '@/lib/config';

export function AcceptInvitation({ token }: { token?: string }) {
  const afterSignIn = useAfterSignIn({ mapLanding: () => ROUTES.dashboard });
  return <AcceptInvitationForm token={token} signInHref="/login" onSignedIn={afterSignIn} />;
}
