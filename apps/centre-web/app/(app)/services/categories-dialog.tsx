'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { serviceCategorySchema } from '@typease/validation';
import {
  Badge, Button, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Switch, useApi, useI18n,
  useToast, useZodForm,
} from '@typease/ui';
import { ListSkeleton, Loadable, MoveButtons, moveItem, useRun } from '@/components/ops/common';
import type { ServiceCategory } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const nameSchema = serviceCategorySchema.pick({ name: true, nameAr: true });

/** Create, rename (English / Arabic), reorder, switch off and delete service categories. */
export function CategoriesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, pick } = useI18n();
  const api = useApi();
  const { run, busy } = useRun();
  const [editing, setEditing] = React.useState<string | 'new' | null>(null);
  const [removing, setRemoving] = React.useState<ServiceCategory | null>(null);
  const categories = useQuery({
    queryKey: opsKeys.categories.list(true),
    queryFn: () => api.client.get<ServiceCategory[]>('/service-categories', { query: { includeInactive: true } }),
    enabled: open,
  });
  const invalidate = [opsKeys.categories.all, opsKeys.services.all];

  React.useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  const reorder = (list: ServiceCategory[], from: number, to: number) =>
    run('order', () => api.client.put('/service-categories/order', { ids: moveItem(list, from, to).map((c) => c.id) }), { invalidate });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('ops.services.categories.title')}</DialogTitle>
          <DialogDescription>{t('ops.services.categories.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Loadable query={categories} skeleton={<ListSkeleton rows={6} />}>
            {(list) => (
              <ul className="divide-y rounded-md border">
                {list.map((category, index) =>
                  editing === category.id ? (
                    <li key={category.id} className="bg-muted/30 p-3">
                      <CategoryForm category={category} onDone={() => setEditing(null)} />
                    </li>
                  ) : (
                    <li key={category.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                      <MoveButtons index={index} count={list.length} onMove={(from, to) => void reorder(list, from, to)} name={pick(category.name, category.nameAr)} disabled={busy !== null} />
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="truncate font-medium">{category.name}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          <bdi lang="ar">{category.nameAr ?? ''}</bdi>
                        </p>
                      </div>
                      <span className="text-sm text-muted-foreground">{tn('ops.services.count', category.serviceCount)}</span>
                      <span className="flex items-center gap-2">
                        {category.isActive ? null : <Badge tone="warning">{t('ops.services.categories.inactive')}</Badge>}
                        <Switch
                          checked={category.isActive}
                          disabled={busy !== null}
                          aria-label={t('ops.services.categories.activeLabel', { name: pick(category.name, category.nameAr) })}
                          onCheckedChange={(isActive) =>
                            void run(`active-${category.id}`, () => api.client.patch(`/service-categories/${category.id}`, { isActive }), {
                              success: t(isActive ? 'ops.services.categories.activated' : 'ops.services.categories.deactivated'),
                              invalidate,
                            })
                          }
                        />
                      </span>
                      <span className="flex">
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(category.id)} aria-label={t('ops.services.categories.rename', { name: category.name })} title={t('ops.services.categories.rename', { name: category.name })}>
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(category)} aria-label={t('ops.services.categories.delete', { name: category.name })} title={t('ops.services.categories.delete', { name: category.name })}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Loadable>
          {editing === 'new' ? (
            <div className="rounded-md border bg-muted/30 p-3">
              <CategoryForm onDone={() => setEditing(null)} />
            </div>
          ) : (
            <Button variant="outline" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              {t('ops.services.categories.add')}
            </Button>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('ops.services.categories.deleteTitle', { name: removing?.name ?? '' })}
        description={t('ops.services.categories.deleteText')}
        confirmLabel={t('ops.services.categories.deleteConfirm')}
        onConfirm={async () => {
          await run('delete', () => api.client.delete(`/service-categories/${removing!.id}`), { success: t('ops.services.categories.deleted'), invalidate, rethrow: true });
        }}
      />
    </Dialog>
  );
}

function CategoryForm({ category, onDone }: { category?: ServiceCategory; onDone: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(nameSchema, { defaultValues: { name: category?.name ?? '', nameAr: category?.nameAr ?? '' }, emptyAs: category ? 'null' : 'undefined' });
  return (
    <Form
      form={form}
      className="space-y-3"
      onSubmit={async (values) => {
        if (category) await api.client.patch(`/service-categories/${category.id}`, values);
        else await api.client.post('/service-categories', values);
        toasts.success(t(category ? 'ops.services.categories.renamed' : 'ops.services.categories.added'), values.name);
        await Promise.all([queryClient.invalidateQueries({ queryKey: opsKeys.categories.all }), queryClient.invalidateQueries({ queryKey: opsKeys.services.all })]);
        onDone();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField name="name" label={t('ops.services.categories.name')} required>
          {(field) => <Input {...field} dir="ltr" lang="en" autoFocus autoComplete="off" />}
        </FormField>
        <FormField name="nameAr" label={t('ops.services.categories.nameAr')} optional>
          {(field) => <Input {...field} dir="rtl" lang="ar" autoComplete="off" />}
        </FormField>
      </div>
      <FormError />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t(category ? 'common.save' : 'ops.services.categories.add')}
        </Button>
      </div>
    </Form>
  );
}
