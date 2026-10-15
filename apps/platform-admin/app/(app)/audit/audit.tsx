'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combobox, PageHeader, RequirePermission, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, cn, useI18n, useSession } from '@typease/ui';
import { AuditTable, SEVERITIES, SEVERITY_TONE, SecurityEventsTable, useEventTypeLabel } from '@/components/audit-table';
import { LoadError, useUrlState } from '@/components/shared';
import { TenantPicker } from '@/components/tenant-picker';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import { Incidents } from './incidents';
import { Processors } from './processors';

/** Event types the API can write (services/api: `audit.security(...)`); the list only feeds the filter. */
const EVENT_TYPES = [
  'PERMISSION_DENIED', 'REFRESH_TOKEN_REUSE', 'MFA_FAILED', 'MFA_ENABLED', 'MFA_DISABLED', 'MFA_RECOVERY_CODE_USED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'SUPPORT_ACCESS_REQUESTED',
  'SUPPORT_ACCESS_APPROVED', 'SUPPORT_ACCESS_DENIED', 'SUPPORT_ACCESS_ENTERED', 'SUPPORT_ACCESS_REVOKED', 'PLATFORM_STAFF_CREATED', 'PLATFORM_ROLE_CHANGED', 'PLATFORM_STAFF_DISABLED',
  'PLATFORM_STAFF_ENABLED', 'TENANT_SUSPENDED', 'TENANT_REACTIVATED', 'TENANT_APPROVED', 'TENANT_REJECTED', 'TENANT_ARCHIVED', 'TENANT_OFFBOARDING_SCHEDULED', 'TENANT_OFFBOARDING_CANCELLED',
  'TENANT_PURGE_FAILED', 'MALWARE_DETECTED', 'MALWARE_SCAN_FAILED', 'UPLOAD_CONTENT_MISMATCH', 'WEBHOOK_SIGNATURE_INVALID', 'WEBHOOK_AMOUNT_MISMATCH', 'WEBHOOK_UNMATCHED',
  'NOTIFICATION_DELIVERY_FAILED', 'NOTIFICATION_QUEUE_FAILED',
] as const;

export function AuditPage() {
  return (
    <RequirePermission anyOf={['platform.audit.read']}>
      <AuditScreen />
    </RequirePermission>
  );
}

function AuditScreen() {
  const { t } = useI18n();
  const [tab, setTab] = useUrlState('tab', 'log');
  const tabs = ['log', 'security', 'incidents', 'processors'];
  const current = tabs.includes(tab) ? tab : 'log';
  return (
    <>
      <PageHeader title={t('nav.audit')} description={t('audit.description')} />
      <Tabs value={current} onValueChange={setTab}>
        <TabsList>
          {tabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`audit.tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="log">
          {current === 'log' ? (
            <>
              <AuditTable />
              <p className="mt-3 text-sm text-muted-foreground">{t('audit.immutable')}</p>
            </>
          ) : null}
        </TabsContent>
        <TabsContent value="security">{current === 'security' ? <SecurityTab /> : null}</TabsContent>
        <TabsContent value="incidents">{current === 'incidents' ? <Incidents /> : null}</TabsContent>
        <TabsContent value="processors">{current === 'processors' ? <Processors /> : null}</TabsContent>
      </Tabs>
    </>
  );
}

function SecurityTab() {
  const { t, formatNumber, formatDate } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const typeLabel = useEventTypeLabel();
  const [type, setType] = useUrlState('type', '');
  const [centreId, setCentreId] = useUrlState('centreId', '');
  const summary = useQuery({ queryKey: keys.security.summary, queryFn: ({ signal }) => api.security.summary(signal), staleTime: 60_000 });
  const centre = useQuery({ queryKey: keys.tenants.detail(centreId), queryFn: ({ signal }) => api.tenants.get(centreId, signal), enabled: !!centreId && session.hasPermission('platform.tenants.read'), staleTime: 60_000 });
  const types = React.useMemo(() => [...new Set<string>([...EVENT_TYPES, ...(summary.data?.byType.map((row) => row.type) ?? [])])].map((value) => ({ value, label: typeLabel(value), keywords: [value] })).sort((a, b) => a.label.localeCompare(b.label)), [summary.data, typeLabel]);

  return (
    <div className="space-y-5">
      <section aria-label={t('audit.security.week')}>
        {summary.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : summary.isError ? (
          <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
        ) : (
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 className="text-md font-semibold text-foreground">{t('audit.security.week')}</h2>
              <p className="tabular text-sm text-muted-foreground">{`${formatDate(summary.data.from)} – ${formatDate(summary.data.to)}`}</p>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
              <div>
                <dt className="text-sm text-muted-foreground">{t('audit.security.total')}</dt>
                <dd className="tabular text-2xl font-semibold text-foreground">{formatNumber(summary.data.total)}</dd>
              </div>
              {SEVERITIES.map((severity) => {
                const count = summary.data.bySeverity[severity] ?? 0;
                const alarm = count > 0 && SEVERITY_TONE[severity] === 'danger';
                return (
                  <div key={severity}>
                    <dt className="text-sm text-muted-foreground">{t(`audit.security.severity.${severity}`)}</dt>
                    <dd className={cn('tabular text-2xl font-semibold', alarm ? 'text-destructive-text' : 'text-foreground')}>{formatNumber(count)}</dd>
                  </div>
                );
              })}
            </dl>
            {summary.data.byType.length ? (
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-sm text-muted-foreground">
                {summary.data.byType.slice(0, 6).map((row) => (
                  <li key={`${row.type}-${row.severity}`}>
                    <button type="button" className="rounded-sm hover:text-foreground hover:underline" onClick={() => setType(row.type)}>
                      {typeLabel(row.type)}
                    </button>{' '}
                    <span className="tabular font-medium text-foreground">{formatNumber(row.count)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <div>
        <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <Combobox aria-label={t('audit.security.event')} placeholder={t('audit.security.allEvents')} value={type} clearable options={types} onValueChange={(value) => setType(value)} />
          <TenantPicker aria-label={t('pc.centre')} placeholder={t('desk.filters.allCentres')} value={centreId} selectedLabel={centre.data?.name} onChange={(id) => setCentreId(id)} />
        </div>
        <SecurityEventsTable type={type || undefined} centreId={centreId || undefined} />
      </div>
    </div>
  );
}
