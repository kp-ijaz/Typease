'use client';

import * as React from 'react';
import { MapPinOff, Ticket } from 'lucide-react';
import { Button, Card, EmptyState, PageHeader, RequirePermission, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, useI18n } from '@typease/ui';
import { useUrlState } from '@/components/ops/common';
import { WorkBranchSelect, useWorkBranch } from '@/components/ops/work-branch';
import { QueueConsole } from './queue-console';
import { DisplayLinks } from './display-links';
import { IssueTokenDialog } from './issue-token-dialog';
import { QueueReport } from './queue-report';

export function QueuePage() {
  return (
    <RequirePermission anyOf={['queue.manage']}>
      <Queue />
    </RequirePermission>
  );
}

/** The walk-in queue of one branch: issue tokens, call and serve them, see how long people wait. */
function Queue() {
  const { t } = useI18n();
  const work = useWorkBranch();
  const [tab, setTab] = useUrlState('tab', 'console');
  const [issuing, setIssuing] = React.useState(false);
  const active = ['console', 'report', 'display'].includes(tab) ? tab : 'console';

  return (
    <>
      <PageHeader
        title={t('ops.queue.title')}
        description={t('ops.queue.description')}
        secondary={<WorkBranchSelect work={work} />}
        action={
          <Button variant="accent" onClick={() => setIssuing(true)} disabled={!work.branchId}>
            <Ticket aria-hidden="true" />
            {t('ops.queue.issue')}
          </Button>
        }
      />
      {work.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : !work.branchId ? (
        <Card>
          <EmptyState size="page" icon={<MapPinOff />} title={t('ops.common.noBranchTitle')} description={t('ops.common.noBranchText')} />
        </Card>
      ) : (
        <Tabs value={active} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="console">{t('ops.queue.tabs.console')}</TabsTrigger>
            <TabsTrigger value="report">{t('ops.queue.tabs.report')}</TabsTrigger>
            <TabsTrigger value="display">{t('ops.queue.tabs.display')}</TabsTrigger>
          </TabsList>
          <TabsContent value="console">
            <QueueConsole key={work.branchId} branchId={work.branchId} onIssue={() => setIssuing(true)} />
          </TabsContent>
          <TabsContent value="report">
            <QueueReport branchId={work.branchId} />
          </TabsContent>
          <TabsContent value="display">
            <DisplayLinks key={work.branchId} branchId={work.branchId} />
          </TabsContent>
        </Tabs>
      )}
      <IssueTokenDialog open={issuing} onOpenChange={setIssuing} branchId={work.branchId} />
    </>
  );
}
