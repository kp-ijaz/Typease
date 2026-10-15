'use client';

import * as React from 'react';
import { Combobox, useApi, useI18n, type ComboboxOption, type ComboboxProps } from '@typease/ui';

type Props = Omit<ComboboxProps, 'options' | 'loadOptions' | 'onValueChange' | 'value'> & {
  value: string | null | undefined;
  onChange: (id: string, request: { id: string; requestNo: string; customerName: string; branchId: string } | null) => void;
  branchId?: string;
};

/** Server-side search over requests by number or customer name (an expense that settles the fees of one request). */
export function RequestPicker({ onChange, branchId, ...props }: Props) {
  const api = useApi();
  const { t, pick } = useI18n();
  const cache = React.useRef(new Map<string, { id: string; requestNo: string; customerName: string; branchId: string }>());
  const load = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const page = await api.requests.list({ q: q || undefined, pageSize: 20, sort: 'createdAt:desc', branchId }, signal);
      for (const r of page.data) cache.current.set(r.id, { id: r.id, requestNo: r.requestNo, customerName: r.customerName, branchId: r.branchId });
      return page.data.map((r) => ({ value: r.id, label: r.requestNo, description: `${r.customerName} · ${pick(r.service.name, r.service.nameAr)}` }));
    },
    [api, branchId, pick],
  );
  return (
    <Combobox
      placeholder={t('fin.requestPicker.placeholder')}
      searchPlaceholder={t('fin.requestPicker.search')}
      emptyText={t('fin.requestPicker.empty')}
      clearable
      {...props}
      loadOptions={load}
      onValueChange={(id) => onChange(id, cache.current.get(id) ?? null)}
    />
  );
}
