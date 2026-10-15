import type { Page } from '@typease/types';
import type { ApiClient } from '../client';
import type { ListQuery } from '../query';
import type { RequestCounts, RequestListFilters, RequestListItem } from '../types';

export const requestsApi = (c: ApiClient) => ({
  list: (query?: ListQuery<RequestListFilters>, signal?: AbortSignal) => c.get<Page<RequestListItem>>('/requests', { query, signal }),
  /** Numbers per dashboard bucket for the caller's scope. */
  counts: (query?: { branchId?: string }) => c.get<RequestCounts>('/requests/counts', { query }),
});
