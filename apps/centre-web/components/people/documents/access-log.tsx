'use client';

import * as React from 'react';
import { ScrollText } from 'lucide-react';
import type { Page } from '@typease/types';
import { DataTable, useApi, useI18n, type DataTableColumn } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { Ltr, Section, useStaffNames } from '../shared';
import type { AccessLogRow } from '../types';

const ACTOR_TYPES = ['STAFF', 'CUSTOMER', 'CORPORATE', 'PLATFORM', 'SYSTEM', 'AUTOMATION'];

/** Who viewed, downloaded, shared or changed this document, and when (append-only log of the vault). */
export function AccessLogCard({ documentId }: { documentId: string }) {
  const { t, has, formatDateTime } = useI18n();
  const api = useApi();
  const staffName = useStaffNames();
  const columns = React.useMemo<Array<DataTableColumn<AccessLogRow>>>(
    () => [
      { id: 'when', header: t('people.documents.log.when'), mobile: 'title', className: 'whitespace-nowrap tabular', cell: (row) => formatDateTime(row.createdAt) },
      { id: 'action', header: t('people.documents.log.action'), cell: (row) => (has(`people.documents.log.actions.${row.action}`) ? t(`people.documents.log.actions.${row.action}`) : row.action.toLowerCase().replace(/_/g, ' ')) },
      {
        id: 'who',
        header: t('people.documents.log.who'),
        cell: (row) => {
          const type = ACTOR_TYPES.includes(row.actorType) ? t(`people.actorTypes.${row.actorType}`) : row.actorType;
          const name = staffName(row.actorId);
          return (
            <>
              <span className="block">{name ?? type}</span>
              {name ? <span className="block text-sm text-muted-foreground">{type}</span> : null}
              {row.supportGrantId ? <span className="block text-sm text-warning-text">{t('people.documents.log.support')}</span> : null}
            </>
          );
        },
      },
      { id: 'ip', header: t('people.documents.log.ip'), mobile: 'hidden', cell: (row) => (row.ip ? <Ltr className="text-sm text-muted-foreground">{row.ip}</Ltr> : null) },
    ],
    [t, has, formatDateTime, staffName],
  );
  return (
    <Section title={t('people.documents.log.title')} description={t('people.documents.log.description')} flush>
      <DataTable<AccessLogRow>
        bare
        caption={t('people.documents.log.title')}
        queryKey={peopleKeys.documents.accessLogs(documentId)}
        queryFn={(params, signal) => api.client.get<Page<AccessLogRow>>(`/documents/${documentId}/access-logs`, { query: { page: params.page, pageSize: params.pageSize }, signal })}
        columns={columns}
        rowKey={(row) => row.id}
        searchable={false}
        syncUrl={false}
        defaultPageSize={10}
        empty={{ icon: <ScrollText />, title: t('people.documents.log.empty') }}
      />
    </Section>
  );
}
