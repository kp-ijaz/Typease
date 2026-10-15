'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ExternalLink, MoreHorizontal, Plus, Star, Workflow } from 'lucide-react';
import { createWorkflowSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, Checkbox, ChoiceLabel, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, Form, FormError, FormField, Input, PageHeader, RequirePermission, Select, Skeleton, Textarea, cn, focusRing,
  useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { ListSkeleton, Loadable, SwitchRow, useRun, useUrlState } from '@/components/ops/common';
import type { WorkflowListItem, WorkflowTemplate } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

export function WorkflowsList() {
  return (
    <RequirePermission anyOf={['workflow.manage']}>
      <Workflows />
    </RequirePermission>
  );
}

function Workflows() {
  const { t, tn, formatDate, formatNumber } = useI18n();
  const api = useApi();
  const { run } = useRun();
  const [archived, setArchived] = useUrlState('archived', '');
  const [creating, setCreating] = React.useState<string | null>(null);
  const [archiving, setArchiving] = React.useState<WorkflowListItem | null>(null);
  const list = useQuery({ queryKey: opsKeys.workflows.list(!!archived), queryFn: () => api.client.get<WorkflowListItem[]>('/workflows', { query: { includeArchived: archived ? true : undefined } }) });
  const templates = useQuery({ queryKey: opsKeys.workflows.templates, queryFn: () => api.client.get<WorkflowTemplate[]>('/workflows/templates'), staleTime: 10 * 60_000 });
  const invalidate = [opsKeys.workflows.all];

  const newButton = (
    <Button variant="accent" onClick={() => setCreating(templates.data?.[0]?.key ?? 'standard')}>
      <Plus aria-hidden="true" />
      {t('ops.workflows.new')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('ops.workflows.title')} description={t('ops.workflows.description')} action={newButton} />
      <Alert tone="info" className="mb-4" title={t('ops.workflows.complianceTitle')}>
        {t('ops.workflows.complianceText')}
      </Alert>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
          <h2 className="text-md font-semibold">{t('ops.workflows.yours')}</h2>
          <SwitchRow label={t('ops.workflows.showArchived')} checked={!!archived} onCheckedChange={(on) => setArchived(on ? '1' : '')} />
        </div>
        <Loadable query={list} skeleton={<div className="p-5"><ListSkeleton rows={3} /></div>}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState icon={<Workflow />} title={t('ops.workflows.emptyTitle')} description={t('ops.workflows.emptyText')} action={newButton} />
            ) : (
              <ul className="divide-y">
                {rows.map((w) => (
                  <li key={w.id} className="grid grid-cols-1 gap-x-6 gap-y-2 px-5 py-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] md:items-center">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <Link href={`/workflows/${w.id}`} className={cn('rounded-sm font-medium text-secondary-text hover:underline', focusRing)}>
                          {w.name}
                        </Link>
                        {w.isDefault ? (
                          <Badge tone="brand" icon={<Star />}>
                            {t('ops.workflows.default')}
                          </Badge>
                        ) : null}
                        {w.archived ? <Badge tone="neutral">{t('ops.status.version.ARCHIVED')}</Badge> : null}
                        {w.draftVersion ? <Badge tone="warning">{t('ops.workflows.hasDraft')}</Badge> : null}
                      </p>
                      {w.description ? <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{w.description}</p> : null}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {w.publishedVersion ? (
                        <p>
                          <span className="font-medium text-foreground">{t('ops.workflows.publishedVersion', { version: formatNumber(w.publishedVersion.version) })}</span>
                          {' · '}
                          {tn('ops.workflows.steps', w.publishedVersion.stepCount)}
                          {w.publishedVersion.publishedAt ? ` · ${formatDate(w.publishedVersion.publishedAt)}` : ''}
                        </p>
                      ) : (
                        <p>{t('ops.workflows.notPublished')}</p>
                      )}
                      <p>{tn('ops.workflows.usedBy', w.servicesUsing)}</p>
                    </div>
                    <div className="flex items-center gap-1 md:justify-end">
                      <Button asChild variant="subtle" size="sm">
                        <Link href={`/workflows/${w.id}${w.draftVersion ? '?tab=draft' : ''}`}>{t(w.draftVersion ? 'ops.workflows.continueDraft' : 'common.open')}</Link>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${t('common.moreActions')}: ${w.name}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem asChild>
                            <Link href={`/workflows/${w.id}`}>
                              <ExternalLink aria-hidden="true" />
                              {t('common.open')}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={w.isDefault || !w.publishedVersion}
                            onSelect={() => void run(`default-${w.id}`, () => api.client.post(`/workflows/${w.id}/set-default`), { success: t('ops.workflows.defaultSet'), description: t('ops.workflows.defaultSetDescription', { name: w.name }), invalidate })}
                          >
                            <Star aria-hidden="true" />
                            {t('ops.workflows.setDefault')}
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive disabled={w.archived || w.isDefault} onSelect={() => setArchiving(w)}>
                            <Archive aria-hidden="true" />
                            {t('ops.workflows.archive')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </Card>

      <section aria-labelledby="wf-templates" className="mt-8">
        <h2 id="wf-templates" className="text-lg font-semibold">
          {t('ops.workflows.templatesTitle')}
        </h2>
        <p className="mt-1 text-base text-muted-foreground">{t('ops.workflows.templatesText')}</p>
        <div className="mt-4">
          <Loadable query={templates} skeleton={<Skeleton className="h-48 w-full" />}>
            {(items) => (
              <ul className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {items.map((template) => (
                  <li key={template.key}>
                    <Card className="flex h-full flex-col p-5">
                      <h3 className="text-md font-semibold">{template.name}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
                      <ol className="mt-3 flex flex-1 flex-wrap content-start gap-1.5">
                        {template.steps.map((step, i) => (
                          <li key={step.key}>
                            <Badge tone="neutral">
                              {formatNumber(i + 1)}. {t(`ops.workflows.stepTypes.${step.type}`)}
                            </Badge>
                          </li>
                        ))}
                      </ol>
                      <Button variant="outline" className="mt-4 self-start" onClick={() => setCreating(template.key)}>
                        {t('ops.workflows.useTemplate')}
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </div>
      </section>

      <NewWorkflowDialog templateKey={creating} templates={templates.data ?? []} onClose={() => setCreating(null)} />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={t('ops.workflows.archiveTitle', { name: archiving?.name ?? '' })}
        description={t('ops.workflows.archiveText')}
        confirmLabel={t('ops.workflows.archive')}
        onConfirm={async () => {
          await run('archive', () => api.client.post(`/workflows/${archiving!.id}/archive`), { success: t('ops.workflows.archived'), invalidate, rethrow: true });
        }}
      />
    </>
  );
}

const keyFromName = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .slice(0, 40);

/** A new workflow always starts from one of the templates; it opens as a draft to review. */
function NewWorkflowDialog({ templateKey, templates, onClose }: { templateKey: string | null; templates: WorkflowTemplate[]; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useZodForm(createWorkflowSchema, { defaultValues: { name: '', key: '', description: '', templateKey: 'standard', publish: false } });
  const keyTouched = React.useRef(false);

  React.useEffect(() => {
    if (templateKey) {
      keyTouched.current = false;
      form.reset({ name: '', key: '', description: '', templateKey: templateKey as 'standard', publish: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey]);

  return (
    <Dialog open={!!templateKey} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const created = await api.client.post<{ id: string; name: string; versionStatus: string }>('/workflows', values);
            toasts.success(t('ops.workflows.created'), t(created.versionStatus === 'DRAFT' ? 'ops.workflows.createdDraft' : 'ops.workflows.createdPublished', { name: created.name }));
            await queryClient.invalidateQueries({ queryKey: opsKeys.workflows.all });
            onClose();
            router.push(`/workflows/${created.id}${created.versionStatus === 'DRAFT' ? '?tab=draft' : ''}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.workflows.newTitle')}</DialogTitle>
            <DialogDescription>{t('ops.workflows.newText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="templateKey" label={t('ops.workflows.template')} required>
              {(field) => <Select {...field} onValueChange={field.onChange} options={templates.map((tpl) => ({ value: tpl.key, label: tpl.name }))} />}
            </FormField>
            <FormField name="name" label={t('ops.workflows.name')} required>
              {(field) => (
                <Input
                  {...field}
                  autoFocus
                  autoComplete="off"
                  dir="auto"
                  onChange={(e) => {
                    field.onChange(e);
                    if (!keyTouched.current) form.setValue('key', keyFromName(e.target.value), { shouldValidate: form.formState.isSubmitted });
                  }}
                />
              )}
            </FormField>
            <FormField name="key" label={t('ops.workflows.key')} required hint={t('ops.workflows.keyHint')}>
              {(field) => (
                <Input
                  {...field}
                  dir="ltr"
                  className="font-mono text-sm"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => {
                    keyTouched.current = true;
                    field.onChange(e);
                  }}
                />
              )}
            </FormField>
            <FormField name="description" label={t('ops.workflows.descriptionField')} optional>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <FormField name="publish" label={t('ops.workflows.publishNow')} hideLabel>
              {(field) => <ChoiceLabel htmlFor={field.id} control={<Checkbox id={field.id} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />} label={t('ops.workflows.publishNow')} description={t('ops.workflows.publishNowHint')} />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.workflows.create')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
