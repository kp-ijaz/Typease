'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FilePlus2, Pencil, Send, Trash2 } from 'lucide-react';
import type { FormSchema } from '@typease/types';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import {
  Alert, Button, Card, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState, Skeleton, Table, TableBody, TableCaption, TableCell,
  TableHead, TableHeader, TableRow, cn, useApi, useErrorMessage, useI18n, useToast,
} from '@typease/ui';
import { Loadable, OpsStatusBadge, Panel, useRun } from '@/components/ops/common';
import { FormBuilder, formProblems } from '@/components/ops/form-builder';
import { FormPreview } from '@/components/ops/form-preview';
import type { FormVersion, FormVersionRow } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import type { ServiceTabProps } from './service-editor';

const STARTER: FormSchema = { steps: [{ key: 'details', title: 'Details', titleAr: 'التفاصيل', fields: [] }] };

/**
 * The dynamic form of a service. One draft and one published version exist at most.
 * A published version is immutable (requests refer to the exact version that was
 * filled in): changes are made in a new draft and take effect when it is published.
 */
export function FormTab({ service, editable }: ServiceTabProps) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const { run, busy } = useRun();
  const [viewing, setViewing] = React.useState<FormVersionRow | null>(null);
  const [archiving, setArchiving] = React.useState(false);
  const { draft, published } = service.form;
  const versions = useQuery({ queryKey: opsKeys.services.forms(service.id), queryFn: () => api.client.get<FormVersionRow[]>(`/services/${service.id}/forms`) });
  const invalidate = [opsKeys.services.detail(service.id)];

  const startDraft = (schema?: FormSchema) =>
    run('draft', () => api.client.post(`/services/${service.id}/forms`, schema ? { schema } : {}), {
      success: t('ops.forms.draftStarted'),
      description: t(published ? 'ops.forms.draftStartedFromPublished' : 'ops.forms.draftStartedEmpty'),
      invalidate,
    });

  return (
    <div className="space-y-4">
      {draft ? (
        <DraftEditor key={draft.id} serviceId={service.id} formId={draft.id} version={draft.version} hasPublished={!!published} editable={editable} />
      ) : published ? (
        <Panel
          title={t('ops.forms.publishedTitle', { version: formatNumber(published.version) })}
          description={t('ops.forms.publishedDescription', { date: formatDateTime(published.publishedAt) })}
          action={
            editable ? (
              <>
                <Button variant="destructive-outline" size="sm" onClick={() => setArchiving(true)}>
                  {t('ops.forms.removeForm')}
                </Button>
                <Button size="sm" loading={busy === 'draft'} loadingText={t('common.loading')} onClick={() => void startDraft()}>
                  <Pencil aria-hidden="true" />
                  {t('ops.forms.editInDraft')}
                </Button>
              </>
            ) : undefined
          }
        >
          <Alert tone="info" className="mb-5">
            {t('ops.forms.immutableNote')}
          </Alert>
          <VersionPreview serviceId={service.id} formId={published.id} />
        </Panel>
      ) : (
        <Card>
          <EmptyState
            size="page"
            icon={<FilePlus2 />}
            title={t('ops.forms.emptyTitle')}
            description={t('ops.forms.emptyText')}
            action={
              editable ? (
                <Button variant="accent" loading={busy === 'draft'} loadingText={t('common.loading')} onClick={() => void startDraft(STARTER)}>
                  <FilePlus2 aria-hidden="true" />
                  {t('ops.forms.start')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      <Panel title={t('ops.forms.versionsTitle')} description={t('ops.forms.versionsDescription')} bodyClassName="px-0 pb-0">
        <Loadable query={versions} skeleton={<Skeleton className="mx-5 mb-5 h-24" />}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">{t('ops.forms.versionsEmpty')}</p>
            ) : (
              <Table className="border-t">
                <TableCaption>{t('ops.forms.versionsTitle')}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('ops.forms.columns.version')}</TableHead>
                    <TableHead>{t('ops.forms.columns.status')}</TableHead>
                    <TableHead>{t('ops.forms.columns.content')}</TableHead>
                    <TableHead>{t('ops.forms.columns.published')}</TableHead>
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
                      <TableCell className="whitespace-nowrap text-muted-foreground">{t('ops.forms.contentSummary', { steps: formatNumber(row.steps), fields: formatNumber(row.fields) })}</TableCell>
                      <TableCell className="tabular whitespace-nowrap">{formatDateTime(row.publishedAt)}</TableCell>
                      <TableCell className="text-end">
                        <Button variant="subtle" size="sm" onClick={() => setViewing(row)}>
                          <Eye aria-hidden="true" />
                          {t('ops.forms.view')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </Loadable>
      </Panel>

      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{viewing ? t('ops.forms.versionNumber', { version: formatNumber(viewing.version) }) : ''}</DialogTitle>
            <DialogDescription>{t('ops.forms.viewDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody>{viewing ? <VersionPreview serviceId={service.id} formId={viewing.id} /> : null}</DialogBody>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t('ops.forms.removeTitle')}
        description={t('ops.forms.removeText')}
        confirmLabel={t('ops.forms.removeForm')}
        onConfirm={async () => {
          await run('archive', () => api.client.post(`/services/${service.id}/forms/${published!.id}/archive`), { success: t('ops.forms.removed'), invalidate, rethrow: true });
        }}
      />
    </div>
  );
}

function LanguageToggle({ lang, onChange }: { lang: 'en' | 'ar'; onChange: (lang: 'en' | 'ar') => void }) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t('ops.forms.preview.language')} className="inline-flex rounded-md border bg-card p-0.5">
      {(['en', 'ar'] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => onChange(l)}
          className={cn('rounded-sm px-2.5 py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', lang === l ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {l === 'en' ? 'English' : 'العربية'}
        </button>
      ))}
    </div>
  );
}

/** A stored version (published or archived), read-only, as customers see it. */
function VersionPreview({ serviceId, formId }: { serviceId: string; formId: string }) {
  const api = useApi();
  const { locale } = useI18n();
  const [lang, setLang] = React.useState<'en' | 'ar'>(locale);
  const form = useQuery({ queryKey: opsKeys.services.form(serviceId, formId), queryFn: () => api.client.get<FormVersion>(`/services/${serviceId}/forms/${formId}`) });
  return (
    <Loadable query={form} skeleton={<Skeleton className="h-64 w-full" />}>
      {(data) => (
        <div className="mx-auto max-w-xl space-y-4">
          <div className="flex justify-end">
            <LanguageToggle lang={lang} onChange={setLang} />
          </div>
          <div className="rounded-lg border bg-background p-4 sm:p-5">
            <FormPreview key={lang} schema={data.schema} lang={lang} />
          </div>
        </div>
      )}
    </Loadable>
  );
}

/** The builder for the draft, with the live preview next to it. */
function DraftEditor({ serviceId, formId, version, hasPublished, editable }: { serviceId: string; formId: string; version: number; hasPublished: boolean; editable: boolean }) {
  const { t, locale, formatNumber } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { run } = useRun();
  const stored = useQuery({ queryKey: opsKeys.services.form(serviceId, formId), queryFn: () => api.client.get<FormVersion>(`/services/${serviceId}/forms/${formId}`), staleTime: Infinity });
  const [schema, setSchema] = React.useState<FormSchema | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState<'save' | 'publish' | null>(null);
  const [failure, setFailure] = React.useState<string[] | null>(null);
  const [confirm, setConfirm] = React.useState<'publish' | 'discard' | null>(null);
  const [lang, setLang] = React.useState<'en' | 'ar'>(locale);
  const [pane, setPane] = React.useState<'build' | 'preview'>('build');

  React.useEffect(() => {
    if (stored.data && !schema) setSchema(stored.data.schema?.steps?.length ? stored.data.schema : STARTER);
  }, [stored.data, schema]);

  // Leaving the page with unsaved changes asks first.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const problemCount = React.useMemo(() => (schema ? Object.values(formProblems(schema)).reduce((n, list) => n + list.length, 0) : 0), [schema]);
  const fieldCount = schema ? schema.steps.reduce((n, s) => n + s.fields.length, 0) : 0;

  const explain = (error: unknown): string[] => {
    const fields = Object.entries(fieldErrorsOf(error));
    if (isApiError(error) && fields.length) return fields.map(([path, message]) => (path ? `${path.replace(/^schema\./, '')}: ${message}` : message));
    return [describe(error)];
  };

  const save = async (): Promise<boolean> => {
    if (!schema) return false;
    setFailure(null);
    try {
      await api.client.put(`/services/${serviceId}/forms/${formId}`, { schema });
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: opsKeys.services.forms(serviceId) });
      return true;
    } catch (error) {
      setFailure(explain(error));
      return false;
    }
  };

  if (stored.isPending || (!schema && !stored.isError)) return <Skeleton className="h-96 w-full" />;
  if (stored.isError || !schema) {
    return (
      <Alert
        tone="danger"
        action={
          <Button size="sm" variant="outline" onClick={() => void stored.refetch()}>
            {t('common.retry')}
          </Button>
        }
      >
        {describe(stored.error)}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Panel
        title={t('ops.forms.draftTitle', { version: formatNumber(version) })}
        description={t(hasPublished ? 'ops.forms.draftDescriptionReplace' : 'ops.forms.draftDescriptionFirst')}
        action={
          editable ? (
            <>
              <Button variant="destructive-outline" size="sm" onClick={() => setConfirm('discard')}>
                <Trash2 aria-hidden="true" />
                {t('ops.forms.discard')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty}
                loading={saving === 'save'}
                loadingText={t('common.saving')}
                onClick={async () => {
                  setSaving('save');
                  if (await save()) toasts.success(t('ops.forms.draftSaved'));
                  setSaving(null);
                }}
              >
                {t('ops.forms.saveDraft')}
              </Button>
              <Button size="sm" disabled={fieldCount === 0 || problemCount > 0} onClick={() => setConfirm('publish')}>
                <Send aria-hidden="true" />
                {t('ops.forms.publish')}
              </Button>
            </>
          ) : undefined
        }
        bodyClassName="pt-3"
      >
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {problemCount > 0 ? t('ops.forms.statusProblems') : dirty ? t('ops.forms.statusUnsaved') : t('ops.forms.statusSaved')}
        </p>
        {failure ? (
          <Alert tone="danger" live className="mt-3" title={t('ops.forms.saveFailed')}>
            <ul className="list-disc space-y-0.5 ps-5">
              {failure.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </Panel>

      <div role="group" aria-label={t('ops.forms.paneLabel')} className="inline-flex rounded-md border bg-card p-0.5 xl:hidden">
        {(['build', 'preview'] as const).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={pane === p}
            onClick={() => setPane(p)}
            className={cn('rounded-sm px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', pane === p ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground')}
          >
            {t(p === 'build' ? 'ops.forms.paneBuild' : 'ops.forms.panePreview')}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className={cn(pane === 'build' ? 'block' : 'hidden', 'xl:block')}>
          <FormBuilder
            schema={schema}
            disabled={!editable}
            onChange={(next) => {
              setSchema(next);
              setDirty(true);
            }}
          />
        </div>
        <Card className={cn('p-4 sm:p-5 xl:sticky xl:top-20', pane === 'preview' ? 'block' : 'hidden', 'xl:block')}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-md font-semibold">{t('ops.forms.preview.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('ops.forms.preview.description')}</p>
            </div>
            <LanguageToggle lang={lang} onChange={setLang} />
          </div>
          <div className="rounded-lg border bg-background p-4">
            <FormPreview key={lang} schema={schema} lang={lang} />
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm === 'publish'}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone="default"
        title={t('ops.forms.publishTitle', { version: formatNumber(version) })}
        description={t(hasPublished ? 'ops.forms.publishTextReplace' : 'ops.forms.publishTextFirst')}
        confirmLabel={t('ops.forms.publish')}
        onConfirm={async () => {
          setSaving('publish');
          try {
            if (dirty && !(await save())) return;
            await api.client.post(`/services/${serviceId}/forms/${formId}/publish`);
            toasts.success(t('ops.forms.published'), t('ops.forms.publishedToast', { version: formatNumber(version) }));
            await queryClient.invalidateQueries({ queryKey: opsKeys.services.detail(serviceId) });
          } catch (error) {
            setFailure(explain(error));
          } finally {
            setSaving(null);
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('ops.forms.discardTitle')}
        description={t(hasPublished ? 'ops.forms.discardTextKeep' : 'ops.forms.discardTextNone')}
        confirmLabel={t('ops.forms.discard')}
        onConfirm={async () => {
          await run('discard', () => api.client.delete(`/services/${serviceId}/forms/${formId}`), { success: t('ops.forms.discarded'), invalidate: [opsKeys.services.detail(serviceId)], rethrow: true });
        }}
      />
    </div>
  );
}
