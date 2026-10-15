'use client';

import { useQuery } from '@tanstack/react-query';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';

/** Invoices with something left to pay. The list endpoint filters one status at a time, so the two open ones are read together. */
export function useUnpaidInvoices() {
  const api = usePortalApi();
  return useQuery({
    queryKey: keys.invoices.unpaid,
    queryFn: async ({ signal }) => {
      const [issued, partly] = await Promise.all([
        api.invoices({ status: 'ISSUED', pageSize: 100, sort: 'createdAt:desc' }, signal),
        api.invoices({ status: 'PARTIALLY_PAID', pageSize: 100, sort: 'createdAt:desc' }, signal),
      ]);
      return [...issued.data, ...partly.data].filter((invoice) => Number(invoice.balanceDue) > 0).sort((a, b) => (a.dueAt ?? a.createdAt).localeCompare(b.dueAt ?? b.createdAt));
    },
    staleTime: 60_000,
  });
}
