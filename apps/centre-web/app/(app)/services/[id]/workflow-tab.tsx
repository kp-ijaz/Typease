'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Select, Skeleton, useApi, useErrorMessage, useI18n, useSession, useToast } from '@typease/ui';
import { RoleSelect } from '@/components/pickers';
import { Field, Loadable, Panel, SwitchRow } from '@/components/ops/common';
import { WorkflowSteps } from '@/components/ops/workflow-steps';
import type { WorkflowDetail, WorkflowListItem } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import type { ServiceTabProps } from './service-editor';

const DEFAULT = '__default__';

/** Which workflow requests of this service follow, whether a reviewer must approve, and which staff group handles it. */
export function WorkflowTab({ service, editable }: ServiceTabProps) {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const [workflowId, setWorkflowId] = React.useState(service.workflowDefinitionId ?? DEFAULT);
  const [requiresApproval, setRequiresApproval] = React.useState(service.requiresApproval);
  const [staffGroup, setStaffGroup] = React.useState(service.staffGroupRoleKey ?? '');
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    setWorkflowId(service.workflowDefinitionId ?? DEFAULT);
    setRequiresApproval(service.requiresApproval);
    setStaffGroup(service.staffGroupRoleKey ?? '');
  }, [service.version, service.workflowDefinitionId, service.requiresApproval, service.staffGroupRoleKey]);

  // Reading workflows needs `workflow.manage` or `service.manage`; read-only roles see the service's own settings only.
  const canSeeWorkflows = session.hasAnyPermission(['workflow.manage', 'service.manage']);
  const workflows = useQuery({ queryKey: opsKeys.workflows.list(false), queryFn: () => api.client.get<WorkflowListItem[]>('/workflows'), enabled: canSeeWorkflows });
  const published = (workflows.data ?? []).filter((w) => w.publishedVersion || w.id === service.workflowDefinitionId);
  const centreDefault = (workflows.data ?? []).find((w) => w.isDefault);
  const effectiveId = workflowId === DEFAULT ? centreDefault?.id : workflowId;
  const effective = useQuery({
    queryKey: opsKeys.workflows.detail(effectiveId ?? ''),
    queryFn: () => api.client.get<WorkflowDetail>(`/workflows/${effectiveId}`),
    enabled: !!effectiveId && canSeeWorkflows,
  });

  const dirty = workflowId !== (service.workflowDefinitionId ?? DEFAULT) || requiresApproval !== service.requiresApproval || staffGroup !== (service.staffGroupRoleKey ?? '');

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await api.client.patch(`/services/${service.id}`, { workflowDefinitionId: workflowId === DEFAULT ? null : workflowId, requiresApproval, staffGroupRoleKey: staffGroup || null, version: service.version });
      toasts.success(t('ops.services.workflow.saved'));
      await queryClient.invalidateQueries({ queryKey: opsKeys.services.all });
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <Panel title={t('ops.services.workflow.title')} description={t('ops.services.workflow.description')}>
        <div className="space-y-6">
          <Field label={t('ops.services.workflow.definition')} hint={t('ops.services.workflow.definitionHint')}>
            {(p) => (
              <Select
                {...p}
                value={workflowId}
                onValueChange={setWorkflowId}
                disabled={!editable || workflows.isPending}
                options={[
                  { value: DEFAULT, label: centreDefault ? t('ops.services.workflow.centreDefaultNamed', { name: centreDefault.name }) : t('ops.services.workflow.centreDefault') },
                  ...published.map((w) => ({ value: w.id, label: w.name })),
                  // Without access to the list the assigned workflow is still named.
                  ...(service.workflowDefinition && !published.some((w) => w.id === service.workflowDefinition?.id) ? [{ value: service.workflowDefinition.id, label: service.workflowDefinition.name }] : []),
                ]}
              />
            )}
          </Field>
          {workflows.isError ? <Alert tone="danger">{describe(workflows.error)}</Alert> : null}

          <SwitchRow label={t('ops.services.workflow.requiresApproval')} description={t('ops.services.workflow.requiresApprovalHint')} checked={requiresApproval} onCheckedChange={setRequiresApproval} disabled={!editable} />

          <Field label={t('ops.services.workflow.staffGroup')} hint={t('ops.services.workflow.staffGroupHint')} optional>
            {(p) => (
              <div className="flex gap-2">
                <RoleSelect {...p} value={staffGroup || undefined} onChange={setStaffGroup} disabled={!editable} placeholder={t('ops.services.workflow.staffGroupNone')} />
                {staffGroup && editable ? (
                  <Button variant="outline" onClick={() => setStaffGroup('')}>
                    {t('common.clear')}
                  </Button>
                ) : null}
              </div>
            )}
          </Field>

          <Alert tone="info" title={t('ops.services.workflow.skillsTitle')} action={session.hasPermission('staff.read') ? <Button asChild size="sm" variant="outline"><Link href="/staff">{t('ops.services.workflow.openStaff')}</Link></Button> : undefined}>
            {t('ops.services.workflow.skillsText')}
          </Alert>

          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
          {editable ? (
            <div className="flex justify-end">
              <Button onClick={() => void save()} loading={saving} loadingText={t('common.saving')} disabled={!dirty}>
                {t('common.saveChanges')}
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        title={t('ops.services.workflow.stepsTitle')}
        description={effective.data ? effective.data.name : undefined}
        action={
          effectiveId && session.hasPermission('workflow.manage') ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/workflows/${effectiveId}`}>{t('ops.services.workflow.openWorkflow')}</Link>
            </Button>
          ) : undefined
        }
      >
        {!canSeeWorkflows ? (
          <p className="text-sm text-muted-foreground">{t('ops.services.workflow.noAccess')}</p>
        ) : effectiveId ? (
          <Loadable query={effective} skeleton={<Skeleton className="h-64 w-full" />}>
            {(workflow) => (workflow.publishedVersion ? <WorkflowSteps steps={workflow.publishedVersion.steps} /> : <p className="text-sm text-muted-foreground">{t('ops.services.workflow.notPublished')}</p>)}
          </Loadable>
        ) : (
          <p className="text-sm text-muted-foreground">{workflows.isPending ? t('common.loading') : t('ops.services.workflow.noDefault')}</p>
        )}
      </Panel>
    </div>
  );
}
