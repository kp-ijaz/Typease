'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { AlarmClock, ArrowRightLeft, Clock, GripVertical, MoreHorizontal, Plus, Timer, UserRound, UserRoundCheck } from 'lucide-react';
import type { Page } from '@typease/types';
import { REQUEST_TRANSITIONS, type RequestStatus, type TransitionRule } from '@typease/types';
import type { RequestListItem } from '@typease/api-client';
import { requestReasonSchema, requestTransitionSchema } from '@typease/validation';
import {
  Avatar, Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuTrigger, Form, FormError, FormField, Input, Label, PageHeader, PermissionGate, SearchInput, STATUS_META, Skeleton, StatusBadge, Textarea, cn, useApi,
  useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useBranch } from '@/components/branch';
import { useCasesApi } from '@/components/cases/api';
import { caseErrorText } from '@/components/cases/shared';
import { keys } from '@/lib/query-keys';
import { RequestsViewSwitch } from './view-switch';

/**
 * The stages of a typing centre's day, left to right. A stage can hold more
 * than one status of the state machine (packages/types REQUEST_TRANSITIONS);
 * the card shows the exact status when a stage has several.
 */
const STAGES: Array<{ id: string; statuses: RequestStatus[] }> = [
  { id: 'new', statuses: ['SUBMITTED'] },
  { id: 'review', statuses: ['UNDER_REVIEW'] },
  { id: 'customer', statuses: ['AWAITING_CUSTOMER'] },
  { id: 'quote', statuses: ['QUOTED', 'AWAITING_PAYMENT'] },
  { id: 'ready', statuses: ['READY_FOR_PROCESSING'] },
  { id: 'preparing', statuses: ['IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT'] },
  { id: 'authority', statuses: ['EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED'] },
  { id: 'final', statuses: ['FINAL_REVIEW'] },
  { id: 'done', statuses: ['COMPLETED'] },
];
const PAGE_SIZE = 50;
/** The "Completed" stage shows the last week only; older ones are in the list. */
const DONE_DAYS = 7;

type Move = { request: RequestListItem; rule: TransitionRule };

/**
 * Drag-and-drop pipeline of the open requests. Dropping a card on a stage runs
 * the same transition as the buttons on the case page (POST /requests/:id/transition):
 * the API checks permissions and business rules, records history and tells the
 * customer about the new status. Every card also has a "Move to" menu, so the
 * board works with a keyboard and on touch screens.
 */
export function RequestBoard() {
  const i18n = useI18n();
  const { t, pick } = i18n;
  const api = useApi();
  const cases = useCasesApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const { branchId } = useBranch();
  const [search, setSearch] = React.useState('');
  const [mine, setMine] = React.useState(false);
  const [dragged, setDragged] = React.useState<RequestListItem | null>(null);
  const [pending, setPending] = React.useState<Move | null>(null);
  const [choice, setChoice] = React.useState<{ request: RequestListItem; rules: TransitionRule[] } | null>(null);

  const [editingLimits, setEditingLimits] = React.useState(false);
  const limits = useQuery({ queryKey: [...keys.requests.all, 'board-limits'], queryFn: () => api.client.get<{ limits: Partial<Record<RequestStatus, number>>; statuses: RequestStatus[] }>('/requests/board/limits') });
  const doneFrom = React.useMemo(() => new Date(Date.now() - DONE_DAYS * 86_400_000).toISOString().slice(0, 10), []);
  const stageKey = React.useCallback(
    (stage: (typeof STAGES)[number]): QueryKey => [...keys.requests.all, 'board', stage.id, branchId ?? 'all', mine, search],
    [branchId, mine, search],
  );
  const results = useQueries({
    queries: STAGES.map((stage) => ({
      queryKey: stageKey(stage),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.requests.list(
          {
            status: stage.statuses,
            pageSize: PAGE_SIZE,
            // Longest-waiting first, so nothing gets stuck at the bottom.
            sort: stage.id === 'done' ? 'completedAt:desc' : 'updatedAt:asc',
            ...(stage.id === 'done' ? { completedFrom: doneFrom } : {}),
            ...(branchId ? { branchId } : {}),
            ...(mine ? { assignedToId: 'me' } : {}),
            ...(search ? { q: search } : {}),
          },
          signal,
        ),
      refetchInterval: 60_000,
    })),
  });

  /** What this person may do with a card, by target status (automatic steps and missing permissions excluded). */
  const movesFor = React.useCallback(
    (request: RequestListItem) =>
      REQUEST_TRANSITIONS[request.status].filter((r) => r.to !== 'CANCELLED' && r.staff.length > 0 && session.hasAnyPermission(r.staff)),
    [session],
  );

  const mutation = useMutation({
    mutationFn: ({ request, to, reason, customerMessage }: { request: RequestListItem; to: RequestStatus; reason?: string; customerMessage?: string }) =>
      cases.transition(request.id, { to, ...(reason ? { reason } : {}), ...(customerMessage ? { customerMessage } : {}) }),
    // Move the card at once; put it back if the API says no.
    onMutate: async ({ request, to }) => {
      const from = STAGES.find((s) => s.statuses.includes(request.status));
      const target = STAGES.find((s) => s.statuses.includes(to));
      if (!from || !target) return undefined;
      const fromKey = stageKey(from);
      const toKey = stageKey(target);
      await queryClient.cancelQueries({ queryKey: keys.requests.all });
      const before = { from: queryClient.getQueryData<Page<RequestListItem>>(fromKey), to: queryClient.getQueryData<Page<RequestListItem>>(toKey) };
      const moved: RequestListItem = { ...request, status: to, statusLabel: { en: STATUS_META.request[to].en, ar: STATUS_META.request[to].ar }, updatedAt: new Date().toISOString(), statusSince: new Date().toISOString() };
      queryClient.setQueryData<Page<RequestListItem>>(fromKey, (page) => page && { ...page, data: page.data.filter((r) => r.id !== request.id) });
      queryClient.setQueryData<Page<RequestListItem>>(toKey, (page) => page && { ...page, data: [...page.data.filter((r) => r.id !== request.id), moved] });
      return { fromKey, toKey, before };
    },
    onError: (error, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.fromKey, context.before.from);
        queryClient.setQueryData(context.toKey, context.before.to);
      }
      toasts.error(caseErrorText(error, i18n));
    },
    onSuccess: (_view, { request, to }) => {
      toasts.success(t('requests.board.moved', { number: request.requestNo, status: pick(STATUS_META.request[to].en, STATUS_META.request[to].ar) }), t('requests.board.customerNotified'));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.requests.all }),
  });

  // Many moves need an assignee first ("Assign an operator first"): claim a card without opening it.
  const me = session.membership?.id;
  const claim = useMutation({
    mutationFn: (request: RequestListItem) => cases.assign(request.id, { assigneeMembershipId: me!, role: 'OPERATOR' }),
    onSuccess: (_view, request) => toasts.success(t('requests.board.assigned', { number: request.requestNo })),
    onError: (error) => toasts.error(caseErrorText(error, i18n)),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.requests.all }),
  });
  const canClaim = (request: RequestListItem) =>
    Boolean(me) && session.hasPermission('request.assign') && !request.assigneeName && request.status !== 'COMPLETED';

  /** Runs a move, asking for a reason first when the state machine requires one. */
  const start = React.useCallback(
    (request: RequestListItem, rule: TransitionRule) => {
      if (rule.reason) setPending({ request, rule });
      else mutation.mutate({ request, to: rule.to });
    },
    [mutation],
  );

  const drop = (stage: (typeof STAGES)[number]) => {
    const request = dragged;
    setDragged(null);
    if (!request || stage.statuses.includes(request.status)) return;
    const rules = movesFor(request).filter((r) => stage.statuses.includes(r.to));
    if (rules.length === 0) {
      toasts.error(t('requests.board.notAllowed', { from: pick(STATUS_META.request[request.status].en, STATUS_META.request[request.status].ar), stage: t(`requests.board.stages.${stage.id}`) }));
    } else if (rules.length === 1) {
      start(request, rules[0]!);
    } else {
      setChoice({ request, rules });
    }
  };

  const newRequest = (
    <PermissionGate permission="request.create">
      <Button asChild variant="accent">
        <Link href="/requests/new">
          <Plus aria-hidden="true" />
          {t('requests.new')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('requests.title')} description={t('requests.board.description')} action={newRequest} secondary={<RequestsViewSwitch active="board" />} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t('requests.searchPlaceholder')} className="w-full max-w-sm" />
        <Button variant={mine ? 'subtle' : 'outline'} size="sm" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
          <UserRound aria-hidden="true" />
          {t('requests.board.mine')}
        </Button>
        <PermissionGate permission="request.assign">
          <Button variant="outline" size="sm" onClick={() => setEditingLimits(true)}>
            <Timer aria-hidden="true" />
            {t('requests.board.limits.button')}
          </Button>
        </PermissionGate>
        {Object.keys(limits.data?.limits ?? {}).length ? (
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-warning" aria-hidden="true" />{t('requests.board.limits.nearLegend')}</span>
            <span className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-destructive" aria-hidden="true" />{t('requests.board.limits.overLegend')}</span>
          </span>
        ) : null}
      </div>
      {editingLimits && limits.data ? <LimitsDialog current={limits.data.limits} statuses={limits.data.statuses} onClose={() => setEditingLimits(false)} /> : null}

      <div className="-mx-4 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6" role="list" aria-label={t('requests.board.label')}>
        {/* A fixed-height board: each column scrolls on its own and keeps its heading in view. */}
        <div className="flex h-[calc(100dvh-15rem)] min-h-[28rem] gap-3">
          {STAGES.map((stage, index) => {
            const result = results[index]!;
            const rows = result.data?.data ?? [];
            const total = result.data?.meta.total ?? rows.length;
            const canDrop = dragged !== null && !stage.statuses.includes(dragged.status) && movesFor(dragged).some((r) => stage.statuses.includes(r.to));
            const blocked = dragged !== null && !stage.statuses.includes(dragged.status) && !canDrop;
            return (
              <section
                key={stage.id}
                role="listitem"
                aria-labelledby={`stage-${stage.id}`}
                onDragOver={(e) => {
                  if (canDrop) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(stage);
                }}
                className={cn(
                  'flex min-h-0 w-64 shrink-0 flex-col rounded-xl border bg-muted/40 transition-colors',
                  canDrop && 'border-secondary bg-secondary-soft/60 ring-2 ring-secondary/30',
                  blocked && 'opacity-50',
                )}
              >
                <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                  <h2 id={`stage-${stage.id}`} className="text-sm font-semibold">
                    {t(`requests.board.stages.${stage.id}`)}
                  </h2>
                  <Badge tone={stage.id === 'customer' || stage.id === 'quote' ? 'warning' : stage.id === 'done' ? 'success' : 'neutral'}>{total}</Badge>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {result.isLoading ? (
                    <>
                      <Skeleton className="h-24 w-full" />
                      <Skeleton className="h-24 w-full" />
                    </>
                  ) : rows.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">{canDrop ? t('requests.board.dropHere') : t('requests.board.empty')}</p>
                  ) : (
                    rows.map((request) => (
                      <BoardCard
                        key={request.id}
                        request={request}
                        showStatus={stage.statuses.length > 1}
                        limitMinutes={limits.data?.limits[request.status]}
                        moves={movesFor(request)}
                        dragging={dragged?.id === request.id}
                        onDragStart={() => setDragged(request)}
                        onDragEnd={() => setDragged(null)}
                        onMove={(rule) => start(request, rule)}
                        onClaim={canClaim(request) ? () => claim.mutate(request) : undefined}
                      />
                    ))
                  )}
                  {total > rows.length ? (
                    <Link
                      href={`/requests?status=${stage.statuses.join(',')}`}
                      className="mt-1 rounded-md px-2 py-1.5 text-center text-sm font-medium text-secondary-text hover:bg-muted"
                    >
                      {t('requests.board.more', { count: total - rows.length })}
                    </Link>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {choice ? (
        <ChooseStatusDialog
          request={choice.request}
          rules={choice.rules}
          onClose={() => setChoice(null)}
          onChoose={(rule) => {
            setChoice(null);
            start(choice.request, rule);
          }}
        />
      ) : null}
      {pending ? (
        <ReasonDialog
          move={pending}
          onClose={() => setPending(null)}
          onConfirm={async (values) => {
            await mutation.mutateAsync({ request: pending.request, to: pending.rule.to, ...values });
            setPending(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Minutes as "45 min", "5 h", "2 d 3 h". */
function useDuration() {
  const { t } = useI18n();
  return (minutes: number) => {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return t('requests.board.limits.min', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('requests.board.limits.hours', { n: Math.round((m / 60) * 10) / 10 });
    return t('requests.board.limits.days', { d: Math.floor(h / 24), h: h % 24 });
  };
}

function BoardCard({
  request, showStatus, limitMinutes, moves, dragging, onDragStart, onDragEnd, onMove, onClaim,
}: {
  request: RequestListItem;
  showStatus: boolean;
  limitMinutes?: number;
  moves: TransitionRule[];
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (rule: TransitionRule) => void;
  onClaim?: () => void;
}) {
  const { t, pick } = useI18n();
  const duration = useDuration();
  const hasMenu = moves.length > 0 || onClaim !== undefined;
  const urgent = request.priority === 'URGENT' || request.priority === 'HIGH';
  const inStage = (Date.now() - Date.parse(request.statusSince ?? request.updatedAt)) / 60_000;
  const level = !limitMinutes || request.status === 'COMPLETED' ? null : inStage >= limitMinutes ? 'over' : inStage >= limitMinutes * 0.75 ? 'near' : null;
  return (
    <article
      draggable={moves.length > 0}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', request.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative rounded-lg border bg-card p-3 shadow-xs transition hover:border-secondary/50 hover:shadow-sm',
        moves.length > 0 && 'cursor-grab active:cursor-grabbing',
        dragging && 'rotate-1 opacity-40',
        (request.overdue || level === 'over') && 'border-s-4 border-s-destructive',
        level === 'near' && !request.overdue && 'border-s-4 border-s-warning',
      )}
    >
      <div className="flex items-start gap-1.5">
        {moves.length > 0 ? <GripVertical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={`/requests/${request.id}`} className="tabular whitespace-nowrap text-xs font-semibold text-muted-foreground hover:text-foreground hover:underline">
              {request.requestNo}
            </Link>
            {urgent ? <StatusBadge kind="priority" status={request.priority} /> : null}
            {request.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
            {level === 'over' ? (
              <Badge tone="danger">
                <AlarmClock aria-hidden="true" className="size-3" />
                {t('requests.board.limits.overBy', { time: duration(inStage - limitMinutes!) })}
              </Badge>
            ) : null}
          </div>
          <Link href={`/requests/${request.id}`} className="mt-1 block truncate font-medium text-foreground hover:underline">
            {request.customerName}
          </Link>
          <p className="line-clamp-2 text-sm text-muted-foreground">{pick(request.service.name, request.service.nameAr)}</p>
        </div>
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-me-1 -mt-1 shrink-0" aria-label={t('requests.board.moveTo', { number: request.requestNo })}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onClaim ? (
                <DropdownMenuItem onSelect={onClaim}>
                  <UserRoundCheck aria-hidden="true" />
                  {t('requests.board.assignMe')}
                </DropdownMenuItem>
              ) : null}
              {moves.length > 0 ? <DropdownMenuLabel>{t('requests.board.moveToLabel')}</DropdownMenuLabel> : null}
              {moves.map((rule) => (
                <DropdownMenuItem key={rule.to} onSelect={() => onMove(rule)}>
                  <ArrowRightLeft aria-hidden="true" />
                  {pick(STATUS_META.request[rule.to].en, STATUS_META.request[rule.to].ar)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {showStatus ? (
        <div className="mt-2">
          <StatusBadge kind="request" status={request.status} label={request.statusLabel} />
        </div>
      ) : null}
      <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {request.assigneeName ? (
            <>
              <Avatar name={request.assigneeName} size="sm" className="size-5 text-[9px]" />
              <span className="truncate">{request.assigneeName}</span>
            </>
          ) : (
            <span>{t('requests.unassigned')}</span>
          )}
        </span>
        <span
          className={cn('inline-flex shrink-0 items-center gap-1', level === 'over' && 'font-semibold text-destructive', level === 'near' && 'font-semibold text-warning-text')}
          title={limitMinutes ? t('requests.board.limits.inStageOf', { limit: duration(limitMinutes) }) : t('requests.board.limits.inStage')}
        >
          <Clock aria-hidden="true" className="size-3.5" />
          {duration(inStage)}
        </span>
      </div>
    </article>
  );
}

/** A stage with several possible statuses (e.g. "With authority"): which one? */
function ChooseStatusDialog({ request, rules, onClose, onChoose }: { request: RequestListItem; rules: TransitionRule[]; onClose: () => void; onChoose: (rule: TransitionRule) => void }) {
  const { t, pick } = useI18n();
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('requests.board.chooseTitle', { number: request.requestNo })}</DialogTitle>
          <DialogDescription>{t('requests.board.chooseText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2">
          {rules.map((rule) => (
            <Button key={rule.to} variant="outline" className="justify-start" onClick={() => onChoose(rule)}>
              {pick(STATUS_META.request[rule.to].en, STATUS_META.request[rule.to].ar)}
            </Button>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** The state machine wants a reason for this move; the customer may get a personal message too. */
function ReasonDialog({ move, onClose, onConfirm }: { move: Move; onClose: () => void; onConfirm: (values: { reason?: string; customerMessage?: string }) => Promise<void> }) {
  const i18n = useI18n();
  const { t, pick } = i18n;
  const schema = React.useMemo(() => requestTransitionSchema.pick({ reason: true, customerMessage: true }).extend({ reason: requestReasonSchema.shape.reason }), []);
  const form = useZodForm(schema, { defaultValues: { reason: '', customerMessage: '' } });
  const target = STATUS_META.request[move.rule.to];
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            try {
              await onConfirm({ reason: values.reason || undefined, customerMessage: values.customerMessage || undefined });
            } catch (error) {
              form.setError('root.server', { message: caseErrorText(error, i18n) });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {move.request.requestNo} · {pick(target.en, target.ar)}
            </DialogTitle>
            <DialogDescription>{t('cases.actions.reasonText', { status: pick(target.en, target.ar) })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="reason" label={t('cases.actions.reason')} required hint={t('cases.actions.reasonHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" autoFocus />}
            </FormField>
            <FormField name="customerMessage" label={t('cases.actions.customerMessage')} optional hint={t('cases.actions.customerMessageHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('requests.board.confirm')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const SUGGESTED_LIMITS: Partial<Record<RequestStatus, number>> = {
  SUBMITTED: 120, UNDER_REVIEW: 240, AWAITING_CUSTOMER: 2880, QUOTED: 1440, AWAITING_PAYMENT: 1440, READY_FOR_PROCESSING: 240,
  IN_PREPARATION: 480, PENDING_APPROVAL: 240, READY_TO_SUBMIT: 240, EXTERNAL_PROCESSING: 4320, RETURNED: 1440, REJECTED: 1440, FINAL_REVIEW: 240,
};

/** How long a request may stay in each status. Edited in hours, stored in minutes. */
function LimitsDialog({ current, statuses, onClose }: { current: Partial<Record<RequestStatus, number>>; statuses: RequestStatus[]; onClose: () => void }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const hours = (m?: number) => (m ? String(Math.round((m / 60) * 100) / 100) : '');
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(statuses.map((s) => [s, hours(current[s])])));
  const save = useMutation({
    mutationFn: () =>
      api.client.put('/requests/board/limits', {
        limits: Object.fromEntries(statuses.map((s) => [s, values[s] && Number(values[s]) > 0 ? Math.max(5, Math.round(Number(values[s]) * 60)) : null])),
      }),
    onSuccess: () => {
      toasts.success(t('requests.board.limits.saved'));
      void queryClient.invalidateQueries({ queryKey: [...keys.requests.all, 'board-limits'] });
      onClose();
    },
    onError: (e) => toasts.error(e),
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('requests.board.limits.title')}</DialogTitle>
          <DialogDescription>{t('requests.board.limits.text')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Button variant="outline" size="sm" onClick={() => setValues(Object.fromEntries(statuses.map((s) => [s, hours(SUGGESTED_LIMITS[s])])))}>
            {t('requests.board.limits.suggested')}
          </Button>
          <div className="grid gap-2 sm:grid-cols-2">
            {statuses.map((s) => (
              <div key={s} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <Label htmlFor={`limit-${s}`} className="text-sm">
                  {pick(STATUS_META.request[s].en, STATUS_META.request[s].ar)}
                </Label>
                <span className="flex items-center gap-1.5">
                  <Input id={`limit-${s}`} inputMode="decimal" className="h-8 w-20 text-end tabular" value={values[s] ?? ''} placeholder="—" onChange={(e) => setValues((v) => ({ ...v, [s]: e.target.value.replace(/[^\d.]/g, '') }))} />
                  <span className="text-xs text-muted-foreground">{t('requests.board.limits.h')}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('requests.board.limits.hint')}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
