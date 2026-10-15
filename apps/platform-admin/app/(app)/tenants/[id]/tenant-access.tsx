'use client';

import * as React from 'react';
import { KeyRound } from 'lucide-react';
import { Alert, Button, useI18n } from '@typease/ui';
import { AccessTable } from '@/components/access-table';
import type { TenantDetail } from '@/lib/types';

/**
 * Support access to one centre: the only way TypEase staff reach a centre's data. Staff ask
 * with a reason, a scope and a duration; the centre's owner approves or denies; the access
 * ends by itself. This tab shows the requests and lets the requester withdraw them.
 */
export function TenantAccess({ tenant, onRequest }: { tenant: TenantDetail; onRequest: () => void }) {
  const { t } = useI18n();
  const request =
    tenant.status === 'ARCHIVED' ? undefined : (
      <Button variant="outline" onClick={onRequest}>
        <KeyRound aria-hidden="true" />
        {t('access.request.action')}
      </Button>
    );
  return (
    <div className="space-y-5">
      <Alert tone="info" title={t('access.rule.title')} action={request}>
        {t('access.rule.text')}
      </Alert>
      <AccessTable centreId={tenant.id} everyone embedded empty={{ title: t('access.emptyCentreTitle'), description: t('access.emptyCentreText') }} />
    </div>
  );
}
