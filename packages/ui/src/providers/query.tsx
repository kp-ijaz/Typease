'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';

/**
 * One QueryClient per browser tab with the defaults of the TypEase apps:
 *  - data is fresh for 30 s (lists do not refetch on every navigation);
 *  - queries retry twice, but only for problems a retry can cure (network, timeout, 5xx);
 *  - mutations are never retried automatically: the person decides (and money calls carry an idempotency key).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => (isApiError(error) ? error.isRetryable && failureCount < 2 : failureCount < 2),
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ client, children }: { client?: QueryClient; children: React.ReactNode }) {
  const [queryClient] = React.useState(() => client ?? createQueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
