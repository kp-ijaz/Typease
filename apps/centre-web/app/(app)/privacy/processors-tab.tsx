'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCheck, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Page } from '@typease/types';
import { PROCESSOR_STATUSES, privacyProcessorSchema } from '@typease/validation';
import {
  Badge, Button, ChoiceLabel, ConfirmDialog, CountrySelect, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError,
  FormField, Input, RadioGroup, RadioGroupItem, Textarea, countryName, useApi, useI18n, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { ActionError, Field, SettingSwitch } from '@/components/adm/shared';
import type { ProcessorRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { PROCESSOR_STATUS_TONE, usePrivacyLabels } from './labels';

const formSchema = privacyProcessorSchema.omit({ dataCategories: true });

/** Vendors that receive personal data, with the cross-border review. A register: it records, it does not block anything. */
export function ProcessorsTab() {
  const { t, locale, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const [editing, setEditing] = React.useState<{ row: ProcessorRow | null } | null>(null);
  const [reviewing, setReviewing] = React.useState<ProcessorRow | null>(null);
  const [deleting, setDeleting] = React.useState<ProcessorRow | null>(null);
  const [deleteError, setDeleteError] = React.useState<unknown>(null);

  const columns = React.useMemo<Array<DataTableColumn<ProcessorRow>>>(
    () => [
      {
        id: 'name',
        header: t('adm.privacy.processors.name'),
        mobile: 'title',
        cell: (p) => (
          <>
            <span className="block font-medium" dir="auto">
              {p.name}
            </span>
            <span className="line-clamp-2 block max-w-sm text-sm font-normal text-muted-foreground" dir="auto">
              {p.purpose}
            </span>
          </>
        ),
      },
      { id: 'data', header: t('adm.privacy.processors.data'), cell: (p) => <span dir="auto">{p.dataCategories.join(locale === 'ar' ? '، ' : ', ')}</span> },
      {
        id: 'country',
        header: t('adm.privacy.processors.country'),
        cell: (p) => (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {countryName(p.country, locale) || p.country}
            {p.crossBorder ? <Badge tone="warning">{t('adm.privacy.processors.crossBorder')}</Badge> : null}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('adm.privacy.processors.review'),
        mobile: 'badge',
        cell: (p) => (
          <>
            <Badge tone={PROCESSOR_STATUS_TONE[p.status] ?? 'neutral'}>{labels.processorStatus(p.status)}</Badge>
            {p.reviewedAt ? <span className="mt-0.5 block text-sm text-muted-foreground">{formatDate(p.reviewedAt)}</span> : null}
          </>
        ),
      },
      { id: 'safeguards', header: t('adm.privacy.processors.safeguards'), mobile: 'hidden', cell: (p) => (p.safeguards ? <span className="line-clamp-2 max-w-xs text-sm" dir="auto" title={p.safeguards}>{p.safeguards}</span> : null) },
    ],
    [t, locale, labels, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('adm.privacy.processors.review'), options: PROCESSOR_STATUSES.map((s) => ({ value: s, label: labels.processorStatus(s) })) },
      { id: 'crossBorder', type: 'select', label: t('adm.privacy.processors.crossBorder'), options: [{ value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') }] },
    ],
    [t, labels],
  );
  const rowActions = React.useMemo<Array<RowAction<ProcessorRow>>>(
    () => [
      { id: 'review', label: t('adm.privacy.processors.reviewAction'), icon: <CheckCheck aria-hidden="true" />, onSelect: (p) => setReviewing(p) },
      { id: 'edit', label: t('common.edit'), icon: <Pencil aria-hidden="true" />, onSelect: (p) => setEditing({ row: p }) },
      {
        id: 'delete',
        label: t('common.delete'),
        icon: <Trash2 aria-hidden="true" />,
        destructive: true,
        onSelect: (p) => {
          setDeleteError(null);
          setDeleting(p);
        },
      },
    ],
    [t],
  );
  const add = (
    <Button variant="accent" onClick={() => setEditing({ row: null })}>
      <Plus aria-hidden="true" />
      {t('adm.privacy.processors.add')}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('adm.privacy.processors.intro')}</p>
        {add}
      </div>
      <DataTable<ProcessorRow>
        caption={t('adm.privacy.tabs.processors')}
        queryKey={admKeys.privacy.processors}
        queryFn={({ sort: _sort, q: _q, ...query }, signal) => api.client.get<Page<ProcessorRow>>('/privacy/processors', { query, signal })}
        columns={columns}
        rowKey={(p) => p.id}
        rowActions={rowActions}
        filters={filters}
        searchable={false}
        empty={{ icon: <Building2 />, title: t('adm.privacy.processors.emptyTitle'), description: t('adm.privacy.processors.emptyText'), action: add }}
      />
      <ProcessorDialog target={editing} onClose={() => setEditing(null)} />
      <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('adm.privacy.processors.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('adm.privacy.processors.deleteText')}
        confirmLabel={t('adm.privacy.processors.deleteConfirm')}
        onConfirm={async () => {
          if (!deleting) return;
          setDeleteError(null);
          try {
            await api.client.delete(`/privacy/processors/${deleting.id}`);
            toasts.success(t('adm.privacy.processors.deleted'), deleting.name);
            await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
          } catch (e) {
            setDeleteError(e);
            throw e;
          }
        }}
      >
        {deleteError ? <ActionError error={deleteError} /> : null}
      </ConfirmDialog>
    </div>
  );
}

function ProcessorDialog({ target, onClose }: { target: { row: ProcessorRow | null } | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const row = target?.row ?? null;
  const form = useZodForm(formSchema, { emptyAs: 'null', defaultValues: { name: '', purpose: '', country: 'AE', crossBorder: false, safeguards: '' } });
  const [categories, setCategories] = React.useState('');
  const [categoriesError, setCategoriesError] = React.useState(false);
  const id = React.useId();

  React.useEffect(() => {
    if (!target) return;
    form.reset({ name: row?.name ?? '', purpose: row?.purpose ?? '', country: row?.country ?? 'AE', crossBorder: row?.crossBorder ?? false, safeguards: row?.safeguards ?? '' });
    setCategories((row?.dataCategories ?? []).join(', '));
    setCategoriesError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const country = form.watch('country');
  const crossBorder = form.watch('crossBorder');

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const dataCategories = [...new Set(categories.split(/[,،;\n]+/).map((c) => c.trim()).filter((c) => c.length >= 2))];
            if (dataCategories.length === 0) {
              setCategoriesError(true);
              return;
            }
            setCategoriesError(false);
            const body = { ...values, dataCategories };
            if (row) await api.client.patch(`/privacy/processors/${row.id}`, body);
            else await api.client.post('/privacy/processors', body);
            toasts.success(row ? t('adm.privacy.processors.saved') : t('adm.privacy.processors.added'), values.name);
            await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{row ? t('adm.privacy.processors.editTitle', { name: row.name }) : t('adm.privacy.processors.addTitle')}</DialogTitle>
            <DialogDescription>{t('adm.privacy.processors.dialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="name" label={t('adm.privacy.processors.name')} required>
              {(field) => <Input {...field} autoComplete="off" dir="auto" autoFocus={!row} />}
            </FormField>
            <FormField name="purpose" label={t('adm.privacy.processors.purpose')} required hint={t('adm.privacy.processors.purposeHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <Field label={t('adm.privacy.processors.data')} htmlFor={`${id}-cat`} hint={t('adm.privacy.processors.dataHint')} error={categoriesError ? t('adm.privacy.processors.dataRequired') : undefined}>
              <Input id={`${id}-cat`} value={categories} onChange={(e) => setCategories(e.target.value)} dir="auto" autoComplete="off" aria-invalid={categoriesError} />
            </Field>
            <FormField name="country" label={t('adm.privacy.processors.country')} required hint={t('adm.privacy.processors.countryHint')}>
              {(field) => (
                <CountrySelect
                  {...field}
                  className="sm:max-w-sm"
                  onValueChange={(value) => {
                    field.onChange(value);
                    // Outside the UAE means cross-border, as the API assumes; it can still be corrected below.
                    if (value) form.setValue('crossBorder', value !== 'AE', { shouldDirty: true });
                  }}
                />
              )}
            </FormField>
            <div className="rounded-lg border p-4">
              <SettingSwitch id={`${id}-cross`} label={t('adm.privacy.processors.crossBorderLabel')} description={country && country !== 'AE' ? t('adm.privacy.processors.crossBorderAuto') : t('adm.privacy.processors.crossBorderText')} checked={!!crossBorder} onCheckedChange={(checked) => form.setValue('crossBorder', checked, { shouldDirty: true })} />
            </div>
            <FormField name="safeguards" label={t('adm.privacy.processors.safeguards')} hint={t('adm.privacy.processors.safeguardsHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" />}
            </FormField>
            {row && row.status !== 'PENDING_REVIEW' ? <p className="text-sm text-muted-foreground">{t('adm.privacy.processors.reopens')}</p> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {row ? t('common.saveChanges') : t('adm.privacy.processors.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** The review of one vendor. Approving a cross-border vendor needs the safeguards to be written down. */
function ReviewDialog({ row, onClose }: { row: ProcessorRow | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const id = React.useId();
  const [decision, setDecision] = React.useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [safeguards, setSafeguards] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!row) return;
    setDecision('APPROVED');
    setSafeguards(row.safeguards ?? '');
    setError(null);
  }, [row]);

  const submit = async () => {
    if (!row) return;
    setBusy(true);
    setError(null);
    try {
      await api.client.post(`/privacy/processors/${row.id}/review`, { decision, safeguards: safeguards.trim() || undefined });
      toasts.success(decision === 'APPROVED' ? t('adm.privacy.processors.approved') : t('adm.privacy.processors.rejected'), row.name);
      await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!row} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('adm.privacy.processors.reviewTitle', { name: row?.name ?? '' })}</DialogTitle>
          <DialogDescription>{row?.crossBorder ? t('adm.privacy.processors.reviewCrossBorder') : t('adm.privacy.processors.reviewText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <RadioGroup value={decision} onValueChange={(v) => setDecision(v as 'APPROVED' | 'REJECTED')} aria-label={t('adm.privacy.processors.review')} className="flex flex-wrap gap-x-8 gap-y-2">
            <ChoiceLabel htmlFor={`${id}-a`} control={<RadioGroupItem id={`${id}-a`} value="APPROVED" />} label={t('adm.privacy.processors.approve')} />
            <ChoiceLabel htmlFor={`${id}-r`} control={<RadioGroupItem id={`${id}-r`} value="REJECTED" />} label={t('adm.privacy.processors.reject')} />
          </RadioGroup>
          <Field label={t('adm.privacy.processors.safeguards')} htmlFor={`${id}-s`} hint={t('adm.privacy.processors.safeguardsHint')}>
            <Textarea id={`${id}-s`} value={safeguards} onChange={(e) => setSafeguards(e.target.value)} rows={3} dir="auto" maxLength={2000} />
          </Field>
          <ActionError error={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} loading={busy} loadingText={t('common.saving')}>
            {t('adm.privacy.processors.reviewSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
