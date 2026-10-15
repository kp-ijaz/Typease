'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { Alert, Badge, Button, ConfirmDialog, PageHeader, PageSkeleton, Tabs, TabsContent, TabsList, TabsTrigger, useApi, useErrorMessage, useI18n, useSession } from '@typease/ui';
import { useRun, useUrlState } from '@/components/ops/common';
import type { ServiceDetail } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { BasicsTab } from './basics-tab';
import { ComplianceTab } from './compliance-tab';
import { FormTab } from './form-tab';
import { PricingTab } from './pricing-tab';
import { RequirementsTab } from './requirements-tab';
import { WorkflowTab } from './workflow-tab';

const TABS = ['basics', 'compliance', 'pricing', 'documents', 'form', 'workflow'] as const;

export interface ServiceTabProps {
  service: ServiceDetail;
  /** false for roles that may only read the catalogue, and for deleted services. */
  editable: boolean;
}

/** One service: everything that defines it, in six tabs. The active tab is in the URL (?tab=pricing). */
export function ServiceEditor({ id }: { id: string }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const session = useSession();
  const router = useRouter();
  const describe = useErrorMessage();
  const { run } = useRun();
  const [tab, setTab] = useUrlState('tab', 'basics');
  const [confirming, setConfirming] = React.useState(false);
  const service = useQuery({ queryKey: opsKeys.services.detail(id), queryFn: () => api.client.get<ServiceDetail>(`/services/${id}`), retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2 });
  const crumbs = [{ label: t('ops.services.title'), href: '/services' }];

  if (service.isPending) return <PageSkeleton label={t('common.loading')} />;
  if (service.isError) {
    return (
      <>
        <PageHeader title={t('ops.services.editor.title')} breadcrumbs={crumbs} />
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={() => void service.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {describe(service.error)}
        </Alert>
      </>
    );
  }

  const data = service.data;
  const deleted = !!data.deletedAt;
  const canManage = session.hasPermission('service.manage');
  const editable = canManage && !deleted;
  const active = (TABS as readonly string[]).includes(tab) ? tab : 'basics';

  return (
    <>
      <PageHeader
        title={pick(data.name, data.nameAr)}
        breadcrumbs={crumbs}
        description={
          <>
            <span className="ltr-value tabular">{data.code}</span> · {pick(data.category.name, data.category.nameAr)}
          </>
        }
        meta={
          <>
            {deleted ? <Badge tone="danger">{t('ops.services.flags.deleted')}</Badge> : <Badge tone={data.isActive ? 'success' : 'neutral'}>{t(data.isActive ? 'ops.services.flags.active' : 'ops.services.flags.inactive')}</Badge>}
            {data.isPublic ? <Badge tone="info">{t('ops.services.flags.public')}</Badge> : null}
            {data.onlineAvailable ? <Badge tone="brand">{t('ops.services.flags.online')}</Badge> : null}
          </>
        }
        secondary={
          canManage ? (
            deleted ? (
              <Button
                variant="outline"
                onClick={() => void run('restore', () => api.client.post(`/services/${id}/restore`), { success: t('ops.services.restored'), description: t('ops.services.restoredDescription'), invalidate: [opsKeys.services.all, opsKeys.categories.all] })}
              >
                <RotateCcw aria-hidden="true" />
                {t('ops.services.restore')}
              </Button>
            ) : (
              <Button variant="destructive-outline" onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden="true" />
                {t('ops.services.delete')}
              </Button>
            )
          ) : undefined
        }
      />

      {deleted ? (
        <Alert tone="warning" className="mb-4" title={t('ops.services.deletedTitle')}>
          {t('ops.services.deletedText')}
        </Alert>
      ) : !canManage ? (
        <Alert tone="info" className="mb-4">
          {t('ops.services.readOnly')}
        </Alert>
      ) : null}

      <Tabs value={active} onValueChange={setTab}>
        <TabsList>
          {TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`ops.services.tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="basics">
          <BasicsTab service={data} editable={editable} />
        </TabsContent>
        <TabsContent value="compliance">
          <ComplianceTab service={data} editable={editable} />
        </TabsContent>
        <TabsContent value="pricing">
          <PricingTab service={data} editable={editable} />
        </TabsContent>
        <TabsContent value="documents">
          <RequirementsTab service={data} editable={editable} />
        </TabsContent>
        <TabsContent value="form">
          <FormTab service={data} editable={editable} />
        </TabsContent>
        <TabsContent value="workflow">
          <WorkflowTab service={data} editable={editable} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('ops.services.deleteTitle', { name: data.name })}
        description={t('ops.services.deleteText')}
        confirmLabel={t('ops.services.delete')}
        onConfirm={async () => {
          await run('delete', () => api.client.delete(`/services/${id}`), { success: t('ops.services.deleted'), description: data.name, invalidate: [opsKeys.services.all, opsKeys.categories.all], rethrow: true });
          router.push('/services');
        }}
      />
    </>
  );
}
