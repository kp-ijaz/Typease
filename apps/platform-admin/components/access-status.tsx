'use client';

import * as React from 'react';
import { Badge, useI18n, type Tone } from '@typease/ui';
import type { AccessGrant } from '@/lib/types';

/** What a grant is right now. An approved grant whose time is over counts as expired even before the expiry job has marked it. */
export type AccessState = 'REQUESTED' | 'ACTIVE' | 'DENIED' | 'REVOKED' | 'EXPIRED';

export function accessState(grant: Pick<AccessGrant, 'status' | 'usable'>): AccessState {
  if (grant.status === 'APPROVED') return grant.usable ? 'ACTIVE' : 'EXPIRED';
  return grant.status;
}

const TONES: Record<AccessState, Tone> = { REQUESTED: 'warning', ACTIVE: 'success', DENIED: 'danger', REVOKED: 'neutral', EXPIRED: 'neutral' };

/** Status of a support access request, in words (the shared status catalogue has no kind for it). */
export function AccessStatusBadge({ grant }: { grant: Pick<AccessGrant, 'status' | 'usable'> }) {
  const { t } = useI18n();
  const state = accessState(grant);
  return (
    <Badge tone={TONES[state]} data-status={state}>
      {t(`access.status.${state}`)}
    </Badge>
  );
}
