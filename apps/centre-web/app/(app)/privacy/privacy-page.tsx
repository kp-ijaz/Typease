'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Archive, Building2, CheckCircle2, FileLock2, Inbox, Scale, ShieldAlert, Trash2 } from 'lucide-react';
import { Alert, Card, CardContent, CardHeader, CardTitle, PageHeader, RequirePermission, Skeleton, StatCard, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, useApi, useI18n } from '@typease/ui';
import { LoadError, useActiveTabInView } from '@/components/adm/shared';
import type { PrivacyOverview } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { ConsentsTab } from './consents-tab';
import { IncidentsTab } from './incidents-tab';
import { ProcessorsTab } from './processors-tab';
import { RequestsTab } from './requests-tab';
import { RetentionTab } from './retention-tab';
import { usePrivacyLabels } from './labels';

const TABS = ['overview', 'requests', 'retention', 'consents', 'incidents', 'processors'] as const;
type Tab = (typeof TABS)[number];

export function PrivacyPage() {
  return (
    <RequirePermission anyOf={['privacy.manage']}>
      <Privacy />
    </RequirePermission>
  );
}

function Privacy() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const requested = useSearchParams().get('tab') as Tab | null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'overview';
  useActiveTabInView(tab);
  return (
    <>
      <PageHeader title={t('adm.privacy.title')} description={t('adm.privacy.description')} />
      <Alert tone="warning" className="mb-6" title={t('adm.privacy.notice.title')}>
        {t('adm.privacy.notice.text')}
      </Alert>
      <Tabs value={tab} onValueChange={(next) => router.replace(next === 'overview' ? pathname : `${pathname}?tab=${next}`, { scroll: false })}>
        <TabsList>
          {TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`adm.privacy.tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">{tab === 'overview' ? <Overview /> : null}</TabsContent>
        <TabsContent value="requests">{tab === 'requests' ? <RequestsTab /> : null}</TabsContent>
        <TabsContent value="retention">{tab === 'retention' ? <RetentionTab /> : null}</TabsContent>
        <TabsContent value="consents">{tab === 'consents' ? <ConsentsTab /> : null}</TabsContent>
        <TabsContent value="incidents">{tab === 'incidents' ? <IncidentsTab /> : null}</TabsContent>
        <TabsContent value="processors">{tab === 'processors' ? <ProcessorsTab /> : null}</TabsContent>
      </Tabs>
    </>
  );
}

function Overview() {
  const { t, formatNumber } = useI18n();
  const api = useApi();
  const labels = usePrivacyLabels();
  const overview = useQuery({ queryKey: admKeys.privacy.overview, queryFn: () => api.client.get<PrivacyOverview>('/privacy/overview') });

  if (overview.isPending) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skeleton key={i} className="h-[4.75rem]" />
        ))}
      </div>
    );
  }
  if (overview.isError) return <LoadError error={overview.error} onRetry={() => void overview.refetch()} />;
  const o = overview.data;
  const openIncidents = Object.entries(o.incidents.byStatus).reduce((sum, [status, n]) => (status === 'RESOLVED' ? sum : sum + n), 0);
  const n = (value: number) => formatNumber(value);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard label={t('adm.privacy.overview.openRequests')} value={n(o.dataSubjectRequests.open)} icon={<Inbox />} tone="info" href="/privacy?tab=requests" />
        <StatCard label={t('adm.privacy.overview.overdue')} value={n(o.dataSubjectRequests.overdue)} icon={<AlarmClock />} tone={o.dataSubjectRequests.overdue ? 'danger' : 'neutral'} href="/privacy?tab=requests&overdue=true" />
        <StatCard label={t('adm.privacy.overview.completed90')} value={n(o.dataSubjectRequests.completedLast90Days)} icon={<CheckCircle2 />} tone="success" href="/privacy?tab=requests&status=COMPLETED" />
        <StatCard label={t('adm.privacy.overview.openIncidents')} value={n(openIncidents)} icon={<ShieldAlert />} tone={openIncidents ? 'warning' : 'neutral'} href="/privacy?tab=incidents" />
        <StatCard label={t('adm.privacy.overview.policies')} value={n(o.retention.policiesInForce)} hint={t('adm.privacy.overview.policiesHint', { count: n(o.retention.policiesEnforcedAutomatically) })} icon={<Archive />} tone="neutral" href="/privacy?tab=retention" className="[&_.truncate]:whitespace-normal" />
        <StatCard label={t('adm.privacy.overview.legalHold')} value={n(o.retention.documentsOnLegalHold)} icon={<FileLock2 />} tone="neutral" />
        <StatCard label={t('adm.privacy.overview.awaitingPurge')} value={n(o.retention.deletedDocumentsAwaitingPurge)} icon={<Trash2 />} tone="neutral" />
        <StatCard label={t('adm.privacy.overview.vendorsPending')} value={n(o.processors.pendingReview)} hint={t('adm.privacy.overview.vendorsHint', { total: n(o.processors.total), crossBorder: n(o.processors.crossBorderUnapproved) })} icon={<Building2 />} tone={o.processors.pendingReview ? 'warning' : 'neutral'} href="/privacy?tab=processors" className="[&_.truncate]:whitespace-normal" />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('adm.privacy.overview.byType')}</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(o.dataSubjectRequests.openByType).length === 0 ? (
              <p className="text-base text-muted-foreground">{t('adm.privacy.overview.noOpen')}</p>
            ) : (
              <ul className="space-y-2">
                {Object.entries(o.dataSubjectRequests.openByType).map(([type, count]) => (
                  <li key={type} className="flex items-center justify-between gap-3 text-base">
                    <span>{labels.requestType(type)}</span>
                    <span className="tabular font-semibold">{n(count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>{t('adm.privacy.overview.consents')}</CardTitle>
          </CardHeader>
          {o.consents.length === 0 ? (
            <CardContent className="pt-0">
              <p className="text-base text-muted-foreground">{t('adm.privacy.consents.emptyText')}</p>
            </CardContent>
          ) : (
            <Table className="border-t">
              <TableCaption>{t('adm.privacy.overview.consents')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('adm.privacy.consents.purpose')}</TableHead>
                  <TableHead className="text-end">{t('adm.privacy.consents.granted')}</TableHead>
                  <TableHead className="text-end">{t('adm.privacy.consents.withdrawn')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.consents.map((c) => (
                  <TableRow key={c.purpose}>
                    <TableCell>{labels.purpose(c.purpose)}</TableCell>
                    <TableCell className="tabular text-end">{n(c.granted)}</TableCell>
                    <TableCell className="tabular text-end">{n(c.withdrawn)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Scale className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {/* The API sends this sentence in English only; the page says the same in the reader's language. */}
        <span>{t('adm.privacy.overview.disclaimer')}</span>
      </p>
    </div>
  );
}
