'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, History, Plus, Trash2 } from 'lucide-react';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import type { Rule } from '@typease/types';
import { createAutomationRuleSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, Combobox, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger, Input, PageHeader, PageSkeleton, RequirePermission, Switch, Textarea, localiseValidationMessage, useApi, useErrorMessage, useI18n, useToast,
} from '@typease/ui';
import { actionIcon, useAutomationLabels } from '@/components/ops/automation';
import { Field, LeaveGuard, MoveButtons, Panel, isPlanError, moveItem, useRun } from '@/components/ops/common';
import { RuleEditor, isEmptyRule } from '@/components/ops/rule-editor';
import type { AutomationMeta, AutomationProblem, AutomationRule, DryRun } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { problemsOf } from '../automations-list';
import { ACTION_FIELDS, ActionConfig, cleanActionConfig, defaultActionConfig } from './action-config';
import { DryRunResult } from './dry-run-result';

export function AutomationRulePage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['automation.manage']}>
      <RuleView id={id} />
    </RequirePermission>
  );
}

function RuleView({ id }: { id: string }) {
  const { t } = useI18n();
  const api = useApi();
  const describe = useErrorMessage();
  const isNew = id === 'new';
  const meta = useQuery({ queryKey: opsKeys.automations.meta, queryFn: () => api.client.get<AutomationMeta>('/automations/meta'), staleTime: 5 * 60_000 });
  const rule = useQuery({
    queryKey: opsKeys.automations.detail(id),
    queryFn: () => api.client.get<AutomationRule>(`/automations/${id}`),
    enabled: !isNew,
    retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2,
  });
  const crumbs = [{ label: t('ops.automations.title'), href: '/automations' }];

  if (meta.isPending || (!isNew && rule.isPending)) return <PageSkeleton label={t('common.loading')} />;
  const failed = meta.isError ? meta : rule.isError ? rule : null;
  if (failed || !meta.data) {
    return (
      <>
        <PageHeader title={t('ops.automations.editor.title')} breadcrumbs={crumbs} />
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={() => void failed?.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {describe(failed?.error)}
        </Alert>
      </>
    );
  }
  return <RuleForm key={isNew ? 'new' : id} meta={meta.data} initial={isNew ? null : rule.data ?? null} />;
}

// ---------------------------------------------------------------- the draft being edited

interface DraftAction {
  uid: string;
  type: string;
  config: Record<string, unknown>;
}
interface Draft {
  name: string;
  description: string;
  triggerEvent: string;
  conditions: Rule | null;
  actions: DraftAction[];
  maxRetries: number;
}

let counter = 0;
const nextUid = () => `action-${++counter}`;

const draftOf = (rule: AutomationRule | null): Draft =>
  rule
    ? {
        name: rule.name,
        description: rule.description ?? '',
        triggerEvent: rule.triggerEvent,
        conditions: isEmptyRule(rule.conditions) ? null : rule.conditions,
        actions: rule.actions.map((a) => ({ uid: nextUid(), type: a.type, config: a.config ?? {} })),
        maxRetries: rule.maxRetries,
      }
    : { name: '', description: '', triggerEvent: 'request.submitted', conditions: null, actions: [], maxRetries: 3 };

const payloadOf = (draft: Draft) => ({
  name: draft.name.trim(),
  description: draft.description.trim() || null,
  triggerEvent: draft.triggerEvent,
  conditions: draft.conditions ?? {},
  actions: draft.actions.map((a) => ({ type: a.type, config: cleanActionConfig(a.type, a.config) })),
  maxRetries: draft.maxRetries,
});

const problemMap = (problems: AutomationProblem[] | undefined) => Object.fromEntries((problems ?? []).map((p) => [p.path, p.message]));

/** JSON with sorted keys: two drafts are the same when they would send the same thing. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));

/**
 * One automation: when (the event), only if (conditions), then (ordered actions).
 * A new rule is saved switched off; switching on, the dry run and deleting work on the saved rule.
 */
function RuleForm({ meta, initial }: { meta: AutomationMeta; initial: AutomationRule | null }) {
  const i18n = useI18n();
  const { t, tn, formatNumber, formatRelative } = i18n;
  const api = useApi();
  const router = useRouter();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const labels = useAutomationLabels();
  const { run, busy } = useRun();
  const [saved, setSaved] = React.useState<AutomationRule | null>(initial);
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(initial));
  const [baseline, setBaseline] = React.useState(() => stable(payloadOf(draftOf(initial))));
  // A saved rule can still have problems that stop it from being switched on (no n8n connection, a role that was removed): they are shown on their fields.
  const [errors, setErrors] = React.useState<Record<string, string>>(() => problemMap(initial?.problems));
  const [failure, setFailure] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [dropped, setDropped] = React.useState(0);
  const [deleting, setDeleting] = React.useState(false);
  const [test, setTest] = React.useState<{ result: DryRun | null; message: string | null } | null>(null);

  const locked = !meta.available;
  const trigger = meta.triggers.find((x) => x.key === draft.triggerEvent);
  const facts = trigger?.facts ?? [];
  const dirty = stable(payloadOf(draft)) !== baseline;
  const crumbs = [{ label: t('ops.automations.title'), href: '/automations' }];

  const patch = (change: Partial<Draft>, clear?: string) => {
    setDraft((d) => ({ ...d, ...change }));
    if (clear) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== clear && !key.startsWith(`${clear}.`))));
  };

  /** Conditions about things the new event does not carry cannot be checked: they are removed, and the person is told. */
  const changeTrigger = (key: string) => {
    const next = meta.triggers.find((x) => x.key === key);
    if (!next) return;
    const known = new Set(next.facts.map((f) => f.key));
    const all = (draft.conditions?.all ?? []).filter((c) => known.has(c.fact));
    const any = (draft.conditions?.any ?? []).filter((c) => known.has(c.fact));
    const before = (draft.conditions?.all?.length ?? 0) + (draft.conditions?.any?.length ?? 0);
    setDropped(before - all.length - any.length);
    patch({ triggerEvent: key, conditions: all.length || any.length ? { ...(all.length ? { all } : {}), ...(any.length ? { any } : {}) } : null }, 'triggerEvent');
  };

  const setAction = (index: number, config: Record<string, unknown>) => patch({ actions: draft.actions.map((a, i) => (i === index ? { ...a, config } : a)) }, `actions.${index}`);
  const addAction = (type: string) => patch({ actions: [...draft.actions, { uid: nextUid(), type, config: defaultActionConfig(type, meta, trigger) }] }, 'actions');
  const fits = (type: string) => {
    const info = meta.actions.find((a) => a.type === type);
    return !(info?.needsRequest && trigger?.hasRequest === 'NEVER') && !(info?.needsCustomer && trigger?.hasCustomer === 'NEVER');
  };

  const takeError = (error: unknown, problemText = t('ops.automations.editor.fixFirst')) => {
    const problems = problemsOf(error);
    const fields = fieldErrorsOf(error);
    if (problems.length) setErrors(problemMap(problems));
    else if (Object.keys(fields).length) setErrors(Object.fromEntries(Object.entries(fields).map(([key, message]) => [key, localiseValidationMessage(message, i18n)])));
    setFailure(isPlanError(error) ? t('ops.automations.planText') : problems.length ? problemText : Object.keys(fields).length ? t('ops.automations.editor.fixFirst') : describe(error));
  };

  const adopt = (rule: AutomationRule) => {
    const next = draftOf(rule);
    setSaved(rule);
    setDraft(next);
    setBaseline(stable(payloadOf(next)));
    setErrors(problemMap(rule.problems));
    queryClient.setQueryData(opsKeys.automations.detail(rule.id), rule);
    void queryClient.invalidateQueries({ queryKey: opsKeys.automations.all, refetchType: 'none' });
  };

  const save = async () => {
    setFailure(null);
    // The same schema the API uses, so most mistakes are shown before anything is sent.
    const parsed = createAutomationRuleSchema.safeParse(payloadOf(draft));
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) found[issue.path.join('.')] ??= localiseValidationMessage(issue.message, i18n);
      setErrors(found);
      setFailure(t('ops.automations.editor.fixFirst'));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      // New rules are created switched off; switching on is its own step (it checks that the rule can run).
      const body: Partial<typeof parsed.data> = { ...parsed.data };
      delete body.isEnabled;
      if (saved) {
        adopt(await api.client.patch<AutomationRule>(`/automations/${saved.id}`, body));
        toasts.success(t('ops.automations.editor.saved'));
      } else {
        const created = await api.client.post<AutomationRule>('/automations', body);
        adopt(created);
        toasts.success(t('ops.automations.editor.created'), t('ops.automations.createdFromTemplateText'));
        router.replace(`/automations/${created.id}`);
      }
    } catch (error) {
      takeError(error);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (on: boolean) =>
    saved
      ? run('toggle', () => api.client.post<AutomationRule>(`/automations/${saved.id}/${on ? 'enable' : 'disable'}`), {
          success: t(on ? 'ops.automations.enabled' : 'ops.automations.disabled'),
          onError: (error) => {
            if (!problemsOf(error).length && !isPlanError(error)) return false;
            takeError(error, t('ops.automations.editor.hasProblems'));
            return true;
          },
        }).then((rule) => {
          if (rule) {
            setFailure(null);
            setSaved((s) => (s ? { ...s, ...rule, stats: s.stats } : rule));
            queryClient.setQueryData(opsKeys.automations.detail(rule.id), (old: AutomationRule | undefined) => ({ ...old, ...rule }));
            void queryClient.invalidateQueries({ queryKey: opsKeys.automations.all, refetchType: 'none' });
          }
        })
      : undefined;

  const dryRun = async () => {
    if (!saved) return;
    const outcome = await run('test', () => api.client.post<DryRun>(`/automations/${saved.id}/test`, {}), {
      onError: (error) => {
        if (!isApiError(error) || error.code !== 'NO_RECENT_EVENT') return false;
        setTest({ result: null, message: t('ops.automations.dryRun.noEvent', { trigger: labels.trigger(saved.triggerEvent, saved.triggerLabel) }) });
        return true;
      },
    });
    if (outcome) setTest({ result: outcome, message: null });
  };

  const errorList = (match: (key: string) => boolean) => Object.entries(errors).filter(([key]) => match(key));
  const conditionErrors = errorList((key) => key === 'conditions' || key.startsWith('conditions.'));
  const otherErrors = errorList((key) => !['name', 'description', 'triggerEvent', 'maxRetries', 'actions'].includes(key) && !key.startsWith('conditions') && !key.startsWith('actions.'));
  const actionProblems = (index: number, type: string) => {
    const prefix = `actions.${index}`;
    const fields = (ACTION_FIELDS[type] ?? []).map((f) => `${prefix}.config.${f}`);
    return errorList((key) => (key === prefix || key.startsWith(`${prefix}.`)) && !fields.includes(key));
  };

  const saveButton = (
    <Button variant="accent" disabled={locked || (!!saved && !dirty)} loading={saving} loadingText={t('common.saving')} onClick={() => void save()}>
      {t(saved ? 'common.saveChanges' : 'ops.automations.editor.create')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={saved ? saved.name : t('ops.automations.editor.newTitle')}
        description={t('ops.automations.editor.description')}
        breadcrumbs={crumbs}
        meta={saved ? <Badge tone={saved.isEnabled ? 'success' : 'neutral'}>{t(saved.isEnabled ? 'ops.common.enabled' : 'ops.common.disabled')}</Badge> : undefined}
        action={saveButton}
        secondary={
          saved ? (
            <Button variant="outline" disabled={dirty} loading={busy === 'test'} loadingText={t('common.loading')} onClick={() => void dryRun()} title={dirty ? t('ops.automations.editor.saveFirst') : undefined}>
              <FlaskConical aria-hidden="true" />
              {t('ops.automations.dryRun.button')}
            </Button>
          ) : undefined
        }
      />

      {locked ? (
        <Alert
          tone="warning"
          title={t('ops.common.planTitle')}
          className="mb-4"
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/subscription">{t('ops.common.openSubscription')}</Link>
            </Button>
          }
        >
          {t('ops.automations.planText')}
        </Alert>
      ) : null}
      {failure ? (
        <Alert tone="danger" live className="mb-4">
          {failure}
          {otherErrors.length ? (
            <ul className="mt-1 list-disc ps-5" dir="auto">
              {otherErrors.map(([key, message]) => (
                <li key={key}>{message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-4">
          <Panel title={t('ops.automations.editor.basics')}>
            <div className="space-y-4">
              <Field label={t('ops.automations.editor.name')} required error={errors.name}>
                {(p) => <Input {...p} dir="auto" maxLength={120} autoComplete="off" value={draft.name} onChange={(e) => patch({ name: e.target.value }, 'name')} />}
              </Field>
              <Field label={t('ops.automations.editor.descriptionField')} optional error={errors.description}>
                {(p) => <Textarea {...p} rows={2} dir="auto" maxLength={500} value={draft.description} onChange={(e) => patch({ description: e.target.value }, 'description')} />}
              </Field>
            </div>
          </Panel>

          <Panel title={t('ops.automations.editor.when')} description={t('ops.automations.editor.whenText')}>
            <div className="space-y-4">
              <Field label={t('ops.automations.editor.trigger')} required error={errors.triggerEvent}>
                {(p) => (
                  <Combobox
                    {...p}
                    value={draft.triggerEvent}
                    onValueChange={(key) => key && changeTrigger(key)}
                    options={meta.triggers.map((x) => ({ value: x.key, label: labels.trigger(x.key, x.label), keywords: [x.key, x.label] }))}
                    searchPlaceholder={t('ops.automations.editor.triggerSearch')}
                  />
                )}
              </Field>
              {dropped > 0 ? <Alert tone="warning">{tn('ops.automations.editor.conditionsDropped', dropped)}</Alert> : null}
              {trigger?.variables.length ? (
                <details className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <summary className="cursor-pointer font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('ops.automations.editor.variables')}</summary>
                  <p className="mt-1 text-muted-foreground">{t('ops.automations.editor.variablesText')}</p>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
                    {trigger.variables.map((v) => (
                      <React.Fragment key={v.key}>
                        <dt className="ltr-value font-mono text-xs leading-6 text-foreground">{`{{${v.key}}}`}</dt>
                        <dd className="text-muted-foreground">{labels.variable(v.key, v.description)}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </details>
              ) : null}
            </div>
          </Panel>

          <Panel title={t('ops.automations.editor.conditions')} description={t('ops.automations.editor.conditionsText')}>
            {conditionErrors.length ? (
              <Alert tone="danger" className="mb-3">
                <ul dir="auto">
                  {conditionErrors.map(([key, message]) => (
                    <li key={key}>{message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <RuleEditor
              value={draft.conditions}
              onChange={(conditions) => patch({ conditions }, 'conditions')}
              facts={facts}
              operators={meta.operators}
              maxPerGroup={meta.limits.maxConditionsPerGroup}
              emptyText={t('ops.automations.editor.conditionsEmpty')}
            />
          </Panel>

          <Panel
            title={t('ops.automations.editor.then')}
            description={t('ops.automations.editor.thenText')}
            action={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={draft.actions.length >= meta.limits.maxActions}>
                    <Plus aria-hidden="true" />
                    {t('ops.automations.editor.addAction')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {meta.actions.map((a) => (
                    <DropdownMenuItem key={a.type} disabled={!fits(a.type)} onSelect={() => addAction(a.type)}>
                      {actionIcon(a.type)}
                      {labels.action(a.type, a.label)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            {errors.actions ? (
              <Alert tone="danger" className="mb-3">
                {errors.actions}
              </Alert>
            ) : null}
            {draft.actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('ops.automations.editor.noActions')}</p>
            ) : (
              <ol className="space-y-4">
                {draft.actions.map((action, index) => {
                  const name = labels.action(action.type, meta.actions.find((a) => a.type === action.type)?.label);
                  const problems = actionProblems(index, action.type);
                  return (
                    <li key={action.uid} className="rounded-lg border" data-action={action.type}>
                      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                        <span className="flex min-w-0 flex-1 items-center gap-2 font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                          {actionIcon(action.type)}
                          <span className="truncate">
                            {formatNumber(index + 1)}. {name}
                          </span>
                        </span>
                        <MoveButtons index={index} count={draft.actions.length} name={name} onMove={(from, to) => patch({ actions: moveItem(draft.actions, from, to) }, 'actions')} />
                        <Button variant="ghost" size="icon-sm" aria-label={t('ops.automations.editor.removeAction', { name })} title={t('ops.automations.editor.removeAction', { name })} onClick={() => patch({ actions: draft.actions.filter((_, i) => i !== index) }, 'actions')}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                      <div className="space-y-4 p-4">
                        {fits(action.type) ? null : <Alert tone="warning">{t('ops.automations.editor.doesNotFit')}</Alert>}
                        {problems.length ? (
                          <Alert tone="danger">
                            <ul dir="auto">
                              {problems.map(([key, message]) => (
                                <li key={key}>{message}</li>
                              ))}
                            </ul>
                          </Alert>
                        ) : null}
                        <ActionConfig type={action.type} config={action.config} onChange={(config) => setAction(index, config)} error={(field) => errors[`actions.${index}.config.${field}`]} meta={meta} trigger={trigger} />
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>

          <Panel title={t('ops.automations.editor.failures')} description={t('ops.automations.editor.failuresText')}>
            <Field label={t('ops.automations.editor.maxRetries')} error={errors.maxRetries} hint={t('ops.automations.editor.maxRetriesHint', { max: formatNumber(meta.limits.maxRetries) })} className="max-w-56">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  dir="ltr"
                  className="tabular"
                  min={0}
                  max={meta.limits.maxRetries}
                  value={Number.isFinite(draft.maxRetries) ? draft.maxRetries : ''}
                  onChange={(e) => patch({ maxRetries: e.target.value === '' ? Number.NaN : Math.trunc(Number(e.target.value)) }, 'maxRetries')}
                />
              )}
            </Field>
          </Panel>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {dirty && saved ? <p className="text-sm text-muted-foreground">{t('ops.automations.editor.unsaved')}</p> : null}
            {saveButton}
          </div>
        </div>

        <aside className="order-first space-y-4 xl:order-none">
          <Card className="space-y-3 p-5">
            <h2 className="text-md font-semibold">{t('ops.common.status')}</h2>
            {saved ? (
              <>
                <label className="flex items-center justify-between gap-3">
                  <span className="text-base font-medium">{t(saved.isEnabled ? 'ops.automations.editor.isOn' : 'ops.automations.editor.isOff')}</span>
                  <Switch checked={saved.isEnabled} disabled={busy !== null || (dirty && !saved.isEnabled) || (locked && !saved.isEnabled)} onCheckedChange={(on) => void toggle(on)} aria-label={t('ops.automations.switchLabel', { name: saved.name })} />
                </label>
                <p className="text-sm text-muted-foreground">{t(dirty && !saved.isEnabled ? 'ops.automations.editor.saveFirst' : saved.isEnabled ? 'ops.automations.editor.isOnText' : 'ops.automations.editor.isOffText')}</p>
                {!saved.isEnabled && saved.problems?.length ? <Alert tone="warning">{t('ops.automations.editor.hasProblems')}</Alert> : null}
                {saved.stats ? (
                  <p className="border-t pt-3 text-sm text-muted-foreground">
                    {saved.stats.total > 0 ? tn('ops.automations.runs', saved.stats.total) : t('ops.automations.neverRan')}
                    {saved.stats.lastExecutionAt ? ` · ${t('ops.automations.lastRun', { when: formatRelative(saved.stats.lastExecutionAt) })}` : ''}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/automations/executions?ruleId=${saved.id}`}>
                      <History aria-hidden="true" />
                      {t('ops.automations.log.title')}
                    </Link>
                  </Button>
                  <Button variant="destructive-outline" size="sm" onClick={() => setDeleting(true)}>
                    <Trash2 aria-hidden="true" />
                    {t('common.delete')}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('ops.automations.editor.newText')}</p>
            )}
          </Card>
          <Card className="space-y-2 p-5">
            <h2 className="text-md font-semibold">{t('ops.automations.editor.safetyTitle')}</h2>
            <ul className="list-disc space-y-1.5 ps-5 text-sm text-muted-foreground">
              <li>{t('ops.automations.editor.safety1')}</li>
              <li>{t('ops.automations.editor.safety2')}</li>
              <li>{t('ops.automations.editor.safety3')}</li>
            </ul>
          </Card>
        </aside>
      </div>

      <LeaveGuard when={dirty && !saving} />

      <Dialog open={!!test} onOpenChange={(open) => !open && setTest(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t('ops.automations.dryRun.title')}</DialogTitle>
            <DialogDescription>{t('ops.automations.dryRun.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody>{test?.result ? <DryRunResult result={test.result} facts={facts} /> : <Alert tone="info">{test?.message}</Alert>}</DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTest(null)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('ops.automations.deleteTitle', { name: saved?.name ?? '' })}
        description={t('ops.automations.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          await run('delete', () => api.client.delete(`/automations/${saved!.id}`), { success: t('ops.automations.deleted'), rethrow: true });
          // The list is read again when it opens; this page's own read must not be repeated (the rule is gone).
          void queryClient.invalidateQueries({ queryKey: opsKeys.automations.all, refetchType: 'none' });
          router.push('/automations');
        }}
      />
    </>
  );
}
