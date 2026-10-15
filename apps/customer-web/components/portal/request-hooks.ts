'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { RequestView } from '@/lib/types';
import { hasScanningDocument } from './checklist';
import { isNotFound } from './shared';

/**
 * One request as the customer sees it. While a freshly uploaded file is in its
 * security check the request is re-read every few seconds, so the checklist moves
 * from "Security check" to "Uploaded" (or "Blocked") by itself.
 */
export function useRequestView(id: string, enabled = true) {
  const api = usePortalApi();
  return useQuery({
    queryKey: keys.requests.detail(id),
    queryFn: ({ signal }) => api.request(id, signal),
    enabled: enabled && !!id,
    retry: (count, error) => !isNotFound(error) && count < 2,
    refetchInterval: (query) => (hasScanningDocument(query.state.data) ? 3000 : false),
  });
}

/**
 * After an action on a request: put the answer of the API in the cache (when there
 * is one) and refresh everything else that shows requests. Without a view the
 * request itself is read again (an upload does not return it).
 */
export function useApplyRequest(id: string) {
  const queryClient = useQueryClient();
  return React.useCallback(
    (view?: RequestView | null) => {
      if (view) queryClient.setQueryData(keys.requests.detail(view.id), view);
      const own = JSON.stringify(keys.requests.detail(id));
      void queryClient.invalidateQueries({ queryKey: keys.requests.all, predicate: (query) => !view || JSON.stringify(query.queryKey) !== own });
    },
    [queryClient, id],
  );
}
