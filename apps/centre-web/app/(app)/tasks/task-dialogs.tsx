'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, Hand, Play, RotateCcw, Undo2, UserCog, Workflow, X, XCircle } from 'lucide-react';
import { fieldErrorsOf, isApiError, type RequestPriority } from '@typease/api-client';
import { assignTaskSchema, createTaskSchema, z } from '@typease/validation';
import {
  Alert, Badge, Button, Checkbox, ChoiceLabel, Combobox, ConfirmDialog, DatePicker, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Form, FormError, FormField, Input, Label, STATUS_META, Select, StatusBadge, Textarea, cn, focusRing, useI18n, useSession, useToast, useZodForm,
  type ComboboxOption,
} from '@typease/ui';
import { CustomerPicker, RoleSelect, StaffPicker, type StaffOption } from '@/components/pickers';
import { useCasesApi } from '@/components/cases/api';
import { caseErrorText, dateInputToIso } from '@/components/cases/shared';
import type { CaseView, TaskRow, TaskType } from '@/components/cases/types';

const TYPES: TaskType[] = ['GENERAL', 'FOLLOW_UP', 'DOCUMENT_REVIEW', 'APPROVAL'];
const PRIORITIES: RequestPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const SYSTEM_ROLES = ['manager', 'receptionist', 'operator', 'reviewer', 'accountant'];
const NO_ROLE = '__none__';

/** What a person may do with a task right now (the API decides again on every call). */
export function taskAbilities(task: TaskRow, canManage: boolean) {
  const open = task.status === 'OPEN' || task.status === 'IN_PROGRESS';
  const mineOrManaged = task.assignedToMe || canManage;
  return {
    claim: task.claimable && open,
    start: task.status === 'OPEN' && mineOrManaged && !task.claimable,
    putBack: task.status === 'IN_PROGRESS' && mineOrManaged,
    // Workflow tasks close themselves when the request moves on (409 WORKFLOW_TASK otherwise).
    complete: open && mineOrManaged && !task.workflowManaged,
    cancel: open && canManage && !task.workflowManaged,
    reopen: !open && canManage && !task.workflowManaged,
    assign: open && canManage,
  };
}

// ---------------------------------------------------------------- create

/** The form asks for a day; the API stores an instant (end of that working day in the centre's time zone). */
const createFormSchema = createTaskSchema.omit({ dueAt: true, assigneeIds: true }).extend({ dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullish() });

export function CreateTaskDialog({ requestId, request, canPickStaff, onClose, onDone }: {
  requestId?: string;
  request: CaseView | null;
  canPickStaff: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const i18n = useI18n();
  const { t, pick, has, timeZone, today, formatDate } = i18n;
  const api = useCasesApi();
  const session = useSession();
  const toasts = useToast();
  const canSeeRoles = session.hasAnyPermission(['staff.read', 'role.manage', 'task.manage']);
  const canSearchRequests = session.hasAnyPermission(['request.read.all', 'request.read.assigned']);
  const canSeeCustomers = session.hasPermission('customer.read');
  const form = useZodForm(createFormSchema, {
    defaultValues: { title: '', description: '', type: 'GENERAL', priority: 'NORMAL', requestId: requestId ?? '', customerId: '', dueDate: '', roleKey: '' },
  });
  const [assignees, setAssignees] = React.useState<Array<{ id: string; name: string }>>([]);
  const [toMe, setToMe] = React.useState(!canPickStaff);
  const [picking, setPicking] = React.useState('');
  const meId = React.useId();
  const staffId = React.useId();
  const linkedRequest = form.watch('requestId');

  const loadRequests = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const page = await api.search({ q: q || undefined, pageSize: 15, sort: 'createdAt:desc' }, signal);
      return page.data.map((r) => ({ value: r.id, label: `${r.requestNo} · ${r.customerName}`, description: `${r.serviceName} · ${formatDate(r.createdAt)}` }));
    },
    [api, formatDate],
  );

  const addAssignee = (id: string, member: StaffOption | null) => {
    if (id && member && !assignees.some((a) => a.id === id)) setAssignees((list) => [...list, { id, name: member.user.fullName }]);
    setPicking('');
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const me = session.membership?.id;
            const assigneeIds = canPickStaff ? assignees.map((a) => a.id) : toMe && me ? [me] : [];
            try {
              const task = await api.createTask({
                title: values.title,
                type: values.type,
                priority: values.priority,
                assigneeIds,
                ...(values.description ? { description: values.description } : {}),
                ...(values.requestId ? { requestId: values.requestId } : {}),
                ...(values.customerId && !values.requestId ? { customerId: values.customerId } : {}),
                ...(values.dueDate ? { dueAt: dateInputToIso(values.dueDate, timeZone) } : {}),
                ...(values.roleKey && values.roleKey !== NO_ROLE ? { roleKey: values.roleKey } : {}),
              });
              toasts.success(t('cases.tasks.created'), task.title);
              onDone();
              onClose();
            } catch (error) {
              // Field errors go to the fields through <Form>; a business refusal gets our wording above the buttons.
              if (isApiError(error) && Object.keys(fieldErrorsOf(error)).length > 0) throw error;
              form.setError('root.server', { type: 'server', message: caseErrorText(error, i18n) });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('cases.tasks.new')}</DialogTitle>
            <DialogDescription>{t('cases.tasks.newText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="title" label={t('cases.tasks.form.title')} required hint={t('cases.tasks.form.titleHint')}>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus />}
            </FormField>
            <FormField name="description" label={t('cases.tasks.form.description')} optional>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-3">
              <FormField name="type" label={t('cases.tasks.filters.type')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={TYPES.map((type) => ({ value: type, label: t(`cases.tasks.types.${type}`) }))} />}
              </FormField>
              <FormField name="priority" label={t('cases.fields.priority')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))} />}
              </FormField>
              <FormField name="dueDate" label={t('cases.tasks.form.due')} optional>
                {(field) => <DatePicker {...field} onChange={field.onChange} min={today()} />}
              </FormField>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              {canSearchRequests ? (
                <FormField name="requestId" label={t('cases.tasks.form.request')} optional hint={t('cases.tasks.form.requestHint')}>
                  {(field) => (
                    <Combobox
                      {...field}
                      onValueChange={(value) => field.onChange(value)}
                      loadOptions={loadRequests}
                      clearable
                      selectedLabel={request && request.id === field.value ? `${request.requestNo} · ${request.customer.fullName}` : null}
                      placeholder={t('cases.tasks.form.requestPlaceholder')}
                      searchPlaceholder={t('cases.actions.duplicateSearch')}
                    />
                  )}
                </FormField>
              ) : null}
              {canSeeCustomers && !linkedRequest ? (
                <FormField name="customerId" label={t('cases.fields.customer')} optional>
                  {(field) => <CustomerPicker {...field} onChange={(id) => field.onChange(id)} />}
                </FormField>
              ) : null}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-foreground">{t('cases.tasks.form.who')}</legend>
              {canPickStaff ? (
                <div className="space-y-2">
                  {assignees.length ? (
                    <ul className="flex flex-wrap gap-2">
                      {assignees.map((a) => (
                        <li key={a.id} className="inline-flex items-center gap-1 rounded-full bg-secondary-soft py-1 pe-1 ps-3 text-sm text-secondary-text">
                          {a.name}
                          <button type="button" aria-label={t('cases.tasks.form.removeAssignee', { name: a.name })} onClick={() => setAssignees((list) => list.filter((x) => x.id !== a.id))} className={cn('inline-flex size-6 items-center justify-center rounded-full hover:bg-secondary/15', focusRing)}>
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Label htmlFor={staffId} className="sr-only">
                    {t('cases.tasks.form.addAssignee')}
                  </Label>
                  <StaffPicker id={staffId} value={picking} placeholder={t('cases.tasks.form.addAssignee')} onChange={addAssignee} className="sm:max-w-sm" />
                </div>
              ) : (
                <ChoiceLabel htmlFor={meId} control={<Checkbox id={meId} checked={toMe} onCheckedChange={(on) => setToMe(on === true)} />} label={t('cases.tasks.form.toMe')} />
              )}
              <FormField name="roleKey" label={t('cases.tasks.form.role')} optional hint={t('cases.tasks.form.roleHint')} className="sm:max-w-sm">
                {(field) =>
                  canSeeRoles ? (
                    <RoleSelect id={field.id} value={field.value || undefined} onChange={field.onChange} onBlur={field.onBlur} placeholder={t('cases.tasks.form.noRole')} aria-invalid={field['aria-invalid']} aria-describedby={field['aria-describedby']} />
                  ) : (
                    <Select
                      {...field}
                      value={field.value || NO_ROLE}
                      onValueChange={(value) => field.onChange(value === NO_ROLE ? '' : value)}
                      options={[{ value: NO_ROLE, label: t('cases.tasks.form.noRole') }, ...SYSTEM_ROLES.map((key) => ({ value: key, label: has(`cases.roles.${key}`) ? t(`cases.roles.${key}`) : key }))]}
                    />
                  )
                }
              </FormField>
            </fieldset>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('cases.tasks.create')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- details

type TaskActionName = 'claim' | 'start' | 'putBack' | 'complete' | 'reopen' | 'assign' | 'cancel';

export function TaskDetailDialog({ task, canManage, canPickStaff, roleName, busy, onClose, onAction }: {
  task: TaskRow;
  canManage: boolean;
  canPickStaff: boolean;
  roleName: (key: string | null) => string;
  busy: string | null;
  onClose: () => void;
  onAction: (name: TaskActionName) => void;
}) {
  const { t, formatDateTime } = useI18n();
  const can = taskAbilities(task, canManage);
  const open = task.status === 'OPEN' || task.status === 'IN_PROGRESS';
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            <bdi>{task.title}</bdi>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="task" status={task.status} />
              <StatusBadge kind="priority" status={task.priority} />
              {task.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
              <Badge tone="outline">{t(`cases.tasks.types.${task.type}`)}</Badge>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {task.workflowManaged ? (
            <Alert tone="info" title={t('cases.tasks.automatic')}>
              {t('cases.tasks.automaticText')}
            </Alert>
          ) : null}
          {task.description ? (
            <p className="whitespace-pre-wrap text-base text-foreground" dir="auto">
              {task.description}
            </p>
          ) : null}
          <DescriptionList
            columns={2}
            items={[
              {
                label: t('cases.tasks.columns.request'),
                value: task.requestId && task.requestNo ? (
                  <Link href={`/requests/${task.requestId}`} className="tabular font-medium text-secondary-text underline-offset-4 hover:underline">
                    {task.requestNo}
                  </Link>
                ) : null,
              },
              { label: t('cases.fields.customer'), value: task.customerName },
              { label: t('cases.tasks.columns.assignee'), value: task.assignees.length ? task.assignees.map((a) => a.name).join(', ') : task.roleKey ? t('cases.tasks.queueOf', { role: roleName(task.roleKey) }) : t('requests.unassigned') },
              { label: t('cases.tasks.columns.due'), value: task.dueAt ? formatDateTime(task.dueAt) : null },
              { label: t('cases.tasks.source'), value: t(`cases.tasks.sources.${task.source}`) },
              { label: t('cases.overview.created'), value: formatDateTime(task.createdAt) },
              ...(task.completedAt ? [{ label: t('cases.overview.completed'), value: formatDateTime(task.completedAt) }] : []),
            ]}
          />
        </DialogBody>
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          {can.cancel ? (
            <Button variant="destructive-outline" onClick={() => onAction('cancel')}>
              <XCircle aria-hidden="true" />
              {t('cases.tasks.cancel')}
            </Button>
          ) : null}
          {can.assign && canPickStaff ? (
            <Button variant="outline" onClick={() => onAction('assign')}>
              <UserCog aria-hidden="true" />
              {t('cases.tasks.assign')}
            </Button>
          ) : null}
          {can.reopen ? (
            <Button variant="outline" onClick={() => onAction('reopen')}>
              <RotateCcw aria-hidden="true" />
              {t('cases.tasks.reopen')}
            </Button>
          ) : null}
          {can.putBack ? (
            <Button variant="outline" onClick={() => onAction('putBack')}>
              <Undo2 aria-hidden="true" />
              {t('cases.tasks.putBack')}
            </Button>
          ) : null}
          {can.claim ? (
            <Button variant={task.workflowManaged ? 'outline' : 'default'} onClick={() => onAction('claim')} loading={busy === `claim:${task.id}`}>
              <Hand aria-hidden="true" />
              {t('cases.tasks.claim')}
            </Button>
          ) : null}
          {can.start ? (
            <Button variant={can.complete || task.workflowManaged ? 'outline' : 'default'} onClick={() => onAction('start')}>
              <Play aria-hidden="true" />
              {t('cases.tasks.start')}
            </Button>
          ) : null}
          {can.complete ? (
            <Button onClick={() => onAction('complete')}>
              <CheckCircle2 aria-hidden="true" />
              {t('cases.tasks.complete')}
            </Button>
          ) : null}
          {task.workflowManaged && task.requestId && open ? (
            <Button asChild>
              <Link href={`/requests/${task.requestId}`}>
                <Workflow aria-hidden="true" />
                {t('cases.tasks.openRequestToDo')}
                <ExternalLink className="rtl-mirror" aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- assign / cancel

export function AssignTaskDialog({ task, onClose, onDone }: { task: TaskRow; onClose: () => void; onDone: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(assignTaskSchema, { defaultValues: { assigneeIds: task.assignees.map((a) => a.membershipId), reason: '' } });
  const [people, setPeople] = React.useState(task.assignees.map((a) => ({ id: a.membershipId, name: a.name })));
  const [picking, setPicking] = React.useState('');
  const pickerId = React.useId();
  const changing = task.assignees.length > 0;
  const sync = (next: Array<{ id: string; name: string }>) => {
    setPeople(next);
    form.setValue('assigneeIds', next.map((p) => p.id), { shouldDirty: true });
  };
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            try {
              await api.assignTask(task.id, { assigneeIds: values.assigneeIds, ...(values.reason ? { reason: values.reason } : {}) });
              toasts.success(values.assigneeIds.length ? t('cases.tasks.assigned') : t('cases.tasks.unassigned'), task.title);
              onDone();
              onClose();
            } catch (error) {
              form.setError('root.server', { type: 'server', message: caseErrorText(error, i18n) });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{changing ? t('cases.tasks.reassignTitle') : t('cases.tasks.assignTitle')}</DialogTitle>
            <DialogDescription>
              <bdi>{task.title}</bdi>
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor={pickerId}>{t('cases.tasks.columns.assignee')}</Label>
              {people.length ? (
                <ul className="flex flex-wrap gap-2">
                  {people.map((p) => (
                    <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-secondary-soft py-1 pe-1 ps-3 text-sm text-secondary-text">
                      {p.name}
                      <button type="button" aria-label={t('cases.tasks.form.removeAssignee', { name: p.name })} onClick={() => sync(people.filter((x) => x.id !== p.id))} className={cn('inline-flex size-6 items-center justify-center rounded-full hover:bg-secondary/15', focusRing)}>
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{task.roleKey ? t('cases.tasks.assignNobodyQueue') : t('cases.tasks.assignNobody')}</p>
              )}
              <StaffPicker
                id={pickerId}
                value={picking}
                branchId={task.branchId ?? undefined}
                placeholder={t('cases.tasks.form.addAssignee')}
                onChange={(id, member) => {
                  if (id && member && !people.some((p) => p.id === id)) sync([...people, { id, name: member.user.fullName }]);
                  setPicking('');
                }}
              />
            </div>
            <FormField name="reason" label={t('cases.team.reassignReason')} optional hint={t('cases.tasks.reasonHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
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

export function CancelTaskDialog({ task, onClose, onDone }: { task: TaskRow; onClose: () => void; onDone: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useCasesApi();
  const toasts = useToast();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('cases.tasks.cancelTitle')}
      description={t('cases.tasks.cancelText', { title: task.title })}
      confirmLabel={t('cases.tasks.cancel')}
      cancelLabel={t('cases.tasks.cancelKeep')}
      onConfirm={async () => {
        try {
          await api.setTaskStatus(task.id, 'CANCELLED', reason.trim() || undefined);
          toasts.success(t('cases.tasks.cancelled'), task.title);
          onDone();
        } catch (e) {
          setError(caseErrorText(e, i18n));
          throw e;
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={id} optionalText={t('common.optional')}>
          {t('cases.actions.reason')}
        </Label>
        <Textarea id={id} rows={2} dir="auto" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        {error ? (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
