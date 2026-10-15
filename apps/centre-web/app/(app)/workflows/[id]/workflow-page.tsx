'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, History, Pencil, Star } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { updateWorkflowSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField, Input, PageHeader,
  PageSkeleton, RequirePermission, Skeleton, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useApi,
  useErrorMessage, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { Loadable, OpsStatusBadge, Panel, useRun, useUrlState } from '@/components/ops/common';
import { WorkflowSteps } from '@/components/ops/workflow-steps';
import type { WorkflowDetail, WorkflowMeta, WorkflowVersionRow } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { DraftBuilder } from './draft-builder';

export function WorkflowPage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['workflow.manage']}>
      <WorkflowView id={id} />
    </RequirePermission>
  );
}

/** One workflow: its published version (read-only), the draft being edited, and the version history. */
function WorkflowView({ id }: { id: string }) {
  const { t, tn, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const router = useRouter();
  const describe = useErrorMessage();
  const { run, busy } = useRun();
  const [tab, setTab] = useUrlState('tab', 'published');
  const [renaming, setRenaming] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'archive' | null>(null);
  const [rollback, setRollback] = React.useState<WorkflowVersionRow | null>(null);

  const workflow = useQuery({ queryKey: opsKeys.workflows.detail(id), queryFn: () => api.client.get<WorkflowDetail>(`/workflows/${id}`), retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2 });
  const meta = useQuery({ queryKey: opsKeys.workflows.meta, queryFn: () => api.client.get<WorkflowMeta>('/workflows/builder-meta'), staleTime: 5 * 60_000 });
  const versions = useQuery({ queryKey: opsKeys.workflows.versions(id), queryFn: () => api.client.get<WorkflowVersionRow[]>(`/workflows/${id}/versions`), enabled: tab === 'versions' });
  const crumbs = [{ label: t('ops.workflows.title'), href: '/workflows' }];
  const invalidate = [opsKeys.workflows.all];

  if (workflow.isPending) return <PageSkeleton label={t('common.loading')} />;
  if (workflow.isError) {
    return (
      <>
        <PageHeader title={t('ops.workflows.builder.title')} breadcrumbs={crumbs} />
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={() => void workflow.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {describe(workflow.error)}
        </Alert>
      </>
    );
  }

  const data = workflow.data;
  const published = data.publishedVersion;
  const draft = data.draftVersion;
  const active = ['published', 'draft', 'versions'].includes(tab) ? tab : 'published';

  const startDraft = () =>
    run('draft', () => api.client.post(`/workflows/${id}/versions`, {}), {
      success: t('ops.workflows.builder.draftStarted'),
      description: t('ops.workflows.builder.draftStartedText'),
      invalidate,
    }).then((result) => {
      if (result !== undefined) setTab('draft');
    });

  return (
    <>
      <PageHeader
        title={data.name}
        breadcrumbs={crumbs}
        description={data.description ?? undefined}
        meta={
          <>
            {data.isDefault ? (
              <Badge tone="brand" icon={<Star />}>
                {t('ops.workflows.default')}
              </Badge>
            ) : null}
            {published ? <Badge tone="success">{t('ops.workflows.publishedVersion', { version: formatNumber(published.version) })}</Badge> : <Badge tone="neutral">{t('ops.workflows.notPublished')}</Badge>}
            {draft ? <Badge tone="warning">{t('ops.workflows.hasDraft')}</Badge> : null}
          </>
        }
        secondary={
          <>
            <Button variant="outline" onClick={() => setRenaming(true)}>
              <Pencil aria-hidden="true" />
              {t('ops.workflows.builder.rename')}
            </Button>
            {!data.isDefault && published ? (
              <Button
                variant="outline"
                loading={busy === 'default'}
                onClick={() => void run('default', () => api.client.post(`/workflows/${id}/set-default`), { success: t('ops.workflows.defaultSet'), description: t('ops.workflows.defaultSetDescription', { name: data.name }), invalidate })}
              >
                <Star aria-hidden="true" />
                {t('ops.workflows.setDefault')}
              </Button>
            ) : null}
            {!data.isDefault ? (
              <Button variant="destructive-outline" onClick={() => setConfirm('archive')}>
                <Archive aria-hidden="true" />
                {t('ops.workflows.archive')}
              </Button>
            ) : null}
          </>
        }
      />

      <Alert tone="info" className="mb-4" title={t('ops.workflows.complianceTitle')}>
        {t('ops.workflows.complianceText')}
      </Alert>

      <Tabs value={active} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="published">{t('ops.workflows.builder.tabPublished')}</TabsTrigger>
          <TabsTrigger value="draft">
            {t('ops.workflows.builder.tabDraft')}
            {draft ? <span aria-hidden="true" className="size-2 rounded-full bg-warning" /> : null}
          </TabsTrigger>
          <TabsTrigger value="versions">{t('ops.workflows.builder.tabVersions')}</TabsTrigger>
        </TabsList>

        <TabsContent value="published">
          {published ? (
            <Panel
              title={t('ops.workflows.builder.publishedTitle', { version: formatNumber(published.version) })}
              description={t('ops.workflows.builder.publishedText', { date: formatDateTime(published.publishedAt), services: tn('ops.workflows.usedBy', data.servicesUsing) })}
              action={
                draft ? (
                  <Button size="sm" variant="outline" onClick={() => setTab('draft')}>
                    {t('ops.workflows.continueDraft')}
                  </Button>
                ) : (
                  <Button size="sm" loading={busy === 'draft'} loadingText={t('common.loading')} onClick={() => void startDraft()}>
                    <Pencil aria-hidden="true" />
                    {t('ops.workflows.builder.startDraft')}
                  </Button>
                )
              }
            >
              {published.notes ? (
                <p className="mb-5 text-sm text-muted-foreground" dir="auto">
                  {published.notes}
                </p>
              ) : null}
              <WorkflowSteps steps={published.steps} roles={meta.data?.roles} className="max-w-3xl" />
            </Panel>
          ) : (
            <Card>
              <EmptyState
                icon={<History />}
                title={t('ops.workflows.builder.noPublishedTitle')}
                description={t(draft ? 'ops.workflows.builder.noPublishedTextDraft' : 'ops.workflows.builder.noPublishedText')}
                action={
                  draft ? (
                    <Button onClick={() => setTab('draft')}>{t('ops.workflows.continueDraft')}</Button>
                  ) : (
                    <Button loading={busy === 'draft'} onClick={() => void startDraft()}>
                      {t('ops.workflows.builder.startDraft')}
                    </Button>
                  )
                }
              />
            </Card>
          )}
        </TabsContent>

        <TabsContent value="draft">
          {draft ? (
            <Loadable query={meta} skeleton={<Skeleton className="h-96 w-full" />}>
              {(m) => <DraftBuilder key={draft.id} workflowId={id} draft={draft} meta={m} hasPublished={!!published} onPublished={() => setTab('published')} />}
            </Loadable>
          ) : (
            <Card>
              <EmptyState
                icon={<Pencil />}
                title={t('ops.workflows.builder.noDraftTitle')}
                description={t('ops.workflows.builder.noDraftText')}
                action={
                  <Button loading={busy === 'draft'} loadingText={t('common.loading')} onClick={() => void startDraft()}>
                    <Pencil aria-hidden="true" />
                    {t('ops.workflows.builder.startDraft')}
                  </Button>
                }
              />
            </Card>
          )}
        </TabsContent>

        <TabsContent value="versions">
          <Panel title={t('ops.workflows.builder.versionsTitle')} description={t('ops.workflows.builder.versionsText')} bodyClassName="px-0 pb-0">
            <Loadable query={versions} skeleton={<Skeleton className="mx-5 mb-5 h-32" />}>
              {(rows) => (
                <Table className="border-t">
                  <TableCaption>{t('ops.workflows.builder.versionsTitle')}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('ops.forms.columns.version')}</TableHead>
                      <TableHead>{t('ops.forms.columns.status')}</TableHead>
                      <TableHead>{t('ops.workflows.builder.columns.steps')}</TableHead>
                      <TableHead>{t('ops.workflows.builder.columns.cases')}</TableHead>
                      <TableHead>{t('ops.forms.columns.published')}</TableHead>
                      <TableHead>{t('ops.workflows.builder.columns.notes')}</TableHead>
                      <TableHead className="text-end">{t('common.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="tabular whitespace-nowrap font-medium">{t('ops.forms.versionNumber', { version: formatNumber(row.version) })}</TableCell>
                        <TableCell>
                          <OpsStatusBadge kind="version" status={row.status} />
                        </TableCell>
                        <TableCell className="tabular">{formatNumber(row.stepCount)}</TableCell>
                        <TableCell className="tabular">{formatNumber(row.casesUsing)}</TableCell>
                        <TableCell className="tabular whitespace-nowrap">{formatDateTime(row.publishedAt)}</TableCell>
                        <TableCell className="min-w-48 text-sm text-muted-foreground" dir="auto">
                          {row.notes}
                        </TableCell>
                        <TableCell className="text-end">
                          {row.status === 'ARCHIVED' && row.publishedAt ? (
                            <Button variant="subtle" size="sm" onClick={() => setRollback(row)}>
                              {t('ops.workflows.builder.rollback')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Loadable>
          </Panel>
        </TabsContent>
      </Tabs>

      <RenameDialog open={renaming} onOpenChange={setRenaming} workflow={data} />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('ops.workflows.archiveTitle', { name: data.name })}
        description={t('ops.workflows.archiveText')}
        confirmLabel={t('ops.workflows.archive')}
        onConfirm={async () => {
          await run('archive', () => api.client.post(`/workflows/${id}/archive`), { success: t('ops.workflows.archived'), invalidate, rethrow: true });
          router.push('/workflows');
        }}
      />
      <ConfirmDialog
        open={!!rollback}
        onOpenChange={(open) => !open && setRollback(null)}
        tone="default"
        title={t('ops.workflows.builder.rollbackTitle', { version: formatNumber(rollback?.version ?? 0) })}
        description={t('ops.workflows.builder.rollbackText')}
        confirmLabel={t('ops.workflows.builder.rollback')}
        onConfirm={async () => {
          await run('rollback', () => api.client.post(`/workflows/${id}/versions/${rollback!.id}/rollback`), { success: t('ops.workflows.builder.rolledBack'), invalidate, rethrow: true });
          setTab('published');
        }}
      />
    </>
  );
}

function RenameDialog({ open, onOpenChange, workflow }: { open: boolean; onOpenChange: (open: boolean) => void; workflow: WorkflowDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(updateWorkflowSchema, { emptyAs: 'null' });
  React.useEffect(() => {
    if (open) form.reset({ name: workflow.name, description: workflow.description ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.client.patch(`/workflows/${workflow.id}`, values);
            toasts.success(t('ops.workflows.builder.renamed'));
            await queryClient.invalidateQueries({ queryKey: opsKeys.workflows.all });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.workflows.builder.rename')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="name" label={t('ops.workflows.name')} required>
              {(field) => <Input {...field} dir="auto" autoComplete="off" />}
            </FormField>
            <FormField name="description" label={t('ops.workflows.descriptionField')} optional>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
