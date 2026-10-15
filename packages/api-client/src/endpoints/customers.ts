import type { Page } from '@typease/types';
import type { customerListQuery, customerSchema, duplicateCheckSchema, z } from '@typease/validation';
import type { ApiClient } from '../client';
import type { CustomerListItem, CustomerProfile, DuplicateCandidate } from '../types';

export type CustomerListFilters = Partial<Omit<z.input<typeof customerListQuery>, 'page' | 'pageSize' | 'sort' | 'q'>>;

export const customersApi = (c: ApiClient) => ({
  list: (query?: z.input<typeof customerListQuery>, signal?: AbortSignal) => c.get<Page<CustomerListItem>>('/customers', { query, signal }),
  /** 409 POSSIBLE_DUPLICATE (details.candidates) unless `confirmNotDuplicate` is true. */
  create: (body: z.input<typeof customerSchema>) => c.post<CustomerProfile>('/customers', body),
  checkDuplicates: (body: z.input<typeof duplicateCheckSchema>) =>
    c.post<{ candidates: DuplicateCandidate[]; strongCount: number; weakCount: number }>('/customers/duplicates/check', body),
});
