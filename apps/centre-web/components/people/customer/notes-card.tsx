'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff, StickyNote, Trash2 } from 'lucide-react';
import type { Page } from '@typease/types';
import { customerNoteSchema } from '@typease/validation';
import { Badge, Button, ConfirmDialog, EmptyState, Form, FormError, FormField, Pagination, Skeleton, Textarea, useApi, useI18n, useSession, useToast, useZodForm } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { BooleanField } from '../form-bits';
import { LoadError, Section } from '../shared';
import type { CustomerNote, CustomerOverview } from '../types';

/**
 * Internal notes of a customer (never shown to the customer). Pinned notes come first.
 * Anyone with `customer.update` can add and pin; a note is deleted by its author or by a
 * holder of `customer.archive` (the API decides, the button follows the same rule).
 */
export function NotesCard({ customer, readOnly }: { customer: CustomerOverview; readOnly: boolean }) {
  const { t, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [deleting, setDeleting] = React.useState<CustomerNote | null>(null);
  const canWrite = !readOnly && session.hasPermission('customer.update');

  const notes = useQuery({
    queryKey: [...peopleKeys.customers.notes(customer.id), page],
    queryFn: () => api.client.get<Page<CustomerNote>>(`/customers/${customer.id}/notes`, { query: { page, pageSize: 10 } }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.customers.detail(customer.id) });

  const form = useZodForm(customerNoteSchema, { defaultValues: { body: '', isPinned: false } });
  const add = async (values: { body: string; isPinned: boolean }) => {
    await api.client.post<CustomerNote>(`/customers/${customer.id}/notes`, values);
    toasts.success(t('people.customer.notes.added'));
    form.reset({ body: '', isPinned: false });
    setPage(1);
    await refresh();
  };

  const pin = useMutation({
    mutationFn: (note: CustomerNote) => api.client.patch<CustomerNote>(`/customers/${customer.id}/notes/${note.id}`, { isPinned: !note.isPinned }),
    onSuccess: async (note) => {
      toasts.success(note.isPinned ? t('people.customer.notes.pinned') : t('people.customer.notes.unpinned'));
      await refresh();
    },
    onError: (error) => toasts.error(error),
  });

  const remove = async (note: CustomerNote) => {
    try {
      await api.client.delete(`/customers/${customer.id}/notes/${note.id}`);
      toasts.success(t('people.customer.notes.deleted'));
      await refresh();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const list = notes.data?.data ?? [];
  return (
    <Section title={t('people.customer.notes.title')} description={t('people.customer.notes.description')}>
      {canWrite ? (
        <Form form={form} onSubmit={add} className="mb-5 space-y-3">
          <FormField name="body" label={t('people.customer.notes.new')} hideLabel>
            {(field) => <Textarea {...field} rows={2} placeholder={t('people.customer.notes.placeholder')} dir="auto" />}
          </FormField>
          <FormError />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <BooleanField name="isPinned" label={t('people.customer.notes.pinNew')} />
            <Button type="submit" variant="outline" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('people.customer.notes.add')}
            </Button>
          </div>
        </Form>
      ) : null}

      {notes.isPending ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : notes.isError ? (
        <LoadError error={notes.error} onRetry={() => void notes.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState className="py-6" icon={<StickyNote />} title={t('people.customer.notes.empty')} description={canWrite ? t('people.customer.notes.emptyText') : undefined} />
      ) : (
        <ul className="space-y-3">
          {list.map((note) => {
            const mayDelete = !readOnly && (note.authorId === session.user?.id || session.hasPermission('customer.archive')) && session.hasPermission('customer.update');
            return (
              <li key={note.id} className={`rounded-lg border p-3.5 ${note.isPinned ? 'border-warning/40 bg-warning-soft/50' : 'bg-card'}`}>
                <p className="whitespace-pre-wrap break-words text-base text-foreground" dir="auto">
                  {note.body}
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    {note.isPinned ? <Badge tone="warning" icon={<Pin />}>{t('people.customer.notes.pinnedBadge')}</Badge> : null}
                    <span>{note.authorName ?? t('people.common.unknownPerson')}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular">{formatDateTime(note.createdAt)}</span>
                  </p>
                  {canWrite ? (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => pin.mutate(note)} disabled={pin.isPending}>
                        {note.isPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                        {note.isPinned ? t('people.customer.notes.unpin') : t('people.customer.notes.pin')}
                      </Button>
                      {mayDelete ? (
                        <Button variant="ghost" size="icon-sm" aria-label={t('people.customer.notes.delete')} title={t('people.customer.notes.delete')} onClick={() => setDeleting(note)}>
                          <Trash2 className="text-destructive-text" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {notes.data && notes.data.meta.totalPages > 1 ? <Pagination className="mt-4" meta={notes.data.meta} onPageChange={setPage} /> : null}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t('people.customer.notes.deleteTitle')}
        description={t('people.customer.notes.deleteText')}
        confirmLabel={t('people.customer.notes.delete')}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </Section>
  );
}
