'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Ban, Globe2, Plus, Trash2, Truck } from 'lucide-react';
import { privacyProcessorSchema } from '@typease/validation';
import {
  Badge, Button, CountrySelect, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, PermissionGate, Textarea,
  countryName, useI18n, useSession, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction, type Tone,
} from '@typease/ui';
import { ConfirmAction, ConfirmReasonDialog } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { ProcessorRecord, ProcessorStatus } from '@/lib/types';

const STATUS_TONE: Record<ProcessorStatus, Tone> = { PENDING_REVIEW: 'warning', APPROVED: 'success', REJECTED: 'danger' };

/**
 * The platform's processor (vendor) register (GET /platform/privacy/processors): who
 * receives personal data on behalf of TypEase, where, and whether the cross-border review
 * was done. A record of decisions; it does not switch any integration on or off.
 */
export function Processors() {
  const { t, locale, formatDate } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const mayManage = session.hasPermission('platform.integrations.manage');
  const [adding, setAdding] = React.useState(false);
  const [review, setReview] = React.useState<{ record: ProcessorRecord; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const [removing, setRemoving] = React.useState<ProcessorRecord | null>(null);
  const refresh = () => Promise.all([keys.processors.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  const listJoin = locale === 'ar' ? '، ' : ', ';

  const columns = React.useMemo<Array<DataTableColumn<ProcessorRecord>>>(
    () => [
      {
        id: 'name',
        header: t('audit.processors.processor'),
        mobile: 'title',
        className: 'min-w-56',
        cell: (p) => (
          <>
            <bdi className="block font-medium text-foreground">{p.name}</bdi>
            {p.purpose ? (
              <span className="block max-w-md text-sm font-normal text-muted-foreground" dir="auto">
                {p.purpose}
              </span>
            ) : null}
          </>
        ),
      },
      { id: 'data', header: t('audit.processors.data'), className: 'max-w-64', cell: (p) => (p.dataCategories.length ? <span dir="auto">{p.dataCategories.join(listJoin)}</span> : null) },
      {
        id: 'country',
        header: t('audit.processors.country'),
        cell: (p) => (
          <>
            <span className="block">{p.country ? countryName(p.country, locale) : null}</span>
            {p.crossBorder ? (
              <Badge tone="warning" icon={<Globe2 />} className="mt-1">
                {t('audit.processors.crossBorder')}
              </Badge>
            ) : null}
          </>
        ),
      },
      { id: 'status', header: t('pc.status'), mobile: 'badge', cell: (p) => <Badge tone={STATUS_TONE[p.status]}>{t(`audit.processors.status.${p.status}`)}</Badge> },
      { id: 'reviewed', header: t('audit.processors.reviewed'), className: 'whitespace-nowrap tabular', cell: (p) => (p.reviewedAt ? formatDate(p.reviewedAt) : null) },
    ],
    [t, locale, formatDate, listJoin],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('pc.status'), options: (['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const).map((s) => ({ value: s, label: t(`audit.processors.status.${s}`) })) },
      { id: 'crossBorder', type: 'select', label: t('audit.processors.where'), options: [{ value: 'true', label: t('audit.processors.crossBorder') }, { value: 'false', label: t('audit.processors.inCountry') }] },
    ],
    [t],
  );
  const rowActions = React.useMemo<Array<RowAction<ProcessorRecord>>>(
    () =>
      mayManage
        ? [
            { id: 'approve', label: t('audit.processors.approve.action'), icon: <BadgeCheck aria-hidden="true" />, hidden: (p) => p.status === 'APPROVED', onSelect: (p) => setReview({ record: p, decision: 'APPROVED' }) },
            { id: 'reject', label: t('audit.processors.reject.action'), icon: <Ban aria-hidden="true" />, destructive: true, hidden: (p) => p.status === 'REJECTED', onSelect: (p) => setReview({ record: p, decision: 'REJECTED' }) },
            { id: 'remove', label: t('audit.processors.remove.action'), icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: setRemoving },
          ]
        : [],
    [t, mayManage],
  );
  const add = (
    <PermissionGate permission="platform.integrations.manage">
      <Button variant="outline" onClick={() => setAdding(true)}>
        <Plus aria-hidden="true" />
        {t('audit.processors.add.action')}
      </Button>
    </PermissionGate>
  );
  const approving = review?.decision === 'APPROVED';
  const needsSafeguards = !!review && approving && review.record.crossBorder;

  return (
    <>
      <DataTable<ProcessorRecord>
        caption={t('audit.tabs.processors')}
        queryKey={keys.processors.all}
        queryFn={(params, signal) => api.processors.list(params, signal)}
        columns={columns}
        rowKey={(p) => p.id}
        rowActions={rowActions.length ? rowActions : undefined}
        filters={filters}
        searchable={false}
        toolbar={add}
        empty={{ icon: <Truck />, title: t('audit.processors.emptyTitle'), description: t('audit.processors.emptyText'), action: add }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('audit.processors.note')}</p>

      <AddDialog open={adding} onOpenChange={setAdding} />
      <ConfirmReasonDialog
        open={!!review}
        onOpenChange={(open) => !open && setReview(null)}
        tone={approving ? 'default' : 'destructive'}
        required={needsSafeguards && !review?.record.safeguards}
        minLength={needsSafeguards ? 5 : 1}
        maxLength={2000}
        title={review ? t(approving ? 'audit.processors.approve.title' : 'audit.processors.reject.title', { name: review.record.name }) : ''}
        description={review ? t(approving ? (review.record.crossBorder ? 'audit.processors.approve.textCrossBorder' : 'audit.processors.approve.text') : 'audit.processors.reject.text') : ''}
        confirmLabel={t(approving ? 'audit.processors.approve.action' : 'audit.processors.reject.action')}
        label={t('audit.processors.safeguards')}
        hint={review?.record.safeguards ? t('audit.processors.safeguardsKeep') : t('audit.processors.safeguardsHint')}
        onConfirm={async (safeguards) => {
          await api.processors.review(review!.record.id, { decision: review!.decision, safeguards: safeguards || undefined });
          await refresh();
          toasts.success(t(approving ? 'audit.processors.approve.done' : 'audit.processors.reject.done', { name: review!.record.name }));
        }}
      />
      <ConfirmAction
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('audit.processors.remove.title', { name: removing?.name ?? '' })}
        description={t('audit.processors.remove.text')}
        confirmLabel={t('audit.processors.remove.action')}
        onConfirm={async () => {
          await api.processors.remove(removing!.id);
          await refresh();
          toasts.success(t('audit.processors.remove.done', { name: removing!.name }));
        }}
      />
    </>
  );
}

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(privacyProcessorSchema, { defaultValues: { name: '', purpose: '', dataCategories: [], country: 'AE', safeguards: '' } });
  const [categories, setCategories] = React.useState('');
  React.useEffect(() => {
    if (open) {
      form.reset({ name: '', purpose: '', dataCategories: [], country: 'AE', safeguards: '' });
      setCategories('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const country = form.watch('country');
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const created = await api.processors.create(values);
            await Promise.all([keys.processors.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t('audit.processors.add.done', { name: created.name }));
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('audit.processors.add.title')}</DialogTitle>
            <DialogDescription>{t('audit.processors.add.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="name" label={t('audit.processors.add.name')} required>
                {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus />}
              </FormField>
              <FormField name="country" label={t('audit.processors.add.country')} required hint={country && country !== 'AE' ? t('audit.processors.add.countryHint') : undefined}>
                {(field) => <CountrySelect {...field} onValueChange={field.onChange} clearable={false} />}
              </FormField>
            </div>
            <FormField name="purpose" label={t('audit.processors.add.purpose')} required>
              {(field) => <Textarea {...field} rows={2} dir="auto" maxLength={1000} />}
            </FormField>
            <FormField name="dataCategories" label={t('audit.processors.data')} required hint={t('audit.processors.add.dataHint')}>
              {(field) => (
                <Input
                  id={field.id}
                  ref={field.ref}
                  aria-invalid={field['aria-invalid']}
                  aria-describedby={field['aria-describedby']}
                  autoComplete="off"
                  dir="auto"
                  value={categories}
                  onBlur={field.onBlur}
                  onChange={(e) => {
                    setCategories(e.target.value);
                    field.onChange(e.target.value.split(/[,،\n]+/).map((part) => part.trim()).filter(Boolean));
                  }}
                />
              )}
            </FormField>
            <FormField name="safeguards" label={t('audit.processors.safeguards')} optional hint={t('audit.processors.safeguardsHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" maxLength={2000} />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('audit.processors.add.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
