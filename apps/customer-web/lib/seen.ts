'use client';

import * as React from 'react';
import { useSession } from '@typease/ui';

/**
 * Which messages of a request the customer has already looked at ON THIS DEVICE.
 * The API keeps no read state for request messages, so "new" can only mean "new
 * since you last opened this conversation here"; it is stored in localStorage per
 * account and never sent anywhere.
 */
const KEY = 'te_seen_messages';
const EVENT = 'te-seen-messages';

function read(userId: string): Record<string, string> {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, Record<string, string>>;
    return all[userId] ?? {};
  } catch {
    return {};
  }
}

export function useSeenMessages() {
  const userId = useSession().user?.id ?? '';
  const [seen, setSeen] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!userId) return;
    const sync = () => setSeen(read(userId));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [userId]);

  const markSeen = React.useCallback(
    (requestId: string, at: string) => {
      if (!userId) return;
      try {
        const all = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, Record<string, string>>;
        const mine = all[userId] ?? {};
        if ((mine[requestId] ?? '') >= at) return;
        all[userId] = { ...mine, [requestId]: at };
        window.localStorage.setItem(KEY, JSON.stringify(all));
        window.dispatchEvent(new Event(EVENT));
      } catch {
        /* private mode: nothing is remembered, every centre message simply stays "new" */
      }
    },
    [userId],
  );

  /** True when the newest message of the centre is newer than what was seen here. */
  const isNew = React.useCallback((requestId: string, latestFromCentre: string | null | undefined) => !!latestFromCentre && (seen[requestId] ?? '') < latestFromCentre, [seen]);
  return { isNew, markSeen };
}
