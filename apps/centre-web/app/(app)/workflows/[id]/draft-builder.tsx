'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Clock, GitBranch, GripVertical, ListChecks, Plus, Send, Trash2, UserRound } from 'lucide-react';
import type { Rule } from '@typease/types';
import { isApiError } from '@typease/api-client';
import { WORKFLOW_LIMITS } from '@typease/validation';
import { Alert, Badge, Button, Card, ConfirmDialog, Input, Select, Textarea, cn, useApi, useErrorMessage, useI18n, useToast } from '@typease/ui';
import { DocumentTypePicker } from '@/components/pickers';
import { Field, LeaveGuard, MoveButtons, Panel, SwitchRow, moveItem, useRun } from '@/components/ops/common';
import { RuleEditor } from '@/components/ops/rule-editor';
import { WORKFLOW_FACT_LIST, useStepFacts } from '@/components/ops/workflow-steps';
import type { WorkflowMeta, WorkflowProblem, WorkflowStep, WorkflowStepType, WorkflowVersion } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const NONE = '__none__';
/** Steps that wait for a person: they have someone who acts, a time limit and an escalation. */
const WAITING: WorkflowStepType[] = ['CUSTOMER_FORM', 'DOCUMENT_UPLOAD', 'STAFF_VERIFICATION', 'QUOTATION', 'CUSTOMER_APPROVAL', 'PAYMENT', 'STAFF_TASK', 'INTERNAL_APPROVAL', 'EXTERNAL_PROCESSING', 'COMPLETION'];
/** An approval that is rejected goes back to an earlier step of this type. */
const REJECT_TARGET: Partial<Record<WorkflowStepType, WorkflowStepType>> = { INTERNAL_APPROVAL: 'STAFF_TASK', CUSTOMER_APPROVAL: 'QUOTATION' };

interface EditStep extends WorkflowStep {
  /** Stable identity while editing (keys can be renamed). */
  uid: string;
}
let counter = 0;
const withUid = (step: WorkflowStep): EditStep => ({ ...step, uid: `s${++counter}` });
/** Exactly the fields the API accepts for a step. */
const toBody = ({ key, name, nameAr, type, config, conditions, branches, nextStepKey, onRejectStepKey, assigneeRoleKey, timeoutHours, escalateToRoleKey, customerVisible }: EditStep) => ({
  key, name, nameAr: nameAr || null, type, config: config ?? {}, conditions: conditions ?? null, branches: type === 'CONDITIONAL_BRANCH' ? branches ?? [] : null,
  nextStepKey: nextStepKey || null, onRejectStepKey: onRejectStepKey || null, assigneeRoleKey: assigneeRoleKey || null, timeoutHours: timeoutHours ?? null, escalateToRoleKey: escalateToRoleKey || null, customerVisible,
});

/**
 * The builder for a DRAFT version: an ordered list of steps (move with the arrows or drag the handle),
 * an editor per step, the API's validation shown on the step it concerns, save, publish and discard.
 */
export function DraftBuilder({ workflowId, draft, meta, hasPublished, onPublished }: { workflowId: string; draft: WorkflowVersion; meta: WorkflowMeta; hasPublished: boolean; onPublished: () => void }) {
  const { t, pick, formatNumber } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { run } = useRun();
  const [steps, setSteps] = React.useState<EditStep[]>(() => draft.steps.map(withUid));
  const [notes, setNotes] = React.useState(draft.notes ?? '');
  const [dirty, setDirty] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<WorkflowProblem[] | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState<'check' | 'save' | 'publish' | null>(null);
  const [confirm, setConfirm] = React.useState<'publish' | 'discard' | null>(null);
  const [newType, setNewType] = React.useState<WorkflowStepType>('STAFF_TASK');
  const dragging = React.useRef<number | null>(null);
  const [dropAt, setDropAt] = React.useState<number | null>(null);
  const stepFacts = useStepFacts(meta.roles);

  const change = (next: EditStep[]) => {
    setSteps(next);
    setDirty(true);
  };
  const body = () => ({ steps: steps.map(toBody) });

  /** Replaces a step; a renamed key is carried into every reference to it. */
  const setStep = (uid: string, patch: Partial<EditStep>) => {
    const previous = steps.find((s) => s.uid === uid);
    if (!previous) return;
    const renamed = patch.key !== undefined && patch.key !== previous.key;
    change(
      steps.map((s) => {
        if (s.uid === uid) return { ...s, ...patch };
        if (!renamed) return s;
        return {
          ...s,
          nextStepKey: s.nextStepKey === previous.key ? patch.key! : s.nextStepKey,
          onRejectStepKey: s.onRejectStepKey === previous.key ? patch.key! : s.onRejectStepKey,
          branches: s.branches?.map((b) => (b.goTo === previous.key ? { ...b, goTo: patch.key! } : b)) ?? s.branches,
        };
      }),
    );
  };

  const addStep = () => {
    const base = newType.toLowerCase().replace(/_/g, '-');
    const taken = new Set(steps.map((s) => s.key));
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    const label = meta.stepTypes.find((s) => s.type === newType)?.label ?? newType;
    const step = withUid({
      key, name: label, nameAr: null, type: newType, config: {}, conditions: null, branches: newType === 'CONDITIONAL_BRANCH' ? [] : null, nextStepKey: null, onRejectStepKey: null,
      assigneeRoleKey: null, timeoutHours: null, escalateToRoleKey: null, customerVisible: !['CONDITIONAL_BRANCH', 'INTERNAL_APPROVAL'].includes(newType),
    });
    // A workflow ends with its Completion step: new steps go before it.
    const last = steps[steps.length - 1];
    const next = last?.type === 'COMPLETION' && newType !== 'COMPLETION' ? [...steps.slice(0, -1), step, last] : [...steps, step];
    change(next);
    setOpen(step.uid);
  };

  const removeStep = (uid: string) => {
    const removed = steps.find((s) => s.uid === uid);
    if (!removed) return;
    change(
      steps
        .filter((s) => s.uid !== uid)
        .map((s) => ({
          ...s,
          nextStepKey: s.nextStepKey === removed.key ? null : s.nextStepKey,
          onRejectStepKey: s.onRejectStepKey === removed.key ? null : s.onRejectStepKey,
          branches: s.branches?.filter((b) => b.goTo !== removed.key) ?? s.branches,
        })),
    );
  };

  /** Problems of a failed save / publish: WORKFLOW_INVALID lists all of them, each with the step it concerns. */
  const take = (error: unknown) => {
    if (isApiError(error) && error.code === 'WORKFLOW_INVALID' && Array.isArray(error.details)) {
      setProblems(error.details as WorkflowProblem[]);
      setFailure(null);
      const first = (error.details as WorkflowProblem[]).find((p) => p.stepKey);
      if (first) setOpen(steps.find((s) => s.key === first.stepKey)?.uid ?? null);
    } else if (isApiError(error) && error.code === 'VALIDATION_FAILED' && Array.isArray(error.details)) {
      // Shape errors come with a path such as "steps.3.name".
      const list = (error.details as Array<{ path?: string; message?: string }>).map((d) => {
        const m = /^steps\.(\d+)\.?(.*)$/.exec(d.path ?? '');
        return { code: 'VALIDATION_FAILED', stepKey: m ? steps[Number(m[1])]?.key : undefined, message: `${m?.[2] ? `${m[2]}: ` : ''}${d.message ?? ''}` };
      });
      setProblems(list);
      setFailure(null);
    } else setFailure(describe(error));
  };

  const check = async () => {
    setWorking('check');
    setFailure(null);
    try {
      const result = await api.client.post<{ valid: boolean; errors: WorkflowProblem[] }>('/workflows/validate', body());
      setProblems(result.errors);
      if (result.valid) toasts.success(t('ops.workflows.builder.checkPassed'));
      else {
        const first = result.errors.find((p) => p.stepKey);
        if (first) setOpen(steps.find((s) => s.key === first.stepKey)?.uid ?? null);
      }
    } catch (error) {
      take(error);
    } finally {
      setWorking(null);
    }
  };

  const save = async (): Promise<boolean> => {
    setFailure(null);
    try {
      await api.client.put(`/workflows/${workflowId}/versions/${draft.id}/steps`, { ...body(), notes: notes.trim() || null });
      setDirty(false);
      setProblems([]);
      return true;
    } catch (error) {
      take(error);
      return false;
    }
  };

  const general = (problems ?? []).filter((p) => !p.stepKey || !steps.some((s) => s.key === p.stepKey));
  const problemsOf = (key: string) => (problems ?? []).filter((p) => p.stepKey === key);

  return (
    <div className="space-y-4">
      <LeaveGuard when={dirty} />
      <Panel
        title={t('ops.workflows.builder.draftTitle', { version: formatNumber(draft.version) })}
        description={t(hasPublished ? 'ops.workflows.builder.draftTextReplace' : 'ops.workflows.builder.draftTextFirst')}
        action={
          <>
            <Button variant="destructive-outline" size="sm" onClick={() => setConfirm('discard')}>
              <Trash2 aria-hidden="true" />
              {t('ops.workflows.builder.discard')}
            </Button>
            <Button variant="outline" size="sm" loading={working === 'check'} loadingText={t('common.loading')} onClick={() => void check()}>
              <ListChecks aria-hidden="true" />
              {t('ops.workflows.builder.check')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!dirty}
              loading={working === 'save'}
              loadingText={t('common.saving')}
              onClick={async () => {
                setWorking('save');
                if (await save()) {
                  toasts.success(t('ops.workflows.builder.draftSaved'));
                  await queryClient.invalidateQueries({ queryKey: opsKeys.workflows.all });
                }
                setWorking(null);
              }}
            >
              {t('ops.workflows.builder.saveDraft')}
            </Button>
            <Button size="sm" onClick={() => setConfirm('publish')}>
              <Send aria-hidden="true" />
              {t('ops.workflows.builder.publish')}
            </Button>
          </>
        }
        bodyClassName="space-y-4 pt-3"
      >
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {dirty ? t('ops.workflows.builder.statusUnsaved') : t('ops.workflows.builder.statusSaved')}
        </p>
        {problems && problems.length > 0 ? (
          <Alert tone="danger" live title={t('ops.workflows.builder.problemsTitle', { count: formatNumber(problems.length) })}>
            {general.length ? (
              <ul className="list-disc space-y-0.5 ps-5">
                {general.map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
              </ul>
            ) : (
              t('ops.workflows.builder.problemsOnSteps')
            )}
          </Alert>
        ) : null}
        {failure ? (
          <Alert tone="danger" live>
            {failure}
          </Alert>
        ) : null}
        <Field label={t('ops.workflows.builder.notes')} hint={t('ops.workflows.builder.notesHint')} optional className="max-w-2xl">
          {(p) => (
            <Input
              {...p}
              value={notes}
              maxLength={500}
              dir="auto"
              onChange={(e) => {
                setNotes(e.target.value);
                setDirty(true);
              }}
            />
          )}
        </Field>
      </Panel>

      <ol className="space-y-2">
        {steps.map((step, index) => {
          const isOpen = open === step.uid;
          const issues = problemsOf(step.key);
          const { actor, timeout, conditions } = stepFacts(step);
          return (
            <li
              key={step.uid}
              onDragOver={(e) => {
                if (dragging.current === null) return;
                e.preventDefault();
                setDropAt(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging.current !== null) change(moveItem(steps, dragging.current, index));
                dragging.current = null;
                setDropAt(null);
              }}
            >
              <Card className={cn(issues.length && 'border-destructive/60', dropAt === index && 'ring-2 ring-secondary', isOpen && 'shadow-sm')}>
                <div className="flex items-start gap-2 p-3 sm:p-4">
                  <span
                    draggable
                    onDragStart={(e) => {
                      dragging.current = index;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', step.key);
                    }}
                    onDragEnd={() => {
                      dragging.current = null;
                      setDropAt(null);
                    }}
                    title={t('ops.workflows.builder.drag')}
                    aria-hidden="true"
                    className="mt-1 hidden cursor-grab text-muted-foreground active:cursor-grabbing sm:block"
                  >
                    <GripVertical className="size-4" />
                  </span>
                  <span aria-hidden="true" className="tabular mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-secondary text-xs font-semibold text-secondary-text">
                    {formatNumber(index + 1)}
                  </span>
                  <button type="button" onClick={() => setOpen(isOpen ? null : step.uid)} aria-expanded={isOpen} className="min-w-0 flex-1 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground">
                      {pick(step.name, step.nameAr) || t('ops.workflows.builder.untitled')}
                      <Badge tone={step.type === 'CONDITIONAL_BRANCH' ? 'warning' : 'neutral'}>{t(`ops.workflows.stepTypes.${step.type}`)}</Badge>
                      {issues.length ? <Badge tone="danger">{t('ops.forms.builder.needsAttention')}</Badge> : null}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground [&_svg]:me-1 [&_svg]:inline [&_svg]:size-3.5 [&_svg]:align-[-2px]">
                      <span>
                        <UserRound aria-hidden="true" />
                        {actor ?? t(WAITING.includes(step.type) ? 'ops.workflows.builder.anyone' : 'ops.workflows.builder.automatic')}
                      </span>
                      {timeout ? (
                        <span>
                          <Clock aria-hidden="true" />
                          {timeout}
                        </span>
                      ) : null}
                      {conditions.length ? (
                        <span>
                          <GitBranch aria-hidden="true" />
                          {t('ops.workflows.step.onlyWhen', { conditions: conditions.join('; ') })}
                        </span>
                      ) : null}
                      {step.type === 'CONDITIONAL_BRANCH' ? (
                        <span>
                          <GitBranch aria-hidden="true" />
                          {t('ops.workflows.builder.branchCount', { count: formatNumber(step.branches?.length ?? 0) })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center">
                    <MoveButtons index={index} count={steps.length} onMove={(from, to) => change(moveItem(steps, from, to))} name={step.name} />
                    <Button variant="ghost" size="icon-sm" onClick={() => removeStep(step.uid)} aria-label={t('ops.workflows.builder.removeStep', { name: step.name })} title={t('ops.workflows.builder.removeStep', { name: step.name })}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setOpen(isOpen ? null : step.uid)} aria-label={t(isOpen ? 'ops.workflows.builder.closeEditor' : 'ops.workflows.builder.openEditor', { name: step.name })}>
                      {isOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                    </Button>
                  </span>
                </div>
                {issues.length ? (
                  <ul role="alert" className="list-disc space-y-0.5 pb-3 pe-4 ps-14 text-sm text-destructive-text sm:ps-[4.75rem]">
                    {issues.map((p, i) => (
                      <li key={i}>{p.message}</li>
                    ))}
                  </ul>
                ) : null}
                {isOpen ? (
                  <div className="border-t p-4 sm:p-5">
                    <StepEditor step={step} index={index} steps={steps} meta={meta} onChange={(patch) => setStep(step.uid, patch)} />
                  </div>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label={t('ops.workflows.builder.addStepType')} className="w-full sm:w-72">
          {(p) => <Select {...p} value={newType} onValueChange={(v) => setNewType(v as WorkflowStepType)} options={meta.stepTypes.map((s) => ({ value: s.type, label: t(`ops.workflows.stepTypes.${s.type}`) }))} />}
        </Field>
        <Button variant="outline" onClick={addStep} disabled={steps.length >= WORKFLOW_LIMITS.maxSteps}>
          <Plus aria-hidden="true" />
          {t('ops.workflows.builder.addStep')}
        </Button>
        <p className="w-full text-sm text-muted-foreground">{t(`ops.workflows.typeHelp.${newType}`)}</p>
      </Card>

      <ConfirmDialog
        open={confirm === 'publish'}
        onOpenChange={(next) => !next && setConfirm(null)}
        tone="default"
        title={t('ops.workflows.builder.publishTitle', { version: formatNumber(draft.version) })}
        description={t(hasPublished ? 'ops.workflows.builder.publishTextReplace' : 'ops.workflows.builder.publishTextFirst')}
        confirmLabel={t('ops.workflows.builder.publish')}
        onConfirm={async () => {
          setWorking('publish');
          try {
            if (dirty && !(await save())) return;
            await api.client.post(`/workflows/${workflowId}/versions/${draft.id}/publish`);
            toasts.success(t('ops.workflows.builder.published'), t('ops.workflows.builder.publishedText2', { version: formatNumber(draft.version) }));
            await queryClient.invalidateQueries({ queryKey: opsKeys.workflows.all });
            onPublished();
          } catch (error) {
            take(error);
          } finally {
            setWorking(null);
          }
        }}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={t('ops.workflows.builder.discardTitle')}
        description={t(hasPublished ? 'ops.workflows.builder.discardTextKeep' : 'ops.workflows.builder.discardTextOnly')}
        confirmLabel={t('ops.workflows.builder.discard')}
        onConfirm={async () => {
          await run('discard', () => api.client.delete(`/workflows/${workflowId}/versions/${draft.id}`), { success: t('ops.workflows.builder.discarded'), invalidate: [opsKeys.workflows.all], rethrow: true });
          onPublished();
        }}
      />
    </div>
  );
}

/** The fields of one step. Which ones appear depends on the step type. */
function StepEditor({ step, index, steps, meta, onChange }: { step: EditStep; index: number; steps: EditStep[]; meta: WorkflowMeta; onChange: (patch: Partial<EditStep>) => void }) {
  const { t, formatNumber } = useI18n();
  const waits = WAITING.includes(step.type);
  const roleOptions = [{ value: NONE, label: t('ops.workflows.builder.noRole') }, ...meta.roles.map((r) => ({ value: r.key, label: r.name }))];
  const later = steps.slice(index + 1);
  const rejectType = REJECT_TARGET[step.type];
  const rejectTargets = rejectType ? steps.slice(0, index).filter((s) => s.type === rejectType) : [];
  const stepOption = (s: EditStep) => ({ value: s.key, label: `${formatNumber(steps.indexOf(s) + 1)}. ${s.name}` });
  const config = step.config ?? {};
  const setConfig = (patch: Record<string, unknown>) => {
    const next = { ...config, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange({ config: next });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('ops.workflows.builder.name')} required>
          {(p) => <Input {...p} value={step.name} dir="ltr" lang="en" onChange={(e) => onChange({ name: e.target.value })} />}
        </Field>
        <Field label={t('ops.workflows.builder.nameAr')} optional>
          {(p) => <Input {...p} value={step.nameAr ?? ''} dir="rtl" lang="ar" onChange={(e) => onChange({ nameAr: e.target.value || null })} />}
        </Field>
        <Field label={t('ops.workflows.builder.key')} hint={t('ops.workflows.builder.keyHint')}>
          {(p) => <Input {...p} value={step.key} dir="ltr" className="font-mono text-sm" spellCheck={false} onChange={(e) => onChange({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} />}
        </Field>
        <div className="flex items-center">
          <SwitchRow label={t('ops.workflows.builder.customerVisible')} description={t('ops.workflows.builder.customerVisibleHint')} checked={step.customerVisible} onCheckedChange={(customerVisible) => onChange({ customerVisible })} />
        </div>
      </div>

      {waits ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t('ops.workflows.builder.role')} hint={t('ops.workflows.builder.roleHint')}>
            {(p) => <Select {...p} value={step.assigneeRoleKey ?? NONE} onValueChange={(v) => onChange({ assigneeRoleKey: v === NONE ? null : v })} options={roleOptions} />}
          </Field>
          <Field label={t('ops.workflows.builder.timeout')} hint={t('ops.workflows.builder.timeoutHint', { min: formatNumber(meta.timeoutHours.min), max: formatNumber(meta.timeoutHours.max) })} optional>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={meta.timeoutHours.min}
                max={meta.timeoutHours.max}
                inputMode="numeric"
                dir="ltr"
                className="tabular"
                value={step.timeoutHours ?? ''}
                onChange={(e) => onChange({ timeoutHours: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })}
              />
            )}
          </Field>
          <Field label={t('ops.workflows.builder.escalateTo')} hint={t('ops.workflows.builder.escalateHint')}>
            {(p) => <Select {...p} value={step.escalateToRoleKey ?? NONE} onValueChange={(v) => onChange({ escalateToRoleKey: v === NONE ? null : v })} options={roleOptions} disabled={!step.timeoutHours} />}
          </Field>
        </div>
      ) : null}

      {step.type === 'NOTIFICATION' ? (
        <Field label={t('ops.workflows.builder.message')} hint={t('ops.workflows.builder.messageHint')}>
          {(p) => <Textarea {...p} rows={3} dir="auto" value={typeof config.message === 'string' ? config.message : ''} onChange={(e) => setConfig({ message: e.target.value })} />}
        </Field>
      ) : null}

      {step.type === 'DOCUMENT_GENERATION' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('ops.workflows.builder.docTitle')} optional>
            {(p) => <Input {...p} dir="auto" value={typeof config.title === 'string' ? config.title : ''} onChange={(e) => setConfig({ title: e.target.value })} />}
          </Field>
          <Field label={t('ops.workflows.builder.docType')} optional>
            {(p) => <DocumentTypePicker {...p} value={typeof config.documentTypeKey === 'string' ? config.documentTypeKey : ''} onChange={(key) => setConfig({ documentTypeKey: key })} clearable />}
          </Field>
          <SwitchRow label={t('ops.workflows.builder.docOptional')} description={t('ops.workflows.builder.docOptionalHint')} checked={config.optional === true} onCheckedChange={(v) => setConfig({ optional: v || undefined })} />
          <SwitchRow label={t('ops.workflows.builder.docCustomerVisible')} checked={config.customerVisible === true} onCheckedChange={(v) => setConfig({ customerVisible: v || undefined })} />
        </div>
      ) : null}

      {step.type === 'COMPLETION' ? null : (
        <fieldset className="space-y-3">
          <legend className="text-md font-semibold text-foreground">{t('ops.workflows.builder.conditionsTitle')}</legend>
          <p className="!mt-1 text-sm text-muted-foreground">{t('ops.workflows.builder.conditionsText')}</p>
          <RuleEditor value={step.conditions} onChange={(conditions) => onChange({ conditions })} facts={WORKFLOW_FACT_LIST} operators={meta.operators} emptyText={t('ops.workflows.builder.conditionsEmpty')} />
        </fieldset>
      )}

      {step.type === 'CONDITIONAL_BRANCH' ? (
        <fieldset className="space-y-3">
          <legend className="text-md font-semibold text-foreground">{t('ops.workflows.builder.branchesTitle')}</legend>
          <p className="!mt-1 text-sm text-muted-foreground">{t('ops.workflows.builder.branchesText')}</p>
          {(step.branches ?? []).map((branch, i) => (
            <div key={i} className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t('ops.workflows.builder.branchNumber', { number: formatNumber(i + 1) })}</p>
                <Button variant="ghost" size="icon-sm" onClick={() => onChange({ branches: (step.branches ?? []).filter((_, x) => x !== i) })} aria-label={t('ops.workflows.builder.removeBranch', { number: formatNumber(i + 1) })}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              <RuleEditor
                value={branch.when}
                onChange={(when) => onChange({ branches: (step.branches ?? []).map((b, x) => (x === i ? { ...b, when: (when ?? {}) as Rule } : b)) })}
                facts={WORKFLOW_FACT_LIST}
                operators={meta.operators}
                emptyText={t('ops.workflows.builder.branchEmpty')}
              />
              <Field label={t('ops.workflows.builder.branchGoTo')} className="max-w-md">
                {(p) => (
                  <Select
                    {...p}
                    value={branch.goTo}
                    onValueChange={(goTo) => onChange({ branches: (step.branches ?? []).map((b, x) => (x === i ? { ...b, goTo } : b)) })}
                    options={(later.some((s) => s.key === branch.goTo) ? later : [...later, ...steps.filter((s) => s.key === branch.goTo)]).map(stepOption)}
                  />
                )}
              </Field>
            </div>
          ))}
          <Button variant="outline" size="sm" disabled={!later.length || (step.branches?.length ?? 0) >= WORKFLOW_LIMITS.maxBranches} onClick={() => onChange({ branches: [...(step.branches ?? []), { when: {}, goTo: later[0].key }] })}>
            <Plus aria-hidden="true" />
            {t('ops.workflows.builder.addBranch')}
          </Button>
        </fieldset>
      ) : null}

      {step.type === 'COMPLETION' ? null : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t(step.type === 'CONDITIONAL_BRANCH' ? 'ops.workflows.builder.otherwise' : 'ops.workflows.builder.next')} hint={t('ops.workflows.builder.nextHint')}>
            {(p) => (
              <Select
                {...p}
                value={step.nextStepKey ?? NONE}
                onValueChange={(v) => onChange({ nextStepKey: v === NONE ? null : v })}
                options={[{ value: NONE, label: t('ops.workflows.builder.nextDefault') }, ...(step.nextStepKey && !later.some((s) => s.key === step.nextStepKey) ? [...later, ...steps.filter((s) => s.key === step.nextStepKey)] : later).map(stepOption)]}
              />
            )}
          </Field>
          {rejectType ? (
            <Field label={t('ops.workflows.builder.onReject')} hint={t(rejectType === 'STAFF_TASK' ? 'ops.workflows.builder.onRejectHintTask' : 'ops.workflows.builder.onRejectHintQuotation')}>
              {(p) => (
                <Select
                  {...p}
                  value={step.onRejectStepKey ?? NONE}
                  onValueChange={(v) => onChange({ onRejectStepKey: v === NONE ? null : v })}
                  options={[{ value: NONE, label: t('ops.workflows.builder.onRejectNone') }, ...(step.onRejectStepKey && !rejectTargets.some((s) => s.key === step.onRejectStepKey) ? [...rejectTargets, ...steps.filter((s) => s.key === step.onRejectStepKey)] : rejectTargets).map(stepOption)]}
                />
              )}
            </Field>
          ) : null}
        </div>
      )}
    </div>
  );
}
