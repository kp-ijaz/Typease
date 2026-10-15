'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tags } from 'lucide-react';
import { customerTagSchema } from '@typease/validation';
import {
  Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Skeleton, cn, focusRing, useApi, useI18n, useSession, useToast,
  useZodForm,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, Section, TagChip } from '../shared';
import type { CustomerOverview, CustomerTag } from '../types';

/** Colours offered for a new tag. Tag colours are data of the centre (stored as hex by the API), not design tokens. */
export const TAG_COLOURS = ['#0B7AD1', '#1E8449', '#F2A900', '#C0392B', '#6C3483', '#0B4F6C', '#5D6D7E'];

export function useCustomerTags(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: peopleKeys.customers.tags, queryFn: () => api.client.get<CustomerTag[]>('/customer-tags'), staleTime: 60_000, enabled });
}

/** Tags of a customer: internal labels, never shown to the customer. */
export function TagsCard({ customer, readOnly }: { customer: CustomerOverview; readOnly: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const [managing, setManaging] = React.useState(false);
  const canWrite = !readOnly && session.hasPermission('customer.update');

  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all }), queryClient.invalidateQueries({ queryKey: peopleKeys.customers.tags })]);
  };
  const remove = useMutation({
    mutationFn: (tag: CustomerTag) => api.client.delete<CustomerTag[]>(`/customers/${customer.id}/tags/${tag.id}`),
    onSuccess: async (_tags, tag) => {
      toasts.success(t('people.customer.tags.removed'), tag.name);
      await refresh();
    },
    onError: (error) => toasts.error(error),
  });

  return (
    <Section
      title={t('people.customer.tags.title')}
      action={
        canWrite ? (
          <Button variant="outline" size="sm" onClick={() => setManaging(true)}>
            {t('people.customer.tags.manage')}
          </Button>
        ) : null
      }
    >
      {customer.tags.length === 0 ? (
        <p className="text-base text-muted-foreground">{canWrite ? t('people.customer.tags.emptyText') : t('people.customer.tags.empty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {customer.tags.map((tag) => (
            <li key={tag.id}>
              <TagChip tag={tag} onRemove={canWrite ? () => remove.mutate(tag) : undefined} removeLabel={t('people.customer.tags.remove', { name: tag.name })} />
            </li>
          ))}
        </ul>
      )}
      {managing ? <ManageTagsDialog customer={customer} open onOpenChange={setManaging} onChanged={refresh} /> : null}
    </Section>
  );
}

function ManageTagsDialog({ customer, open, onOpenChange, onChanged }: { customer: CustomerOverview; open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => Promise<void> }) {
  const { t, tn } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const tags = useCustomerTags();
  const assigned = new Set(customer.tags.map((tag) => tag.id));
  const ids = React.useId();

  const toggle = useMutation({
    mutationFn: ({ tag, on }: { tag: CustomerTag; on: boolean }) => (on ? api.client.post<CustomerTag[]>(`/customers/${customer.id}/tags/${tag.id}`) : api.client.delete<CustomerTag[]>(`/customers/${customer.id}/tags/${tag.id}`)),
    onSuccess: async (_tags, { tag, on }) => {
      toasts.success(on ? t('people.customer.tags.assigned') : t('people.customer.tags.removed'), tag.name);
      await onChanged();
    },
    onError: (error) => toasts.error(error),
  });

  // Validated on submit only: the name field takes the focus when the dialog opens, and an error that appears
  // when it is left would move the (centred) dialog under the pointer while a tag is being ticked.
  const form = useZodForm(customerTagSchema, { mode: 'onSubmit', defaultValues: { name: '', color: TAG_COLOURS[0] } });
  const create = async (values: { name: string; color?: string | null }) => {
    const tag = await api.client.post<CustomerTag>('/customer-tags', values);
    await api.client.post(`/customers/${customer.id}/tags/${tag.id}`);
    toasts.success(t('people.customer.tags.created'), tag.name);
    form.reset({ name: '', color: values.color ?? TAG_COLOURS[0] });
    await onChanged();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('people.customer.tags.manageTitle')}</DialogTitle>
          <DialogDescription>{t('people.customer.tags.manageText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {tags.isPending ? (
            <div className="space-y-2" role="status" aria-label={t('common.loading')}>
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : tags.isError ? (
            <LoadError error={tags.error} onRetry={() => void tags.refetch()} />
          ) : tags.data.length === 0 ? (
            <p className="flex items-center gap-2 text-base text-muted-foreground">
              <Tags className="size-4" aria-hidden="true" />
              {t('people.customer.tags.noneYet')}
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {tags.data.map((tag) => {
                const checked = assigned.has(tag.id);
                const busy = toggle.isPending && toggle.variables?.tag.id === tag.id;
                return (
                  <li key={tag.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Checkbox id={`${ids}-${tag.id}`} checked={checked} disabled={busy} onCheckedChange={(v) => toggle.mutate({ tag, on: v === true })} />
                    <label htmlFor={`${ids}-${tag.id}`} className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3">
                      <TagChip tag={tag} />
                      <span className="shrink-0 text-sm text-muted-foreground">{tn('people.customer.tags.usedBy', tag.customerCount ?? 0)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <Form form={form} onSubmit={create} className="space-y-3 rounded-lg border bg-muted/40 p-4">
            <p className="text-md font-semibold text-foreground">{t('people.customer.tags.newTitle')}</p>
            <FormField name="name" label={t('people.customer.tags.name')} required>
              {(field) => <Input {...field} autoComplete="off" maxLength={40} dir="auto" />}
            </FormField>
            <FormField name="color" label={t('people.customer.tags.colour')}>
              {(field) => (
                <div id={field.id} role="radiogroup" aria-label={t('people.customer.tags.colour')} className="flex flex-wrap gap-2">
                  {TAG_COLOURS.map((colour, index) => (
                    <button
                      key={colour}
                      type="button"
                      role="radio"
                      aria-checked={field.value === colour}
                      aria-label={t('people.customer.tags.colourOption', { number: index + 1 })}
                      onClick={() => field.onChange(colour)}
                      className={cn('flex size-8 items-center justify-center rounded-full border-2', field.value === colour ? 'border-foreground' : 'border-transparent', focusRing)}
                    >
                      <span aria-hidden="true" className="size-5 rounded-full" style={{ backgroundColor: colour }} />
                    </button>
                  ))}
                </div>
              )}
            </FormField>
            <FormError />
            <div className="flex justify-end">
              <Button type="submit" variant="outline" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
                {t('people.customer.tags.create')}
              </Button>
            </div>
          </Form>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t('common.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
