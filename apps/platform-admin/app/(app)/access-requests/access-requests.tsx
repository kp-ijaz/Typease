'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { Alert, Button, PageHeader, RequirePermission, useI18n, useSession } from '@typease/ui';
import { AccessTable } from '@/components/access-table';
import { RequestAccessDialog } from '@/components/request-access-dialog';
import { Segmented, useUrlState } from '@/components/shared';
import { TenantPicker } from '@/components/tenant-picker';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';

export function AccessRequests() {
  return (
    <RequirePermission anyOf={['platform.access.request']}>
      <AccessScreen />
    </RequirePermission>
  );
}

/**
 * Support access: requests of TypEase staff for time-boxed, scoped access to one centre's
 * data, and what the centre decided. Requests are made here and decided by the centre.
 */
function AccessScreen() {
  const { t } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const [requesting, setRequesting] = React.useState(false);
  const [centreId, setCentreId] = useUrlState('centreId', '');
  // People who may read the audit trail see everybody's requests by default; the API shows everyone else their own.
  const mayAll = session.hasPermission('platform.audit.read');
  const [who, setWho] = useUrlState('who', mayAll ? 'all' : 'mine');
  const centre = useQuery({ queryKey: keys.tenants.detail(centreId), queryFn: ({ signal }) => api.tenants.get(centreId, signal), enabled: !!centreId && session.hasPermission('platform.tenants.read'), staleTime: 60_000 });

  const request = (
    <Button variant="accent" onClick={() => setRequesting(true)}>
      <KeyRound aria-hidden="true" />
      {t('access.request.action')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('nav.access')} description={t('access.description')} action={request} />
      <Alert tone="info" className="mb-4" title={t('access.rule.title')}>
        {t('access.rule.text')}
      </Alert>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {mayAll ? (
          <Segmented
            label={t('access.filter.by')}
            value={who === 'mine' ? 'mine' : 'all'}
            onChange={setWho}
            options={[
              { value: 'all', label: t('access.filter.everyone') },
              { value: 'mine', label: t('access.filter.mine') },
            ]}
          />
        ) : null}
        <div className="w-full sm:w-80">
          <TenantPicker aria-label={t('pc.centre')} placeholder={t('desk.filters.allCentres')} value={centreId} selectedLabel={centre.data?.name} onChange={(id) => setCentreId(id)} />
        </div>
      </div>
      <AccessTable centreId={centreId || undefined} everyone={mayAll && who !== 'mine'} empty={{ title: t('access.emptyTitle'), description: t('access.emptyText'), action: request }} />
      <RequestAccessDialog open={requesting} onOpenChange={setRequesting} />
    </>
  );
}
