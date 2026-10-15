'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Send, UserCheck, UserMinus } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { platformStaffReplySchema } from '@typease/validation';
import {
  Alert, Button, Card, ChoiceLabel, DescriptionList, Form, FormError, FormField, Input, PageHeader, PageSkeleton, RequirePermission, STATUS_META, Select, StatusBadge, Switch, Textarea, cn, useI18n,
  useSession, useToast, useZodForm,
} from '@typease/ui';
import { Conversation } from '@/components/conversation';
import { RequestAccessDialog } from '@/components/request-access-dialog';
import { CentreCell, ConfirmReasonDialog, Field, LoadError, Section, useRun } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformTicket, TicketPriority, TicketStatus } from '@/lib/types';

const PRIORITIES: TicketPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
/** What support may change a status to (docs/api/modules/support.md). CLOSED is final. */
const NEXT: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};
const KEEP = '__keep__';
const NOBODY = '__nobody__';

export function TicketPage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['platform.support.manage']}>
      <TicketView id={id} />
    </RequirePermission>
  );
}

function TicketView({ id }: { id: string }) {
  const { t, pick, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [target, setTarget] = React.useState<TicketStatus | null>(null);
  const [requesting, setRequesting] = React.useState(false);
  const ticket = useQuery({ queryKey: keys.tickets.detail(id), queryFn: ({ signal }) => api.tickets.get(id, signal), retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2 });
  // Only people who manage platform staff can read the staff list; everybody else assigns to themselves.
  const mayListStaff = session.hasPermission('platform.staff.manage');
  const staff = useQuery({ queryKey: [...keys.staff.all, 'active'], queryFn: ({ signal }) => api.staff.list({ status: 'ACTIVE' }, signal), enabled: mayListStaff, staleTime: 60_000 });
  const crumbs = [{ label: t('nav.support'), href: '/support' }];
  const invalidate = [keys.tickets.all, keys.dashboard.all];

  if (ticket.isPending) return <PageSkeleton label={t('common.loading')} />;
  if (ticket.isError) {
    return (
      <>
        <PageHeader title={t('desk.ticket')} breadcrumbs={crumbs} />
        <LoadError error={ticket.error} onRetry={() => void ticket.refetch()} />
      </>
    );
  }

  const data = ticket.data;
  const me = session.user?.id;
  const closed = data.status === 'CLOSED';
  const patch = (name: string, body: object, success: string) => run(name, () => api.tickets.update(id, body), { success, invalidate });
  const setStatus = (status: TicketStatus) => {
    // Resolving and closing ask for a word about the outcome; the other changes are immediate.
    if (status === 'RESOLVED' || status === 'CLOSED') return setTarget(status);
    return void patch(`status-${status}`, { status }, t('desk.statusChanged'));
  };
  const assign = (userId: string | null) => patch('assignee', { platformAssigneeId: userId }, t(userId ? (userId === me ? 'desk.assignedToYou' : 'desk.assigned') : 'desk.unassignedDone'));

  return (
    <>
      <PageHeader
        title={<span dir="auto">{data.subject}</span>}
        breadcrumbs={crumbs}
        description={
          <>
            <span className="ltr-value tabular">{data.ticketNo}</span> · {t('desk.openedOn', { date: formatDateTime(data.createdAt) })}
          </>
        }
        meta={
          <>
            <StatusBadge kind="ticket" status={data.status} />
            {data.priority === 'HIGH' || data.priority === 'URGENT' ? <StatusBadge kind="priority" status={data.priority} /> : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          <Card className="p-4 sm:p-5">
            <h2 className="mb-4 text-md font-semibold">{t('desk.conversation')}</h2>
            <Conversation
              usLabel={t('desk.us')}
              themLabel={data.tenant.name}
              messages={(data.messages ?? []).map((m) => ({ id: m.id, side: m.fromCentre ? 'them' : 'us', authorName: m.authorName, internal: m.visibility === 'INTERNAL', body: m.body, createdAt: m.createdAt }))}
            />
            {data.resolutionSummary ? (
              <Alert tone="success" className="mt-4" title={t('desk.resolution')}>
                <span dir="auto">{data.resolutionSummary}</span>
              </Alert>
            ) : null}
          </Card>
          <ReplyComposer key={closed ? 'closed' : 'open'} ticket={data} />
        </div>

        <aside className="min-w-0 space-y-4">
          {NEXT[data.status].length ? (
            <Section title={t('desk.changeStatus')}>
              <div className="mt-3 flex flex-wrap gap-2">
                {NEXT[data.status].map((status) => (
                  <Button key={status} size="sm" variant={status === 'CLOSED' ? 'destructive-outline' : status === 'RESOLVED' ? 'default' : 'outline'} loading={busy === `status-${status}`} disabled={busy !== null} onClick={() => setStatus(status)}>
                    {data.status === 'RESOLVED' && status === 'IN_PROGRESS' ? t('desk.reopen') : t(`desk.setStatus.${status}`)}
                  </Button>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title={t('pc.details')}>
            <DescriptionList
              columns={1}
              className="mt-4"
              items={[
                { label: t('pc.centre'), value: <CentreCell centre={data.tenant} link={session.hasPermission('platform.tenants.read')} /> },
                {
                  label: t('desk.centreState'),
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      {data.tenant.status ? <StatusBadge kind="tenant" status={data.tenant.status} /> : null}
                      <span>{data.tenant.plan?.name ?? t('tenants.noPlan')}</span>
                    </span>
                  ),
                },
                { label: t('desk.columns.category'), value: data.category ? <span dir="auto">{data.category}</span> : null },
              ]}
            />
            <div className="mt-5 space-y-4">
              <Field label={t('desk.columns.priority')} htmlFor="ticket-priority">
                <Select
                  id="ticket-priority"
                  value={data.priority}
                  disabled={busy !== null || closed}
                  onValueChange={(priority) => (priority !== data.priority ? void patch('priority', { priority }, t('desk.prioritySaved')) : undefined)}
                  options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))}
                />
              </Field>
              <Field label={t('desk.columns.assignee')} htmlFor="ticket-assignee">
                {mayListStaff && staff.data ? (
                  <Select
                    id="ticket-assignee"
                    value={data.platformAssigneeId ?? NOBODY}
                    disabled={busy !== null || closed}
                    onValueChange={(value) => (value !== (data.platformAssigneeId ?? NOBODY) ? void assign(value === NOBODY ? null : value) : undefined)}
                    options={[
                      { value: NOBODY, label: t('desk.unassigned') },
                      ...staff.data.map((member) => ({ value: member.id, label: member.isYou ? t('desk.staffYou', { name: member.fullName }) : member.fullName })),
                      // Somebody who is assigned but no longer active stays visible.
                      ...(data.platformAssigneeId && !staff.data.some((member) => member.id === data.platformAssigneeId) ? [{ value: data.platformAssigneeId, label: data.platformAssigneeName ?? data.platformAssigneeId }] : []),
                    ]}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p id="ticket-assignee" className="text-base">
                      {data.platformAssigneeName ? <bdi>{data.platformAssigneeName}</bdi> : <span className="text-muted-foreground">{t('desk.unassigned')}</span>}
                    </p>
                    {closed ? null : data.platformAssigneeId === me ? (
                      <Button size="sm" variant="outline" loading={busy === 'assignee'} disabled={busy !== null} onClick={() => void assign(null)}>
                        <UserMinus aria-hidden="true" />
                        {t('desk.unassignMe')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" loading={busy === 'assignee'} disabled={busy !== null || !me} onClick={() => void assign(me ?? null)}>
                        <UserCheck aria-hidden="true" />
                        {t('desk.assignMe')}
                      </Button>
                    )}
                  </div>
                )}
              </Field>
            </div>
          </Section>

          <Section title={t('desk.times.title')}>
            <DescriptionList
              columns={1}
              className="mt-4"
              items={[
                { label: t('desk.times.firstResponse'), value: data.firstRespondedAt ? <span className="tabular">{formatDateTime(data.firstRespondedAt)}</span> : t('desk.times.notYet') },
                { label: t('desk.times.resolved'), value: data.resolvedAt ? <span className="tabular">{formatDateTime(data.resolvedAt)}</span> : null },
                { label: t('desk.times.closed'), value: data.closedAt ? <span className="tabular">{formatDateTime(data.closedAt)}</span> : null },
                { label: t('pc.updated'), value: <span className="tabular">{formatDateTime(data.updatedAt)}</span> },
              ]}
            />
          </Section>

          {session.hasPermission('platform.access.request') ? (
            <Section title={t('desk.access.title')} description={t('desk.access.text')}>
              <Button variant="outline" className="mt-3" onClick={() => setRequesting(true)}>
                <KeyRound aria-hidden="true" />
                {t('access.request.action')}
              </Button>
            </Section>
          ) : null}
        </aside>
      </div>

      <ConfirmReasonDialog
        open={!!target}
        onOpenChange={(open) => !open && setTarget(null)}
        tone={target === 'CLOSED' ? 'destructive' : 'default'}
        required={false}
        minLength={1}
        maxLength={1000}
        title={t(target === 'CLOSED' ? 'desk.close.title' : 'desk.resolve.title')}
        description={t(target === 'CLOSED' ? 'desk.close.text' : 'desk.resolve.text')}
        confirmLabel={t(target === 'CLOSED' ? 'desk.setStatus.CLOSED' : 'desk.setStatus.RESOLVED')}
        label={t('desk.resolutionSummary')}
        hint={t('desk.resolutionSummaryHint')}
        onConfirm={async (summary) => {
          const status = target!;
          await api.tickets.update(id, { status, resolutionSummary: summary || undefined });
          await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
          toasts.success(t(status === 'CLOSED' ? 'desk.close.done' : 'desk.resolve.done'));
        }}
      />
      <RequestAccessDialog open={requesting} onOpenChange={setRequesting} centre={{ id: data.tenant.id, name: data.tenant.name, slug: data.tenant.slug }} ticket={{ id: data.id, ticketNo: data.ticketNo }} />
    </>
  );
}

/**
 * The reply box. A reply goes to the centre unless "Internal note" is switched on
 * explicitly; the two modes look different so that nobody sends a note by mistake.
 */
function ReplyComposer({ ticket }: { ticket: PlatformTicket }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const closed = ticket.status === 'CLOSED';
  const form = useZodForm(platformStaffReplySchema, { defaultValues: { body: '', visibility: closed ? 'INTERNAL' : 'CUSTOMER', resolutionSummary: '' } });
  const internal = form.watch('visibility') === 'INTERNAL';
  const after = form.watch('status');

  return (
    <Card className={cn('p-4 sm:p-5', internal && 'border-warning/60 bg-warning-soft/60')}>
      <Form
        form={form}
        onSubmit={async (values) => {
          await api.tickets.reply(ticket.id, { ...values, status: internal ? undefined : values.status, resolutionSummary: !internal && values.status === 'RESOLVED' ? values.resolutionSummary : undefined });
          toasts.success(t(internal ? 'desk.noteAdded' : 'desk.replySent'), internal ? t('desk.noteAddedText') : t('desk.replySentText', { name: ticket.tenant.name }));
          await Promise.all([keys.tickets.all, keys.dashboard.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
          form.reset({ body: '', visibility: closed ? 'INTERNAL' : 'CUSTOMER', resolutionSummary: '', status: undefined });
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-md font-semibold">
            {internal ? <Lock className="size-4 text-warning-text" aria-hidden="true" /> : null}
            {t(internal ? 'desk.composeNote' : 'desk.composeReply')}
          </h2>
          <ChoiceLabel
            htmlFor="reply-internal"
            control={
              <Switch
                id="reply-internal"
                checked={internal}
                disabled={closed}
                onCheckedChange={(on) => {
                  form.setValue('visibility', on ? 'INTERNAL' : 'CUSTOMER');
                  if (on) form.setValue('status', undefined);
                }}
              />
            }
            label={t('desk.internalToggle')}
            description={t(closed ? 'desk.closedOnlyNotes' : 'desk.internalToggleHint')}
          />
        </div>
        <p className={cn('text-sm', internal ? 'font-medium text-warning-text' : 'text-muted-foreground')} role="status">
          {t(internal ? 'desk.willNotBeSeen' : 'desk.willBeSeen', { name: ticket.tenant.name })}
        </p>
        <FormField name="body" label={t(internal ? 'desk.noteBody' : 'desk.replyBody')} required>
          {(field) => <Textarea {...field} rows={4} dir="auto" maxLength={5000} />}
        </FormField>

        {internal ? null : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField name="status" label={t('desk.afterSending')}>
              {(field) => (
                <Select
                  {...field}
                  value={field.value || KEEP}
                  onValueChange={(v) => field.onChange(v === KEEP ? undefined : v)}
                  options={[
                    { value: KEEP, label: t('desk.afterKeep') },
                    { value: 'WAITING_CUSTOMER', label: t('desk.afterWaiting') },
                    { value: 'RESOLVED', label: t('desk.afterResolved') },
                  ]}
                />
              )}
            </FormField>
            {after === 'RESOLVED' ? (
              <FormField name="resolutionSummary" label={t('desk.resolutionSummary')} optional>
                {(field) => <Input {...field} dir="auto" maxLength={1000} />}
              </FormField>
            ) : null}
          </div>
        )}
        <FormError />
        <div className="flex justify-end">
          <Button type="submit" variant={internal ? 'outline' : 'default'} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {internal ? <Lock aria-hidden="true" /> : <Send className="rtl-mirror" aria-hidden="true" />}
            {t(internal ? 'desk.addNote' : 'desk.sendReply')}
          </Button>
        </div>
      </Form>
    </Card>
  );
}
