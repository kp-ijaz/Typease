'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, MessageCirclePlus } from 'lucide-react';
import { uploadDocument, type UploadSummary } from '@typease/api-client';
import { openTicketSchema } from '@typease/validation';
import {
  Button, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FileUpload, Form, FormError, FormField, Input, PageHeader, Select,
  STATUS_META, StatusBadge, Textarea, useApiClient, useBranding, useI18n, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type UploadItem,
} from '@typease/ui';
import { UPLOAD_ACCEPT, UPLOAD_ACCEPT_LABEL } from '@/components/portal/checklist';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { TicketRow } from '@/lib/types';

/** Stored with the ticket in English (the centre's team reads one list); shown to the customer in their language. */
export const TICKET_CATEGORIES = ['Request status', 'Documents', 'Payment', 'Appointment', 'Account', 'Other'] as const;
const categoryKey = (category: string) => category.toLowerCase().replace(/[^a-z]+/g, '_');
/** A category in the reader's language when it is one of ours; anything the centre typed is shown as typed. */
export function useCategoryLabel() {
  const { t, has } = useI18n();
  return React.useCallback((category: string | null) => (category ? (has(`my.support.categories.${categoryKey(category)}`) ? t(`my.support.categories.${categoryKey(category)}`) : category) : null), [t, has]);
}

/** For the customer "waiting for customer" means "waiting for your reply". */
export function TicketStatus({ status, className }: { status: string; className?: string }) {
  const { t } = useI18n();
  const mine = status === 'WAITING_CUSTOMER' ? t('my.support.waitingForYou') : null;
  return <StatusBadge kind="ticket" status={status} label={mine ? { en: mine, ar: mine } : undefined} className={className} />;
}

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
const NO_REQUEST = '__none__';

/** Questions to the centre that are not tied to the Messages tab of one request: ask, follow the answer, reopen. */
export function SupportList() {
  const { t, pick, formatRelative } = useI18n();
  const api = usePortalApi();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const categoryLabel = useCategoryLabel();
  const [creating, setCreating] = React.useState<{ requestId?: string } | null>(() => (search.get('new') ? { requestId: search.get('requestId') ?? undefined } : null));

  const close = () => {
    setCreating(null);
    if (search.get('new')) router.replace(pathname, { scroll: false });
  };
  const askButton = (
    <Button variant="accent" size="lg" className="sm:h-10 sm:px-4 sm:text-base" onClick={() => setCreating({})}>
      <MessageCirclePlus aria-hidden="true" />
      {t('my.support.ask')}
    </Button>
  );

  const columns = React.useMemo<Array<DataTableColumn<TicketRow>>>(
    () => [
      { id: 'subject', header: t('my.support.columns.subject'), mobile: 'title', cell: (r) => <span dir="auto">{r.subject}</span> },
      { id: 'status', header: t('my.requests.columns.status'), mobile: 'badge', cell: (r) => <TicketStatus status={r.status} /> },
      { id: 'number', header: t('my.support.columns.number'), className: 'whitespace-nowrap', cell: (r) => <span className="tabular ltr-value">{r.ticketNo}</span> },
      { id: 'category', header: t('my.support.columns.category'), cell: (r) => categoryLabel(r.category) },
      { id: 'request', header: t('my.quotations.columns.request'), className: 'whitespace-nowrap', cell: (r) => (r.requestNo ? <span className="tabular ltr-value">{r.requestNo}</span> : null) },
      { id: 'updated', header: t('my.support.columns.updated'), className: 'whitespace-nowrap', cell: (r) => formatRelative(r.updatedAt) },
    ],
    [t, formatRelative, categoryLabel],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'status', type: 'select', label: t('my.requests.columns.status'), options: STATUSES.map((s) => ({ value: s, label: s === 'WAITING_CUSTOMER' ? t('my.support.waitingForYou') : pick(...statusPair(s)) })) }],
    [t, pick],
  );

  return (
    <>
      <PageHeader title={t('nav.support')} description={t('my.support.description')} action={askButton} />
      <DataTable<TicketRow>
        caption={t('nav.support')}
        queryKey={keys.tickets.all}
        queryFn={(params, signal) => api.tickets(params, signal)}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/support/${r.id}`}
        filters={filters}
        searchable={false}
        empty={{ icon: <LifeBuoy />, title: t('my.support.emptyTitle'), description: t('my.support.emptyText'), action: askButton }}
      />
      {creating ? <NewTicketDialog requestId={creating.requestId} onClose={close} onCreated={(id) => router.push(`/support/${id}`)} /> : null}
    </>
  );
}

const statusPair = (status: (typeof STATUSES)[number]): [string, string] => [STATUS_META.ticket[status].en, STATUS_META.ticket[status].ar];

function NewTicketDialog({ requestId, onClose, onCreated }: { requestId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const client = useApiClient();
  const toasts = useToast();
  const { name } = useBranding();
  const queryClient = useQueryClient();
  const categoryLabel = useCategoryLabel();
  const requests = useQuery({ queryKey: keys.requests.recent, queryFn: ({ signal }) => api.requests({ pageSize: 50, sort: 'updatedAt:desc' }, signal) });
  const form = useZodForm(openTicketSchema, { defaultValues: { subject: '', message: '', category: '', requestId: requestId ?? '', attachments: [] } });
  const [uploads, setUploads] = React.useState(0);
  const options = (requests.data?.data ?? []).filter((r) => r.status !== 'DRAFT');

  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const ticket = await api.openTicket({ ...values, requestId: values.requestId || null });
            await queryClient.invalidateQueries({ queryKey: keys.tickets.all });
            toasts.success(t('my.support.sent', { number: ticket.ticketNo }), t('my.support.sentText', { centre: name }));
            onCreated(ticket.id);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('my.support.ask')}</DialogTitle>
            <DialogDescription>{t('my.support.askText', { centre: name })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="subject" label={t('my.support.fields.subject')} required hint={t('my.support.fields.subjectHint')}>
              {(field) => <Input {...field} dir="auto" autoComplete="off" maxLength={160} autoFocus />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="category" label={t('my.support.fields.category')} optional>
                {(field) => <Select {...field} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={TICKET_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) ?? c }))} />}
              </FormField>
              <FormField name="requestId" label={t('my.support.fields.request')} optional>
                {(field) => (
                  <Select
                    {...field}
                    value={field.value || NO_REQUEST}
                    onValueChange={(v) => field.onChange(v === NO_REQUEST ? '' : v)}
                    options={[{ value: NO_REQUEST, label: t('my.support.fields.noRequest') }, ...options.map((r) => ({ value: r.id, label: `${r.requestNo} – ${pick(r.service.name, r.service.nameAr)}` }))]}
                    className="[&>span]:truncate"
                  />
                )}
              </FormField>
            </div>
            <FormField name="message" label={t('my.support.fields.message')} required>
              {(field) => <Textarea {...field} rows={5} dir="auto" maxLength={5000} />}
            </FormField>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">
                {t('my.support.fields.attachments')} <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
              </p>
              <FileUpload<UploadSummary>
                multiple
                maxFiles={5}
                accept={UPLOAD_ACCEPT}
                acceptLabel={UPLOAD_ACCEPT_LABEL}
                capture="environment"
                // Filed in the customer's own vault (not under the request: a closed request takes no more files).
                upload={(file, o) => uploadDocument(client, { file, documentTypeKey: 'other', title: file.name, ...o })}
                onFilesChange={(items: Array<UploadItem<UploadSummary>>) => {
                  setUploads(items.filter((i) => i.status === 'uploading' || i.status === 'queued').length);
                  form.setValue('attachments', items.filter((i) => i.status === 'done' && i.result).map((i) => i.result!.documentId));
                }}
              />
            </div>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={uploads > 0} loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('my.support.send')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
