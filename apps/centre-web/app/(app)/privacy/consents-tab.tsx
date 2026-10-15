'use client';

import * as React from 'react';
import Link from 'next/link';
import { HandHeart } from 'lucide-react';
import type { Page } from '@typease/types';
import { CONSENT_PURPOSES } from '@typease/validation';
import { Badge, DataTable, useApi, useI18n, type DataTableColumn, type DataTableFilter } from '@typease/ui';
import type { ConsentRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { usePrivacyLabels } from './labels';

/** The current consent of each customer per purpose (read-only: consent is recorded on the customer's own page). */
export function ConsentsTab() {
  const { t, formatDate } = useI18n();
  const api = useApi();
  const labels = usePrivacyLabels();
  const columns = React.useMemo<Array<DataTableColumn<ConsentRow>>>(
    () => [
      {
        id: 'customer',
        header: t('adm.privacy.requests.customer'),
        mobile: 'title',
        cell: (c) =>
          c.customer ? (
            <Link href={`/customers/${c.customer.id}`} className="font-medium text-secondary-text underline-offset-4 hover:underline">
              {c.customer.fullName} <span className="tabular font-normal text-muted-foreground">{c.customer.customerNo}</span>
            </Link>
          ) : null,
      },
      { id: 'purpose', header: t('adm.privacy.consents.purpose'), cell: (c) => labels.purpose(c.purpose) },
      { id: 'status', header: t('adm.privacy.requests.status'), mobile: 'badge', cell: (c) => <Badge tone={c.status === 'GRANTED' ? 'success' : 'neutral'}>{c.status === 'GRANTED' ? t('adm.privacy.consents.granted') : t('adm.privacy.consents.withdrawn')}</Badge> },
      { id: 'basis', header: t('adm.privacy.consents.basis'), cell: (c) => labels.basis(c.lawfulBasis) },
      { id: 'date', header: t('adm.privacy.consents.since'), className: 'whitespace-nowrap tabular', cell: (c) => formatDate(c.status === 'GRANTED' ? c.grantedAt : (c.withdrawnAt ?? c.updatedAt)) },
    ],
    [t, labels, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'purpose', type: 'select', label: t('adm.privacy.consents.purpose'), options: CONSENT_PURPOSES.map((p) => ({ value: p, label: labels.purpose(p) })) },
      { id: 'status', type: 'select', label: t('adm.privacy.requests.status'), options: [{ value: 'GRANTED', label: t('adm.privacy.consents.granted') }, { value: 'WITHDRAWN', label: t('adm.privacy.consents.withdrawn') }] },
    ],
    [t, labels],
  );
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-base text-muted-foreground">{t('adm.privacy.consents.intro')}</p>
      <DataTable<ConsentRow>
        caption={t('adm.privacy.tabs.consents')}
        queryKey={admKeys.privacy.consents}
        queryFn={({ sort: _sort, q: _q, ...query }, signal) => api.client.get<Page<ConsentRow>>('/privacy/consents', { query, signal })}
        columns={columns}
        rowKey={(c) => c.id}
        filters={filters}
        searchable={false}
        empty={{ icon: <HandHeart />, title: t('adm.privacy.consents.emptyTitle'), description: t('adm.privacy.consents.emptyText') }}
      />
    </div>
  );
}
