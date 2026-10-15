'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Badge, PageHeader, RequirePermission, Tabs, TabsContent, TabsList, TabsTrigger, useApi, useI18n, useSession } from '@typease/ui';
import { useActiveTabInView } from '@/components/adm/shared';
import { admKeys } from '@/lib/keys/adm';
import { PlanTab } from './plan-tab';
import { PreferencesTab } from './preferences-tab';
import { ProfileTab } from './profile-tab';
import { SupportAccessTab } from './support-access-tab';

const TABS = ['profile', 'preferences', 'support', 'plan'] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  return (
    <RequirePermission anyOf={['settings.manage', 'support_access.decide']}>
      <Settings />
    </RequirePermission>
  );
}

function Settings() {
  const { t, formatNumber } = useI18n();
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const canSettings = session.hasPermission('settings.manage');
  const canSupport = session.hasPermission('support_access.decide');
  const search = useSearchParams();
  const requested = search.get('tab') as Tab | null;
  const fallback: Tab = canSettings ? 'profile' : 'support';
  // A tab the person may not open (a link from somebody else's notification) falls back to their first tab.
  const allowed: Record<Tab, boolean> = { profile: canSettings, preferences: canSettings, support: canSupport, plan: true };
  const tab = requested && TABS.includes(requested) && allowed[requested] ? requested : fallback;
  useActiveTabInView(tab);
  // The number of support-access requests waiting for a decision is shown on the tab.
  const pending = useQuery({
    queryKey: [...admKeys.supportAccess.all, 'pending-count'],
    queryFn: () => api.client.get<{ pending: number }>('/support-access', { query: { pageSize: 1 } }),
    enabled: canSupport,
    select: (page) => page.pending,
  });

  return (
    <>
      <PageHeader title={t('adm.settings.title')} description={t('adm.settings.description')} />
      <Tabs value={tab} onValueChange={(next) => router.replace(next === fallback ? pathname : `${pathname}?tab=${next}`, { scroll: false })}>
        <TabsList>
          {canSettings ? <TabsTrigger value="profile">{t('adm.settings.tabs.profile')}</TabsTrigger> : null}
          {canSettings ? <TabsTrigger value="preferences">{t('adm.settings.tabs.preferences')}</TabsTrigger> : null}
          {canSupport ? (
            <TabsTrigger value="support">
              {t('adm.settings.tabs.support')}
              {pending.data ? <Badge tone="warning">{formatNumber(pending.data)}</Badge> : null}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="plan">{t('adm.settings.tabs.plan')}</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">{tab === 'profile' && canSettings ? <ProfileTab /> : null}</TabsContent>
        <TabsContent value="preferences">{tab === 'preferences' && canSettings ? <PreferencesTab /> : null}</TabsContent>
        <TabsContent value="support">{tab === 'support' && canSupport ? <SupportAccessTab focusGrantId={search.get('grant')} /> : null}</TabsContent>
        <TabsContent value="plan">{tab === 'plan' ? <PlanTab /> : null}</TabsContent>
      </Tabs>
    </>
  );
}
