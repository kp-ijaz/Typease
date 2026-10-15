'use client';

import * as React from 'react';
import { PageHeader, RequirePermission, Tabs, TabsContent, TabsList, TabsTrigger, useI18n } from '@typease/ui';
import { useUrlState } from '@/components/ops/common';
import type { NotificationChannel } from '@/components/ops/types';
import { ChannelsTab } from './channels-tab';
import { FailuresTab, LogTab } from './log-tab';
import { TemplatesTab } from './templates-tab';

export const CHANNELS: NotificationChannel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH'];
const TABS = ['channels', 'templates', 'log', 'failures'] as const;

/** Our wording for an event when the dictionary has it (both languages), else the API's own label. */
export function useEventLabel() {
  const { t, has } = useI18n();
  return React.useCallback(
    (eventKey: string, fallback?: string | null) => {
      const key = `ops.notify.events.${eventKey.replace(/[^A-Za-z0-9]/g, '_')}`;
      return has(key) ? t(key) : fallback || eventKey;
    },
    [t, has],
  );
}

export function NotificationSettingsPage() {
  return (
    <RequirePermission anyOf={['notification.manage']}>
      <NotificationSettings />
    </RequirePermission>
  );
}

/** Which messages go out through which channel, how they are worded, and what was actually delivered. */
function NotificationSettings() {
  const { t } = useI18n();
  const [tab, setTab] = useUrlState('tab', 'channels');
  const active = (TABS as readonly string[]).includes(tab) ? tab : 'channels';
  return (
    <>
      <PageHeader title={t('ops.notify.title')} description={t('ops.notify.description')} />
      <Tabs value={active} onValueChange={setTab}>
        <TabsList>
          {TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`ops.notify.tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="channels">
          <ChannelsTab />
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="log">
          <LogTab />
        </TabsContent>
        <TabsContent value="failures">
          <FailuresTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
