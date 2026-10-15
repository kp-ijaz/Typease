'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, Inbox, Plus, ShieldQuestion } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import type { Page } from '@typease/types';
import { PRIVACY_REQUEST_STATUSES, PRIVACY_REQUEST_TYPES, privacyStaffRequestSchema } from '@typease/validation';
import {
  Alert, Badge, Button, ConfirmDialog, DataTable, DatePicker, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField,
  Select, Skeleton, StatusBadge, Textarea, useApi, useI18n, useToast, useZodForm, type DataTableColumn, type DataTableFilter,
} from '@typease/ui';
import { CustomerPicker } from '@/components/pickers';
import { ActionError, Field, LoadError } from '@/components/adm/shared';
import type { ErasureBlocking, PrivacyRequestRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { REQUEST_STATUS_TONE, usePrivacyLabels } from './labels';

/** Data-subject requests: the list, recording one received at the counter, and the review workflow of each. */
export function RequestsTab() {
  const { t, formatDate } = useI18n();
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const labels = usePrivacyLabels();
  const openId = params.get('request');
  const [adding, setAdding] = React.useState(false);

  const href = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('request', id);
    else next.delete('request');
    return `${pathname}?${next.toString()}`;
  };

  const columns = React.useMemo<Array<DataTableColumn<PrivacyRequestRow>>>(
    () => [
      {
        id: 'customer',
        header: t('adm.privacy.requests.customer'),
        mobile: 'title',
        cell: (r) => (
          <>
            <span className="block">{r.customer?.fullName ?? t('adm.privacy.requests.unknownCustomer')}</span>
            {r.customer ? <span className="tabular block text-sm font-normal text-muted-foreground">{r.customer.customerNo}</span> : null}
          </>
        ),
      },
      { id: 'type', header: t('adm.privacy.requests.type'), cell: (r) => labels.requestType(r.type) },
      {
        id: 'status',
        header: t('adm.privacy.requests.status'),
        mobile: 'badge',
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge tone={REQUEST_STATUS_TONE[r.status] ?? 'neutral'}>{labels.requestStatus(r.status)}</Badge>
            {r.overdue ? <Badge tone="danger">{t('adm.privacy.requests.overdue')}</Badge> : null}
          </span>
        ),
      },
      { id: 'due', header: t('adm.privacy.requests.due'), sortField: 'dueAt', className: 'whitespace-nowrap tabular', cell: (r) => (r.dueAt ? formatDate(r.dueAt) : null) },
      { id: 'created', header: t('adm.privacy.requests.received'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (r) => formatDate(r.createdAt) },
    ],
    [t, labels, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('adm.privacy.requests.status'), options: PRIVACY_REQUEST_STATUSES.map((s) => ({ value: s, label: labels.requestStatus(s) })) },
      { id: 'type', type: 'select', label: t('adm.privacy.requests.type'), options: PRIVACY_REQUEST_TYPES.map((s) => ({ value: s, label: labels.requestType(s) })) },
      { id: 'overdue', type: 'select', label: t('adm.privacy.requests.overdue'), allLabel: t('common.all'), options: [{ value: 'true', label: t('adm.privacy.requests.overdueOnly') }] },
    ],
    [t, labels],
  );

  const add = (
    <Button variant="accent" onClick={() => setAdding(true)}>
      <Plus aria-hidden="true" />
      {t('adm.privacy.requests.add')}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('adm.privacy.requests.intro')}</p>
        {add}
      </div>
      <DataTable<PrivacyRequestRow>
        caption={t('adm.privacy.tabs.requests')}
        queryKey={admKeys.privacy.requests}
        queryFn={({ tab: _tab, request: _request, ...query }, signal) => api.client.get<Page<PrivacyRequestRow>>('/privacy/requests', { query, signal })}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => href(r.id)}
        filters={filters}
        searchable={false}
        defaultSort="createdAt:desc"
        empty={{ icon: <Inbox />, title: t('adm.privacy.requests.emptyTitle'), description: t('adm.privacy.requests.emptyText'), action: add }}
      />
      <NewRequestDialog open={adding} onOpenChange={setAdding} />
      <RequestDialog id={openId} onClose={() => router.replace(href(null), { scroll: false })} />
    </div>
  );
}

function NewRequestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const form = useZodForm(privacyStaffRequestSchema, { defaultValues: { customerId: '', type: 'ACCESS', details: '', dueAt: '' } });
  React.useEffect(() => {
    if (open) form.reset({ customerId: '', type: 'ACCESS', details: '', dueAt: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.client.post('/privacy/requests', values);
            toasts.success(t('adm.privacy.requests.added'));
            await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('adm.privacy.requests.addTitle')}</DialogTitle>
            <DialogDescription>{t('adm.privacy.requests.addText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="customerId" label={t('adm.privacy.requests.customer')} required>
              {(field) => <CustomerPicker id={field.id} value={field.value || null} onChange={(id) => field.onChange(id)} onBlur={field.onBlur} aria-invalid={field['aria-invalid']} aria-describedby={field['aria-describedby']} />}
            </FormField>
            <FormField name="type" label={t('adm.privacy.requests.type')} required hint={t(`adm.privacy.requests.typeHints.${form.watch('type') ?? 'ACCESS'}`)}>
              {(field) => <Select {...field} onValueChange={field.onChange} options={PRIVACY_REQUEST_TYPES.map((s) => ({ value: s, label: labels.requestType(s) }))} />}
            </FormField>
            <FormField name="details" label={t('adm.privacy.requests.details')} optional hint={t('adm.privacy.requests.detailsHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={2000} />}
            </FormField>
            <FormField name="dueAt" label={t('adm.privacy.requests.due')} optional hint={t('adm.privacy.requests.dueHint')}>
              {(field) => <DatePicker {...field} min={today()} className="sm:max-w-52" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('adm.privacy.requests.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an erasure does, keeps and cannot reach, as docs/api/modules/privacy.md ("Erasure") states it.
 * The wording lives in the dictionary; this is only the order of the points.
 */
const ERASURE_POINTS = {
  removed: ['profile', 'requests', 'documents', 'messages', 'other', 'access'],
  kept: ['finance', 'closedRequests', 'trails', 'heldDocuments', 'login'],
  notReached: ['invoiceText', 'delivered', 'otherRoles', 'references', 'backups'],
} as const;

/** One request: what was asked, where it stands, and the next step of the workflow with what it will do. */
function RequestDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, formatDate, formatDateTime, formatNumber, formatMoney } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const request = useQuery({ queryKey: admKeys.privacy.request(id ?? ''), queryFn: () => api.client.get<PrivacyRequestRow>(`/privacy/requests/${id}`), enabled: !!id });
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [confirmErase, setConfirmErase] = React.useState(false);
  const noteId = React.useId();

  React.useEffect(() => {
    setNote('');
    setError(null);
  }, [id, request.data?.status]);

  const act = async (kind: 'review' | 'approve' | 'reject' | 'complete') => {
    if (!id) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'review') await api.client.post(`/privacy/requests/${id}/review`);
      else if (kind === 'complete') await api.client.post(`/privacy/requests/${id}/complete`, { note: note.trim() || undefined });
      else await api.client.post(`/privacy/requests/${id}/decision`, { decision: kind === 'approve' ? 'APPROVED' : 'REJECTED', decisionNote: note.trim() });
      toasts.success(t(`adm.privacy.requests.done.${kind}`));
    } catch (e) {
      setError(e);
    } finally {
      // Also after a refusal: the API stores why (for example the retention exception of a blocked erasure).
      await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
      setBusy(null);
    }
  };

  const r = request.data;
  const impact = r?.erasureImpact;
  // 409 ERASURE_BLOCKED: nothing was deleted. The answer names the open requests and unpaid invoices that stand in the way.
  const refused = isApiError(error) && error.code === 'ERASURE_BLOCKED' ? error : null;
  const blocking = refused ? ((refused.details as { blocking?: ErasureBlocking } | undefined)?.blocking ?? null) : null;
  const blockedText = r && r.status !== 'COMPLETED' ? (refused?.message ?? r.retentionException) : null;
  const deciding = r && (r.status === 'RECEIVED' || r.status === 'IN_REVIEW');
  const noteOk = note.trim().length >= 5;

  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {r ? t('adm.privacy.requests.detailTitle', { type: labels.requestType(r.type) }) : t('adm.privacy.tabs.requests')}
            {r ? <Badge tone={REQUEST_STATUS_TONE[r.status] ?? 'neutral'}>{labels.requestStatus(r.status)}</Badge> : null}
            {r?.overdue ? <Badge tone="danger">{t('adm.privacy.requests.overdue')}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{r ? t(`adm.privacy.requests.typeHints.${r.type}`) : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {request.isPending ? (
            <Skeleton className="h-48" />
          ) : request.isError ? (
            <LoadError error={request.error} onRetry={() => void request.refetch()} />
          ) : r ? (
            <>
              <DescriptionList
                items={[
                  {
                    label: t('adm.privacy.requests.customer'),
                    value: r.customer ? (
                      <Link href={`/customers/${r.customer.id}`} className="text-secondary-text underline-offset-4 hover:underline">
                        {r.customer.fullName} <span className="tabular text-muted-foreground">{r.customer.customerNo}</span>
                      </Link>
                    ) : null,
                  },
                  { label: t('adm.privacy.requests.received'), value: formatDateTime(r.createdAt) },
                  { label: t('adm.privacy.requests.due'), value: r.dueAt ? formatDate(r.dueAt) : null },
                  { label: t('adm.privacy.requests.completedAt'), value: r.completedAt ? formatDateTime(r.completedAt) : null },
                  { label: t('adm.privacy.requests.details'), value: r.details ? <span dir="auto">{r.details}</span> : null, wide: true },
                  ...(r.decisionNote ? [{ label: t('adm.privacy.requests.decisionNote'), value: <span className="whitespace-pre-line" dir="auto">{r.decisionNote}</span>, wide: true }] : []),
                ]}
              />

              {r.status === 'COMPLETED' && r.type === 'DELETION' ? <Alert tone="success" title={t('adm.privacy.requests.erasedTitle')}>{t('adm.privacy.requests.erasedText')}</Alert> : null}

              {r.status === 'COMPLETED' && r.retentionException ? (
                <Alert tone="warning" title={t('adm.privacy.requests.retainedTitle')}>
                  <span className="whitespace-pre-line break-words" dir="auto">
                    {r.retentionException}
                  </span>
                </Alert>
              ) : null}

              {/* A blocked erasure: the API's sentence in full (it can be long), then what stands in the way, each a link. */}
              {blockedText ? (
                <Alert tone="warning" live={!!refused} title={t('adm.privacy.requests.blockedTitle')} data-erasure-blocked="">
                  <p className="whitespace-pre-line break-words" dir="auto">
                    {blockedText}
                  </p>
                  {blocking && (blocking.requests.length || blocking.invoices.length) ? (
                    <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
                      {blocking.requests.length ? (
                        <div>
                          <p className="text-sm font-medium">{t('adm.privacy.requests.blocking.requests')}</p>
                          <ul className="mt-1 space-y-1">
                            {blocking.requests.map((x) => (
                              <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <Link href={`/requests/${x.id}`} className="tabular font-medium text-secondary-text underline underline-offset-4">
                                  {x.requestNo}
                                </Link>
                                <StatusBadge kind="request" status={x.status} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {blocking.invoices.length ? (
                        <div>
                          <p className="text-sm font-medium">{t('adm.privacy.requests.blocking.invoices')}</p>
                          <ul className="mt-1 space-y-1">
                            {blocking.invoices.map((x) => (
                              <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <Link href={`/invoices/${x.id}`} className="tabular font-medium text-secondary-text underline underline-offset-4">
                                  {x.invoiceNo}
                                </Link>
                                <span className="tabular text-sm">{t('adm.privacy.requests.blocking.balance', { amount: formatMoney(x.balanceDue, x.currency) })}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : r.customer ? (
                    <p className="mt-2 text-sm">
                      <Link href={`/customers/${r.customer.id}`} className="font-medium text-secondary-text underline underline-offset-4">
                        {t('adm.privacy.requests.blocking.openCustomer')}
                      </Link>
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm text-muted-foreground">{t('adm.privacy.requests.blocking.nothingDeleted')}</p>
                </Alert>
              ) : null}

              {r.exportDocumentId ? (
                <Alert
                  tone="success"
                  title={t('adm.privacy.requests.exportTitle')}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/documents/${r.exportDocumentId}`}>
                        <FileDown aria-hidden="true" />
                        {t('adm.privacy.requests.exportOpen')}
                      </Link>
                    </Button>
                  }
                >
                  {t('adm.privacy.requests.exportText')}
                </Alert>
              ) : null}

              {impact ? (
                <section className="rounded-lg border p-4">
                  <h3 className="flex items-center gap-2 text-md font-semibold">
                    <ShieldQuestion className="size-4 text-muted-foreground" aria-hidden="true" />
                    {t('adm.privacy.requests.impact.title')}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{impact.canProceed ? t('adm.privacy.requests.impact.canProceed') : t('adm.privacy.requests.impact.blocked')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('adm.privacy.requests.impact.merged')}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                    {(['openRequests', 'unpaidInvoices', 'closedRequests', 'invoices', 'payments', 'documents', 'heldDocuments'] as const).map((k) => (
                      <div key={k}>
                        <dt className="text-muted-foreground">{t(`adm.privacy.requests.impact.${k}`)}</dt>
                        <dd className={(k === 'openRequests' || k === 'unpaidInvoices') && impact[k] > 0 ? 'tabular text-base font-semibold text-destructive-text' : 'tabular text-base font-semibold'}>{formatNumber(impact[k])}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {r.type === 'DELETION' && r.status !== 'REJECTED' ? (
                <details className="group rounded-lg border">
                  <summary className="cursor-pointer select-none rounded-lg px-4 py-3 text-base font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">{t('adm.privacy.requests.erasure.summary')}</summary>
                  <div className="space-y-4 border-t px-4 py-3 text-base">
                    {(['removed', 'kept', 'notReached'] as const).map((part) => (
                      <div key={part}>
                        <p className="font-medium">{t(`adm.privacy.requests.erasure.${part}.title`)}</p>
                        <ul className="mt-1 list-disc space-y-1 ps-5 text-muted-foreground">
                          {ERASURE_POINTS[part].map((point) => (
                            <li key={point}>{t(`adm.privacy.requests.erasure.${part}.${point}`)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              {r.status === 'RECEIVED' || r.status === 'IN_REVIEW' || r.status === 'APPROVED' ? (
                <section className="space-y-3 rounded-lg border bg-muted/30 p-4">
                  <h3 className="text-md font-semibold">{t('adm.privacy.requests.nextTitle')}</h3>
                  <p className="text-base text-muted-foreground">{r.status === 'APPROVED' ? t(`adm.privacy.requests.completeHints.${r.type}`) : r.status === 'RECEIVED' ? t('adm.privacy.requests.receivedHint') : t('adm.privacy.requests.reviewHint')}</p>
                  <Field
                    label={r.status === 'APPROVED' ? t('adm.privacy.requests.completionNote') : t('adm.privacy.requests.decisionNoteInput')}
                    htmlFor={noteId}
                    hint={r.status === 'APPROVED' ? (r.type === 'CORRECTION' ? t('adm.privacy.requests.completionNoteRequired') : t('adm.privacy.requests.completionNoteHint')) : t('adm.privacy.requests.decisionNoteHint')}
                  >
                    <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={2} dir="auto" maxLength={1000} />
                  </Field>
                </section>
              ) : null}
              {refused ? null : <ActionError error={error} />}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!busy}>
            {t('common.close')}
          </Button>
          {r?.status === 'RECEIVED' ? (
            <Button variant="outline" loading={busy === 'review'} disabled={!!busy} onClick={() => void act('review')}>
              {t('adm.privacy.requests.actions.review')}
            </Button>
          ) : null}
          {deciding ? (
            <>
              <Button variant="destructive-outline" loading={busy === 'reject'} disabled={!!busy || !noteOk} onClick={() => void act('reject')}>
                {t('adm.privacy.requests.actions.reject')}
              </Button>
              <Button loading={busy === 'approve'} disabled={!!busy || !noteOk} onClick={() => void act('approve')}>
                {t('adm.privacy.requests.actions.approve')}
              </Button>
            </>
          ) : null}
          {r?.status === 'APPROVED' ? (
            <Button variant={r.type === 'DELETION' ? 'destructive' : 'default'} loading={busy === 'complete'} disabled={!!busy || (r.type === 'CORRECTION' && note.trim().length < 3)} onClick={() => (r.type === 'DELETION' ? setConfirmErase(true) : void act('complete'))}>
              {t(`adm.privacy.requests.actions.complete_${r.type}`)}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
      {/* Erasure cannot be undone: the customer number has to be typed. */}
      <ConfirmDialog
        open={confirmErase}
        onOpenChange={setConfirmErase}
        title={t('adm.privacy.requests.eraseTitle', { name: r?.customer?.fullName ?? '' })}
        description={t('adm.privacy.requests.eraseText')}
        confirmLabel={t('adm.privacy.requests.actions.complete_DELETION')}
        typedConfirmation={r?.customer?.customerNo}
        onConfirm={() => act('complete')}
      />
    </Dialog>
  );
}
