'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, MessageSquarePlus } from 'lucide-react';
import type { Page } from '@typease/types';
import { openPlatformTicketSchema } from '@typease/validation';
import {
  Button, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, PageHeader, RequirePermission,
  STATUS_META, Select, StatusBadge, Textarea, useApi, useI18n, useToast, useZodForm, type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import type { PlatformTicket, TicketPriority, TicketStatus } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'];
const PRIORITIES: TicketPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

export function PlatformTickets() {
  return (
    <RequirePermission anyOf={['settings.manage', 'ticket.manage']}>
      <PlatformTicketsList />
    </RequirePermission>
  );
}

/** Questions of the centre to TypEase support (not customer tickets: those never leave the centre). */
function PlatformTicketsList() {
  const { t, pick, formatRelative, formatDateTime } = useI18n();
  const api = useApi();
  const [creating, setCreating] = React.useState(false);

  const columns = React.useMemo<Array<DataTableColumn<PlatformTicket>>>(
    () => [
      { id: 'number', header: t('ops.support.columns.ticket'), mobile: 'title', className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.ticketNo}</span> },
      {
        id: 'subject',
        header: t('ops.support.columns.subject'),
        cell: (r) => (
          <>
            <span className="block max-w-96 truncate font-medium text-foreground" title={r.subject} dir="auto">
              {r.subject}
            </span>
            {r.category ? <span className="block text-sm text-muted-foreground">{r.category}</span> : null}
          </>
        ),
      },
      { id: 'status', header: t('ops.common.status'), mobile: 'badge', cell: (r) => <StatusBadge kind="ticket" status={r.status} label={r.status === 'WAITING_CUSTOMER' ? { en: t('ops.support.platform.waitingForYou'), ar: t('ops.support.platform.waitingForYou') } : undefined} /> },
      { id: 'priority', header: t('ops.support.columns.priority'), cell: (r) => (r.priority ? <StatusBadge kind="priority" status={r.priority} className={r.priority === 'HIGH' || r.priority === 'URGENT' ? undefined : 'bg-transparent px-0'} /> : null) },
      { id: 'updated', header: t('ops.support.columns.updated'), className: 'whitespace-nowrap', cell: (r) => <span title={formatDateTime(r.updatedAt)}>{formatRelative(r.updatedAt)}</span> },
    ],
    [t, formatRelative, formatDateTime],
  );
  const filters = React.useMemo<DataTableFilter[]>(() => [{ id: 'status', type: 'select', label: t('ops.common.status'), options: STATUSES.map((s) => ({ value: s, label: pick(STATUS_META.ticket[s].en, STATUS_META.ticket[s].ar) })) }], [t, pick]);

  const newButton = (
    <Button variant="accent" onClick={() => setCreating(true)}>
      <MessageSquarePlus aria-hidden="true" />
      {t('ops.support.platform.new')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('ops.support.platform.title')} description={t('ops.support.platform.description')} breadcrumbs={[{ label: t('ops.support.title'), href: '/support' }]} action={newButton} />
      <DataTable<PlatformTicket>
        caption={t('ops.support.platform.title')}
        queryKey={opsKeys.platformTickets.all}
        queryFn={({ page, pageSize, status }, signal) => api.client.get<Page<PlatformTicket>>('/support/platform-tickets', { query: { page, pageSize, status }, signal })}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/support/platform/${r.id}`}
        filters={filters}
        searchable={false}
        empty={{ icon: <LifeBuoy />, title: t('ops.support.platform.emptyTitle'), description: t('ops.support.platform.emptyText'), action: newButton }}
      />
      <NewPlatformTicketDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewPlatformTicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useZodForm(openPlatformTicketSchema);
  React.useEffect(() => {
    if (open) form.reset({ subject: '', message: '', category: '', priority: 'NORMAL' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const ticket = await api.client.post<PlatformTicket>('/support/platform-tickets', values);
            toasts.success(t('ops.support.platform.sent'), t('ops.support.platform.sentText', { number: ticket.ticketNo }));
            await queryClient.invalidateQueries({ queryKey: opsKeys.platformTickets.all });
            onOpenChange(false);
            router.push(`/support/platform/${ticket.id}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.support.platform.new')}</DialogTitle>
            <DialogDescription>{t('ops.support.platform.newText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="subject" label={t('ops.support.fields.subject')} required>
              {(field) => <Input {...field} dir="auto" autoComplete="off" autoFocus />}
            </FormField>
            <FormField name="message" label={t('ops.support.platform.message')} required hint={t('ops.support.platform.messageHint')}>
              {(field) => <Textarea {...field} rows={5} dir="auto" />}
            </FormField>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField name="category" label={t('ops.support.fields.category')} optional>
                {(field) => <Input {...field} dir="auto" autoComplete="off" placeholder={t('ops.support.platform.categoryPlaceholder')} />}
              </FormField>
              <FormField name="priority" label={t('ops.support.columns.priority')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))} />}
              </FormField>
            </div>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.support.platform.send')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
