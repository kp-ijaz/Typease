'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Hand, ListChecks, Play, Plus, RotateCcw, Undo2, UserCog, Workflow, XCircle } from 'lucide-react';
import type { RequestPriority } from '@typease/api-client';
import type { TaskStatus } from '@typease/types';
import {
  Alert, Badge, Button, DataTable, PageHeader, PermissionGate, STATUS_META, StatusBadge, Tabs, TabsList, TabsTrigger, cn, focusRing, useI18n, useSession, useToast,
  type DataTableColumn, type DataTableFilter, type ListParams, type RowAction,
} from '@typease/ui';
import { useStaffOptions } from '@/components/pickers';
import { caseKeys } from '@/lib/keys/cases';
import { useCasesApi } from '@/components/cases/api';
import { useCaseError } from '@/components/cases/shared';
import type { TaskRow, TaskType } from '@/components/cases/types';
import { AssignTaskDialog, CancelTaskDialog, CreateTaskDialog, TaskDetailDialog, taskAbilities } from './task-dialogs';

const TABS = ['mine', 'queue', 'all'] as const;
type TaskTab = (typeof TABS)[number];
const STATUSES: TaskStatus[] = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const TYPES: TaskType[] = ['GENERAL', 'FOLLOW_UP', 'DOCUMENT_REVIEW', 'APPROVAL', 'ESCALATION', 'WORKFLOW_STEP'];
const PRIORITIES: RequestPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
const UNASSIGNED = 'none';

export type TaskDialogState =
  | { type: 'create' }
  | { type: 'detail'; task: TaskRow }
  | { type: 'assign'; task: TaskRow }
  | { type: 'cancel'; task: TaskRow }
  | null;

export function TasksPage() {
  const i18n = useI18n();
  const { t, tn, pick, has, formatDate, formatRelative } = i18n;
  const api = useCasesApi();
  const session = useSession();
  const toasts = useToast();
  const describe = useCaseError();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const canSeeAll = session.hasAnyPermission(['task.read', 'task.manage']);
  const canManage = session.hasPermission('task.manage');
  const canPickStaff = session.hasAnyPermission(['staff.read', 'request.assign', 'task.manage']);
  const membershipId = session.membership?.id;
  const requestId = search.get('requestId') ?? '';
  const requested = search.get('tab');
  const tabs = TABS.filter((tab) => tab !== 'all' || canSeeAll);
  // Coming from a request ("Tasks of this request"), show everything about it, not only what is mine.
  const tab: TaskTab = tabs.includes(requested as TaskTab) ? (requested as TaskTab) : requestId && canSeeAll ? 'all' : 'mine';

  const setParams = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(search.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // A different list starts on its first page.
    next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const [dialog, setDialog] = React.useState<TaskDialogState>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const staff = useStaffOptions(canPickStaff && canSeeAll);
  const mine = useQuery({ queryKey: [...caseKeys.taskCounts, membershipId], queryFn: () => api.myTasks({ assigneeId: membershipId, pageSize: 1 }), enabled: !!membershipId });
  const linked = useQuery({ queryKey: caseKeys.detail(requestId), queryFn: () => api.get(requestId), enabled: !!requestId && session.hasAnyPermission(['request.read.all', 'request.read.assigned']) });

  const refresh = () => queryClient.invalidateQueries({ queryKey: caseKeys.tasks });
  const act = async (key: string, run: () => Promise<TaskRow>, done: string) => {
    setBusy(key);
    try {
      const task = await run();
      toasts.success(done, task.title);
      await refresh();
    } catch (error) {
      toasts.error(describe(error));
    } finally {
      setBusy(null);
    }
  };
  const actions = {
    claim: (task: TaskRow) => act(`claim:${task.id}`, () => api.claimTask(task.id), t('cases.tasks.claimed')),
    start: (task: TaskRow) => act(`start:${task.id}`, () => api.setTaskStatus(task.id, 'IN_PROGRESS'), t('cases.tasks.started')),
    putBack: (task: TaskRow) => act(`back:${task.id}`, () => api.setTaskStatus(task.id, 'OPEN'), t('cases.tasks.putBackDone')),
    complete: (task: TaskRow) => act(`done:${task.id}`, () => api.setTaskStatus(task.id, 'DONE'), t('cases.tasks.completed')),
    reopen: (task: TaskRow) => act(`reopen:${task.id}`, () => api.setTaskStatus(task.id, 'OPEN'), t('cases.tasks.reopened')),
  };

  const roleName = (key: string | null) => (key ? (has(`cases.roles.${key}`) ? t(`cases.roles.${key}`) : key) : '');

  const columns = React.useMemo<Array<DataTableColumn<TaskRow>>>(
    () => [
      {
        id: 'task',
        header: t('cases.tasks.columns.task'),
        mobile: 'title',
        className: 'min-w-64',
        cell: (task) => (
          <span className="block">
            <button type="button" onClick={() => setDialog({ type: 'detail', task })} className={cn('rounded-sm text-start font-medium text-secondary-text underline-offset-4 hover:underline', focusRing)} data-task={task.id}>
              {task.title}
            </button>
            {task.workflowManaged ? (
              <span className="mt-1 flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
                <Workflow className="size-3.5 shrink-0" aria-hidden="true" />
                {t('cases.tasks.automatic')}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('cases.tasks.columns.status'),
        mobile: 'badge',
        cell: (task) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="task" status={task.status} />
            {task.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      {
        id: 'priority',
        header: t('cases.fields.priority'),
        sortField: 'priority',
        className: 'whitespace-nowrap',
        cell: (task) => <StatusBadge kind="priority" status={task.priority} className={task.priority === 'HIGH' || task.priority === 'URGENT' ? undefined : 'bg-transparent px-0'} />,
      },
      {
        id: 'due',
        header: t('cases.tasks.columns.due'),
        sortField: 'dueAt',
        className: 'whitespace-nowrap',
        cell: (task) =>
          task.dueAt ? (
            <>
              <span className="tabular block">{formatDate(task.dueAt)}</span>
              {task.status === 'OPEN' || task.status === 'IN_PROGRESS' ? <span className={cn('block text-sm', task.overdue ? 'text-destructive-text' : 'text-muted-foreground')}>{formatRelative(task.dueAt)}</span> : null}
            </>
          ) : null,
      },
      {
        id: 'request',
        header: t('cases.tasks.columns.request'),
        className: 'whitespace-nowrap',
        cell: (task) =>
          task.requestId && task.requestNo ? (
            <>
              <Link href={`/requests/${task.requestId}`} className={cn('tabular rounded-sm font-medium text-secondary-text underline-offset-4 hover:underline', focusRing)}>
                {task.requestNo}
              </Link>
              {task.customerName ? <span className="block text-sm text-muted-foreground">{task.customerName}</span> : null}
            </>
          ) : task.customerName ? (
            task.customerName
          ) : null,
      },
      {
        id: 'assignee',
        header: t('cases.tasks.columns.assignee'),
        cell: (task) =>
          task.assignees.length ? (
            task.assignees.map((a) => a.name).join(', ')
          ) : task.roleKey ? (
            <span className="text-muted-foreground">{t('cases.tasks.queueOf', { role: roleName(task.roleKey) })}</span>
          ) : (
            <span className="text-muted-foreground">{t('requests.unassigned')}</span>
          ),
      },
      {
        id: 'action',
        header: t('requests.columns.action'),
        align: 'end',
        mobile: 'field',
        className: 'whitespace-nowrap',
        cell: (task) => {
          const can = taskAbilities(task, canManage);
          if (can.claim)
            return (
              <Button size="sm" variant="subtle" loading={busy === `claim:${task.id}`} onClick={() => void actions.claim(task)}>
                <Hand aria-hidden="true" />
                {t('cases.tasks.claim')}
              </Button>
            );
          if (task.workflowManaged && task.requestId && (task.status === 'OPEN' || task.status === 'IN_PROGRESS'))
            return (
              <Button asChild size="sm" variant="subtle">
                <Link href={`/requests/${task.requestId}`}>{t('requests.open')}</Link>
              </Button>
            );
          if (can.start)
            return (
              <Button size="sm" variant="subtle" loading={busy === `start:${task.id}`} onClick={() => void actions.start(task)}>
                <Play aria-hidden="true" />
                {t('cases.tasks.start')}
              </Button>
            );
          if (can.complete)
            return (
              <Button size="sm" variant="subtle" loading={busy === `done:${task.id}`} onClick={() => void actions.complete(task)}>
                <CheckCircle2 aria-hidden="true" />
                {t('cases.tasks.complete')}
              </Button>
            );
          return null;
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, formatDate, formatRelative, canManage, busy, has],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      ...(tab === 'queue'
        ? []
        : [{ id: 'status', type: 'select' as const, label: t('cases.tasks.filters.status'), allLabel: t('cases.tasks.filters.open'), options: STATUSES.map((s) => ({ value: s, label: pick(STATUS_META.task[s].en, STATUS_META.task[s].ar) })) }]),
      { id: 'overdue', type: 'select', label: t('cases.tasks.filters.due'), options: [{ value: 'true', label: t('cases.tasks.filters.overdueOnly') }] },
      { id: 'type', type: 'select', label: t('cases.tasks.filters.type'), options: TYPES.map((type) => ({ value: type, label: t(`cases.tasks.types.${type}`) })) },
      { id: 'priority', type: 'select', label: t('cases.fields.priority'), options: PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) })) },
      ...(tab === 'all' && staff.data?.length
        ? [{ id: 'assignee', type: 'select' as const, label: t('cases.tasks.filters.assignee'), options: [{ value: UNASSIGNED, label: t('cases.tasks.filters.nobody') }, ...staff.data.map((m) => ({ value: m.id, label: m.user.fullName }))] }]
        : []),
    ],
    [t, pick, tab, staff.data],
  );

  const rowActions = React.useMemo<Array<RowAction<TaskRow>>>(
    () => [
      { id: 'details', label: t('cases.tasks.details'), icon: <ListChecks aria-hidden="true" />, onSelect: (task) => setDialog({ type: 'detail', task }) },
      { id: 'request', label: t('requests.open'), icon: <ExternalLink aria-hidden="true" />, href: (task) => `/requests/${task.requestId}`, hidden: (task) => !task.requestId },
      { id: 'claim', label: t('cases.tasks.claim'), icon: <Hand aria-hidden="true" />, onSelect: (task) => void actions.claim(task), hidden: (task) => !taskAbilities(task, canManage).claim },
      { id: 'start', label: t('cases.tasks.start'), icon: <Play aria-hidden="true" />, onSelect: (task) => void actions.start(task), hidden: (task) => !taskAbilities(task, canManage).start },
      { id: 'complete', label: t('cases.tasks.complete'), icon: <CheckCircle2 aria-hidden="true" />, onSelect: (task) => void actions.complete(task), hidden: (task) => !taskAbilities(task, canManage).complete },
      { id: 'back', label: t('cases.tasks.putBack'), icon: <Undo2 aria-hidden="true" />, onSelect: (task) => void actions.putBack(task), hidden: (task) => !taskAbilities(task, canManage).putBack },
      { id: 'assign', label: t('cases.tasks.assign'), icon: <UserCog aria-hidden="true" />, onSelect: (task) => setDialog({ type: 'assign', task }), hidden: (task) => !canPickStaff || !taskAbilities(task, canManage).assign },
      { id: 'reopen', label: t('cases.tasks.reopen'), icon: <RotateCcw aria-hidden="true" />, onSelect: (task) => void actions.reopen(task), hidden: (task) => !taskAbilities(task, canManage).reopen },
      { id: 'cancel', label: t('cases.tasks.cancel'), icon: <XCircle aria-hidden="true" />, destructive: true, onSelect: (task) => setDialog({ type: 'cancel', task }), hidden: (task) => !taskAbilities(task, canManage).cancel },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canManage, canPickStaff],
  );

  /** Turns the table's filter state into the query the API understands, per tab. */
  const fetchTasks = (params: ListParams, signal: AbortSignal) => {
    const { assignee, overdue, status, ...rest } = params as ListParams & { assignee?: string; overdue?: string; status?: string };
    const query: Record<string, string | number | boolean | undefined> = { ...rest, status, overdue: overdue === 'true' ? true : undefined, requestId: requestId || undefined };
    if (tab === 'mine') return api.myTasks({ ...query, assigneeId: membershipId }, signal);
    if (tab === 'queue') return api.myTasks({ ...query, status: undefined, unassigned: true }, signal);
    if (assignee === UNASSIGNED) query.unassigned = true;
    else if (assignee) query.assigneeId = assignee;
    if (!status) query.open = true;
    return api.tasks(query, signal);
  };

  const newTask = (
    <PermissionGate permission="task.manage">
      <Button variant="accent" onClick={() => setDialog({ type: 'create' })}>
        <Plus aria-hidden="true" />
        {t('cases.tasks.new')}
      </Button>
    </PermissionGate>
  );
  const overdueMine = mine.data?.overdueCount ?? 0;

  return (
    <>
      <PageHeader title={t('nav.tasks')} description={t('sections.tasks')} action={newTask} />

      {requestId ? (
        <Alert
          tone="info"
          className="mb-4"
          action={
            <>
              {linked.data ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`/requests/${requestId}`}>{t('requests.open')}</Link>
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setParams({ requestId: undefined })}>
                {t('cases.tasks.showAll')}
              </Button>
            </>
          }
        >
          {linked.data ? t('cases.tasks.forRequest', { number: linked.data.requestNo, customer: linked.data.customer.fullName }) : t('cases.tasks.forOneRequest')}
        </Alert>
      ) : null}
      {overdueMine > 0 && tab === 'mine' && !requestId ? (
        <Alert tone="warning" className="mb-4">
          {tn('cases.tasks.overdueMine', overdueMine)}
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value === 'mine' ? undefined : value, status: undefined, assignee: undefined })}>
        <TabsList aria-label={t('nav.tasks')} className="mb-4">
          {tabs.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`cases.tasks.tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DataTable<TaskRow>
        // A different tab is a different list: remount so that page and filters start fresh from the URL.
        key={`${tab}:${requestId}`}
        caption={t(`cases.tasks.tabs.${tab}`)}
        queryKey={[...caseKeys.tasks, tab, requestId || 'any', membershipId ?? 'me']}
        queryFn={fetchTasks}
        columns={columns}
        rowKey={(task) => task.id}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('cases.tasks.search')}
        defaultSort="createdAt:desc"
        empty={{
          icon: <ListChecks />,
          title: t(`cases.tasks.empty.${tab}.title`),
          description: t(`cases.tasks.empty.${tab}.text`),
          action: tab === 'queue' ? undefined : newTask,
        }}
      />

      {dialog?.type === 'create' ? <CreateTaskDialog requestId={requestId || undefined} request={linked.data ?? null} canPickStaff={canPickStaff} onClose={() => setDialog(null)} onDone={() => void refresh()} /> : null}
      {dialog?.type === 'detail' ? (
        <TaskDetailDialog
          task={dialog.task}
          canManage={canManage}
          canPickStaff={canPickStaff}
          roleName={roleName}
          busy={busy}
          onClose={() => setDialog(null)}
          onAction={(name) => {
            const task = dialog.task;
            setDialog(null);
            if (name === 'assign') setDialog({ type: 'assign', task });
            else if (name === 'cancel') setDialog({ type: 'cancel', task });
            else void actions[name](task);
          }}
        />
      ) : null}
      {dialog?.type === 'assign' ? <AssignTaskDialog task={dialog.task} onClose={() => setDialog(null)} onDone={() => void refresh()} /> : null}
      {dialog?.type === 'cancel' ? <CancelTaskDialog task={dialog.task} onClose={() => setDialog(null)} onDone={() => void refresh()} /> : null}
    </>
  );
}
