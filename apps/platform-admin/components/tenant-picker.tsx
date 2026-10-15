'use client';

import * as React from 'react';
import { Combobox, useI18n, type ComboboxProps } from '@typease/ui';
import { usePlatformApi } from '@/lib/api';

export interface PickedTenant {
  id: string;
  name: string;
  slug: string;
}

/**
 * Searchable choice of one centre (GET /platform/tenants?q=): name, legal name, address part or contact email.
 * The list is searched on the server, so it works for any number of centres.
 */
export function TenantPicker({
  value, onChange, selectedLabel, placeholder, clearable = true, ...props
}: Omit<ComboboxProps, 'value' | 'onValueChange' | 'options' | 'loadOptions' | 'selectedLabel'> & {
  value: string | null | undefined;
  onChange: (id: string, tenant: PickedTenant | null) => void;
  selectedLabel?: string | null;
}) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const found = React.useRef(new Map<string, PickedTenant>());
  return (
    <Combobox
      {...props}
      value={value ?? ''}
      clearable={clearable}
      selectedLabel={selectedLabel}
      placeholder={placeholder ?? t('pc.pickCentre')}
      searchPlaceholder={t('pc.pickCentreSearch')}
      emptyText={t('pc.pickCentreEmpty')}
      loadOptions={async (q, signal) => {
        const page = await api.tenants.list({ q: q || undefined, pageSize: 20, sort: 'name:asc' }, signal);
        for (const row of page.data) found.current.set(row.id, { id: row.id, name: row.name, slug: row.slug });
        return page.data.map((row) => ({ value: row.id, label: row.name, description: row.slug }));
      }}
      onValueChange={(id) => onChange(id, id ? found.current.get(id) ?? null : null)}
    />
  );
}
