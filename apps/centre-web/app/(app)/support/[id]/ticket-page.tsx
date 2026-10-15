'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Send } from 'lucide-react';
import { isApiError, uploadDocument, type UploadSummary } from '@typease/api-client';
import { staffReplySchema, ticketStatusSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, ChoiceLabel, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileUpload, Form,
  FormError, FormField, Input, PageHeader, PageSkeleton, RequirePermission, STATUS_META, Select, StatusBadge, Switch, Textarea, cn, focusRing, useApi, useApiClient, useErrorMessage, useI18n,
  useSession, useToast, useZodForm, type UploadItem,
} from '@typease/ui';
import { StaffPicker } from '@/components/pickers';
import { Panel, useRun } from '@/components/ops/common';
import { Conversation } from '@/components/ops/conversation';
import type { Ticket, TicketPriority, TicketStatus } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { SlaFlags, Stars } from '../support-page';

const PRIORITIES: TicketPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
/** What staff may change a status to (docs/api/modules/support.md). CLOSED is final. */
const NEXT: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};
const KEEP = '__keep__';

export function TicketPage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['ticket.read', 'ticket.manage']}>
      <TicketView id={id} />
    </RequirePermission>
  );
}

function TicketView({ id }: { id: string }) {
  const { t, pick, formatDateTime, formatRelative } = useI18n();
  const api = useApi();
  const session = useSession();
  const describe = useErrorMessage();
  const canManage = session.hasPermission('ticket.manage');
  const { run, busy } = useRun();
  const [target, setTarget] = React.useState<TicketStatus | null>(null);
  const ticket = useQuery({ queryKey: opsKeys.tickets.detail(id), queryFn: () => api.client.get<Ticket>(`/support/tickets/${id}`), retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2 });
  const crumbs = [{ label: t('ops.support.title'), href: '/support' }];
  const invalidate = [opsKeys.tickets.all];

  if (ticket.isPending) return <PageSkeleton label={t('common.loading')} />;
  if (ticket.isError) {
    return (
      <>
        <PageHeader title={t('ops.support.ticket')} breadcrumbs={crumbs} />
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={() => void ticket.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {describe(ticket.error)}
        </Alert>
      </>
    );
  }
  const data = ticket.data;
  const patch = (key: string, body: object, success: string) => run(key, () => api.client.patch(`/support/tickets/${id}`, body), { success, invalidate });
  const setStatus = (status: TicketStatus) => {
    // Resolving and closing ask for a word about the outcome; the other changes are immediate.
    if (status === 'RESOLVED' || status === 'CLOSED') return setTarget(status);
    return void run(`status-${status}`, () => api.client.post(`/support/tickets/${id}/status`, { status }), { success: t('ops.support.statusChanged'), invalidate });
  };

  const due = (dueAt: string | null, doneAt: string | null, late: boolean, doneKey: string) => {
    if (!dueAt) return t('ops.support.sla.none');
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="tabular">{formatDateTime(dueAt)}</span>
        {doneAt ? <Badge tone={late ? 'danger' : 'success'}>{t(late ? 'ops.support.sla.doneLate' : doneKey)}</Badge> : late ? <Badge tone="danger">{t('ops.support.sla.overdue')}</Badge> : <span className="text-sm text-muted-foreground">{formatRelative(dueAt)}</span>}
      </span>
    );
  };

  return (
    <>
      <PageHeader
        title={<span dir="auto">{data.subject}</span>}
        breadcrumbs={crumbs}
        description={
          <>
            <span className="tabular">{data.ticketNo}</span> · {t('ops.support.openedOn', { date: formatDateTime(data.createdAt) })}
          </>
        }
        meta={
          <>
            <StatusBadge kind="ticket" status={data.status} />
            {data.priority === 'HIGH' || data.priority === 'URGENT' ? <StatusBadge kind="priority" status={data.priority} /> : null}
            <SlaFlags ticket={data} />
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          <Card className="p-4 sm:p-5">
            <h2 className="mb-4 text-md font-semibold">{t('ops.support.conversation')}</h2>
            <Conversation
              usLabel={t('ops.support.staff')}
              themLabel={data.customerName ?? t('ops.common.customer')}
              messages={(data.messages ?? []).map((m) => ({ id: m.id, side: m.authorType === 'STAFF' ? 'us' : 'them', authorName: m.authorName, internal: m.visibility === 'INTERNAL', body: m.body, attachments: m.attachments, createdAt: m.createdAt }))}
            />
            {data.resolutionSummary ? (
              <Alert tone="success" className="mt-4" title={t('ops.support.resolution')}>
                <span dir="auto">{data.resolutionSummary}</span>
              </Alert>
            ) : null}
          </Card>
          {canManage ? <ReplyComposer key={data.status === 'CLOSED' ? 'closed' : 'open'} ticket={data} /> : null}
        </div>

        <aside className="min-w-0 space-y-4">
          {canManage && NEXT[data.status].length ? (
            <Panel title={t('ops.support.changeStatus')}>
              <div className="flex flex-wrap gap-2">
                {NEXT[data.status].map((status) => (
                  <Button key={status} size="sm" variant={status === 'CLOSED' ? 'destructive-outline' : status === 'RESOLVED' ? 'default' : 'outline'} loading={busy === `status-${status}`} onClick={() => setStatus(status)}>
                    {data.status === 'RESOLVED' && status === 'IN_PROGRESS' ? t('ops.support.reopenTicket') : t(`ops.support.setStatus.${status}`)}
                  </Button>
                ))}
              </div>
            </Panel>
          ) : null}

          <Panel title={t('ops.common.details')}>
            <DescriptionList
              columns={1}
              items={[
                {
                  label: t('ops.common.customer'),
                  value: data.customerId ? (
                    <Link href={`/customers/${data.customerId}`} className={cn('rounded-sm text-secondary-text hover:underline', focusRing)}>
                      {data.customerName} <span className="tabular text-sm text-muted-foreground">{data.customerNo}</span>
                    </Link>
                  ) : null,
                },
                {
                  label: t('ops.support.linkedRequest'),
                  value: data.requestId ? (
                    <Link href={`/requests/${data.requestId}`} className={cn('tabular rounded-sm text-secondary-text hover:underline', focusRing)}>
                      {data.requestNo}
                    </Link>
                  ) : (
                    t('ops.common.none')
                  ),
                },
              ]}
            />
            <div className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="ticket-priority" className="text-sm font-medium">
                  {t('ops.support.columns.priority')}
                </label>
                <Select
                  id="ticket-priority"
                  value={data.priority}
                  disabled={!canManage || busy !== null || data.status === 'CLOSED'}
                  onValueChange={(priority) => void patch('priority', { priority }, t('ops.support.prioritySaved'))}
                  options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ticket-assignee" className="text-sm font-medium">
                  {t('ops.support.columns.assignee')}
                </label>
                {canManage ? (
                  <StaffPicker id="ticket-assignee" value={data.assigneeId} selectedLabel={data.assigneeName} disabled={busy !== null || data.status === 'CLOSED'} placeholder={t('ops.support.unassigned')} onChange={(assigneeId) => void patch('assignee', { assigneeId: assigneeId || null }, t(assigneeId ? 'ops.support.assigned' : 'ops.support.unassignedDone'))} />
                ) : (
                  <p>{data.assigneeName ?? t('ops.support.unassigned')}</p>
                )}
              </div>
              <CategoryField ticket={data} editable={canManage && data.status !== 'CLOSED'} />
            </div>
          </Panel>

          <Panel title={t('ops.support.sla.timers')} description={t('ops.support.sla.timersText')}>
            <DescriptionList
              columns={1}
              items={[
                { label: t('ops.support.sla.firstResponseDue'), value: due(data.firstResponseDueAt, data.firstRespondedAt, data.firstResponseBreached, 'ops.support.sla.respondedInTime') },
                { label: t('ops.support.sla.firstRespondedAt'), value: data.firstRespondedAt ? formatDateTime(data.firstRespondedAt) : null },
                { label: t('ops.support.sla.resolutionDue'), value: due(data.resolutionDueAt, data.resolvedAt, data.resolutionBreached, 'ops.support.sla.resolvedInTime') },
                { label: t('ops.support.sla.resolvedAt'), value: data.resolvedAt ? formatDateTime(data.resolvedAt) : null },
              ]}
            />
          </Panel>

          {data.feedback ? (
            <Panel title={t('ops.support.feedback.title')}>
              <Stars rating={data.feedback.rating} />
              {data.feedback.comment ? (
                <p className="mt-2 text-base" dir="auto">
                  “{data.feedback.comment}”
                </p>
              ) : null}
              <p className="mt-1 text-sm text-muted-foreground">{formatDateTime(data.feedback.createdAt)}</p>
            </Panel>
          ) : null}
        </aside>
      </div>

      <StatusDialog ticketId={id} target={target} onClose={() => setTarget(null)} />
    </>
  );
}

function CategoryField({ ticket, editable }: { ticket: Ticket; editable: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const { run, busy } = useRun();
  const [value, setValue] = React.useState(ticket.category ?? '');
  React.useEffect(() => setValue(ticket.category ?? ''), [ticket.category]);
  const dirty = value.trim() !== (ticket.category ?? '');
  return (
    <div className="space-y-1.5">
      <label htmlFor="ticket-category" className="text-sm font-medium">
        {t('ops.support.fields.category')}
      </label>
      <div className="flex gap-2">
        <Input id="ticket-category" value={value} onChange={(e) => setValue(e.target.value)} disabled={!editable} dir="auto" maxLength={60} />
        {dirty && editable ? (
          <Button
            variant="outline"
            loading={busy === 'category'}
            onClick={() => void run('category', () => api.client.patch(`/support/tickets/${ticket.id}`, { category: value.trim() || null }), { success: t('ops.support.categorySaved'), invalidate: [opsKeys.tickets.all] })}
          >
            {t('common.save')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The reply box. A reply goes to the customer unless "Internal note" is switched on
 * explicitly; the two modes look different so that nobody sends a note by mistake.
 */
function ReplyComposer({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n();
  const api = useApi();
  const client = useApiClient();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const closed = ticket.status === 'CLOSED';
  const form = useZodForm(staffReplySchema, { defaultValues: { body: '', visibility: closed ? 'INTERNAL' : 'CUSTOMER', attachments: [], resolutionSummary: '' } });
  const visibility = form.watch('visibility');
  const internal = visibility === 'INTERNAL';
  const after = form.watch('status');
  const [uploads, setUploads] = React.useState(0);
  const [uploaderKey, setUploaderKey] = React.useState(0);
  const canAttach = !!ticket.customerId && session.hasPermission('document.upload');

  const setInternal = (on: boolean) => {
    form.setValue('visibility', on ? 'INTERNAL' : 'CUSTOMER');
    if (on) form.setValue('status', undefined);
    // Files are stored as visible / not visible to the customer when they are uploaded: start over.
    form.setValue('attachments', []);
    setUploaderKey((k) => k + 1);
  };

  return (
    <Card className={cn('p-4 sm:p-5', internal && 'border-warning/60 bg-warning-soft/60')}>
      <Form
        form={form}
        onSubmit={async (values) => {
          await api.client.post(`/support/tickets/${ticket.id}/messages`, { ...values, status: internal ? undefined : values.status, resolutionSummary: !internal && values.status === 'RESOLVED' ? values.resolutionSummary : undefined });
          toasts.success(t(internal ? 'ops.support.noteAdded' : 'ops.support.replySent'), internal ? t('ops.support.noteAddedText') : t('ops.support.replySentText'));
          await queryClient.invalidateQueries({ queryKey: opsKeys.tickets.all });
          form.reset({ body: '', visibility: closed ? 'INTERNAL' : 'CUSTOMER', attachments: [], resolutionSummary: '', status: undefined });
          setUploaderKey((k) => k + 1);
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-md font-semibold">
            {internal ? <Lock className="size-4 text-warning-text" aria-hidden="true" /> : null}
            {t(internal ? 'ops.support.composeNote' : 'ops.support.composeReply')}
          </h2>
          <ChoiceLabel
            htmlFor="reply-internal"
            control={<Switch id="reply-internal" checked={internal} onCheckedChange={setInternal} disabled={closed} />}
            label={t('ops.support.internalToggle')}
            description={t(closed ? 'ops.support.closedOnlyNotes' : 'ops.support.internalToggleHint')}
          />
        </div>
        <p className={cn('text-sm', internal ? 'font-medium text-warning-text' : 'text-muted-foreground')} role="status">
          {t(internal ? 'ops.support.willNotBeSeen' : 'ops.support.willBeSeen', { name: ticket.customerName ?? '' })}
        </p>
        <FormField name="body" label={t(internal ? 'ops.support.noteBody' : 'ops.support.replyBody')} required>
          {(field) => <Textarea {...field} rows={4} dir="auto" />}
        </FormField>

        {canAttach ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('ops.support.attachments')}</p>
            <FileUpload<UploadSummary>
              key={uploaderKey}
              multiple
              maxFiles={10}
              accept={['application/pdf', 'image/*']}
              acceptLabel="PDF, JPG, PNG"
              upload={(file, options) => uploadDocument(client, { file, customerId: ticket.customerId ?? undefined, requestId: ticket.requestId ?? undefined, documentTypeKey: 'other', title: file.name, customerVisible: !internal, ...options })}
              onFilesChange={(items: Array<UploadItem<UploadSummary>>) => {
                setUploads(items.filter((i) => i.status === 'uploading' || i.status === 'queued').length);
                form.setValue('attachments', items.filter((i) => i.status === 'done' && i.result).map((i) => i.result!.documentId));
              }}
            />
            <p className="text-sm text-muted-foreground">{t(internal ? 'ops.support.attachmentsInternalHint' : 'ops.support.attachmentsHint')}</p>
          </div>
        ) : null}

        {internal ? null : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField name="status" label={t('ops.support.afterSending')}>
              {(field) => (
                <Select
                  {...field}
                  value={field.value || KEEP}
                  onValueChange={(v) => field.onChange(v === KEEP ? undefined : v)}
                  options={[
                    { value: KEEP, label: t('ops.support.afterKeep') },
                    { value: 'WAITING_CUSTOMER', label: t('ops.support.afterWaiting') },
                    { value: 'RESOLVED', label: t('ops.support.afterResolved') },
                  ]}
                />
              )}
            </FormField>
            {after === 'RESOLVED' ? (
              <FormField name="resolutionSummary" label={t('ops.support.resolutionSummary')} optional>
                {(field) => <Input {...field} dir="auto" />}
              </FormField>
            ) : null}
          </div>
        )}
        <FormError />
        <div className="flex justify-end">
          <Button type="submit" variant={internal ? 'outline' : 'default'} disabled={uploads > 0} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {internal ? <Lock aria-hidden="true" /> : <Send className="rtl-mirror" aria-hidden="true" />}
            {t(internal ? 'ops.support.addNote' : 'ops.support.sendReply')}
          </Button>
        </div>
      </Form>
    </Card>
  );
}

function StatusDialog({ ticketId, target, onClose }: { ticketId: string; target: TicketStatus | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(ticketStatusSchema);
  React.useEffect(() => {
    if (target) form.reset({ status: target, resolutionSummary: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.client.post(`/support/tickets/${ticketId}/status`, values);
            toasts.success(t(target === 'CLOSED' ? 'ops.support.closedDone' : 'ops.support.resolvedDone'));
            await queryClient.invalidateQueries({ queryKey: opsKeys.tickets.all });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(target === 'CLOSED' ? 'ops.support.closeTitle' : 'ops.support.resolveTitle')}</DialogTitle>
            <DialogDescription>{t(target === 'CLOSED' ? 'ops.support.closeText' : 'ops.support.resolveText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="resolutionSummary" label={t('ops.support.resolutionSummary')} optional hint={t('ops.support.resolutionSummaryHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={target === 'CLOSED' ? 'destructive' : 'default'} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t(target === 'CLOSED' ? 'ops.support.setStatus.CLOSED' : 'ops.support.setStatus.RESOLVED')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

