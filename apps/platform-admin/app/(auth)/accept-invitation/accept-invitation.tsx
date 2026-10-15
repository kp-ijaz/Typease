'use client';

import { AcceptInvitationForm, useAfterSignIn } from '@typease/ui';
import { mapLanding } from '../sign-in/sign-in';

export function AcceptInvitation({ token }: { token?: string }) {
  const afterSignIn = useAfterSignIn({ mapLanding });
  return <AcceptInvitationForm token={token} signInHref="/sign-in" onSignedIn={afterSignIn} />;
}
