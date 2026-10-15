'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, Scale } from 'lucide-react';
import { PaymentMethodValues } from '@typease/types';
import { isoDate, moneyAmount, z } from '@typease/validation';
import {
  Badge, Button, Checkbox, ChoiceLabel, DataTable, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input,
  MoneyInput, PageHeader, RequirePermission, Select, Textarea, addDays, useI18n, useSession, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction, type Tone,
} from '@typease/ui';
import { useBranches } from '@/components/branch';
import { useFinApi } from '@/components/fin/api';
import { zonedToIso } from '@/components/fin/dates';
import { FinanceTabs } from '@/components/fin/finance-tabs';
import { FieldSelect, Money } from '@/components/fin/shared';
import type { ReconciliationRow, ReconciliationStatus } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

export const RECONCILIATION_TONE: Record<ReconciliationStatus, Tone> = { OPEN: 'info', MATCHED: 'success', DISCREPANCY: 'danger', CLOSED: 'neutral' };
const STATUSES: ReconciliationStatus[] = ['OPEN', 'MATCHED', 'DISCREPANCY', 'CLOSED'];
const ALL = '__all__';

export function Reconciliations() {
  return (
    <RequirePermission anyOf={['payment.reconcile']}>
      <ReconciliationsInner />
    </RequirePermission>
  );
}

function ReconciliationsInner() {
  const { t, formatDate } = useI18n();
  const api = useFinApi();
  const [creating, setCreating] = React.useState(false);

  const columns = React.useMemo<Array<DataTableColumn<ReconciliationRow>>>(
    () => [
      {
        id: 'period',
        header: t('fin.common.period'),
        sortField: 'periodStart',
        mobile: 'title',
        className: 'whitespace-nowrap',
        cell: (r) => (
          <span className="tabular">
            {formatDate(r.periodStart)} – {formatDate(r.periodEnd)}
          </span>
        ),
      },
      { id: 'status', header: t('fin.common.status'), mobile: 'badge', cell: (r) => <Badge tone={RECONCILIATION_TONE[r.status]}>{t(`fin.reconciliation.status.${r.status}`)}</Badge> },
      {
        id: 'method',
        header: t('fin.payments.columns.method'),
        cell: (r) => (
          <>
            {t(`fin.methods.${r.method}`)}
            {r.gateway ? <span className="ltr-value ms-1.5 text-sm text-muted-foreground">({r.gateway})</span> : null}
            {r.statementReference ? <span className="block max-w-56 truncate text-sm text-muted-foreground" dir="auto" title={r.statementReference}>{r.statementReference}</span> : null}
          </>
        ),
      },
      { id: 'expected', header: t('fin.reconciliation.expected'), align: 'end', cell: (r) => <Money amount={r.expectedAmount} /> },
      { id: 'settled', header: t('fin.reconciliation.settled'), sortField: 'settledAmount', align: 'end', cell: (r) => <Money amount={r.settledAmount} /> },
      {
        id: 'difference',
        header: t('fin.reconciliation.difference'),
        sortField: 'difference',
        align: 'end',
        cell: (r) => <Money amount={r.difference} className={Number(r.difference) === 0 ? 'text-muted-foreground' : 'font-semibold text-destructive-text'} />,
      },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('fin.common.status'), options: STATUSES.map((s) => ({ value: s, label: t(`fin.reconciliation.status.${s}`) })) },
      { id: 'method', type: 'select', label: t('fin.payments.columns.method'), options: PaymentMethodValues.map((m) => ({ value: m, label: t(`fin.methods.${m}`) })) },
      { id: 'period', type: 'dateRange', label: t('fin.common.period'), fromKey: 'from', toKey: 'to' },
    ],
    [t],
  );

  const rowActions = React.useMemo<Array<RowAction<ReconciliationRow>>>(() => [{ id: 'open', label: t('fin.reconciliation.open'), icon: <ExternalLink aria-hidden="true" />, href: (r) => `/finance/reconciliation/${r.id}` }], [t]);

  const create = (
    <Button variant="accent" onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" />
      {t('fin.reconciliation.new')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('fin.reconciliation.title')} description={t('fin.reconciliation.description')} action={create} />
      <FinanceTabs current="reconciliation" />
      <DataTable<ReconciliationRow>
        caption={t('fin.reconciliation.title')}
        queryKey={finKeys.reconciliations.all}
        queryFn={(params, signal) => api.reconciliations.list(params, signal)}
        columns={columns}
        rowKey={(r) => r.id}
        rowHref={(r) => `/finance/reconciliation/${r.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.reconciliation.searchPlaceholder')}
        defaultSort="periodStart:desc"
        empty={{ icon: <Scale />, title: t('fin.reconciliation.emptyTitle'), description: t('fin.reconciliation.emptyText'), action: create }}
      />
      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- create

const createSchema = z
  .object({
    method: z.enum(PaymentMethodValues),
    gateway: z.string().trim().max(40).optional(),
    branchId: z.string().optional(),
    from: isoDate,
    to: isoDate,
    statementReference: z.string().trim().max(120).optional(),
    settledAmount: moneyAmount,
    feeAmount: moneyAmount.optional(),
    notes: z.string().trim().max(1000).optional(),
    attachAll: z.boolean(),
  })
  .refine((v) => v.from <= v.to, { message: 'The start date must not be after the end date', path: ['to'] })
  .refine((v) => v.method !== 'ONLINE_GATEWAY' || !!v.gateway, { message: 'Required', path: ['gateway'] });

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { t, pick, today, timeZone } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const branches = useBranches();
  const attachId = React.useId();
  const form = useZodForm(createSchema, {
    defaultValues: { method: 'CARD_POS', gateway: '', branchId: '', from: addDays(today(), -6), to: today(), statementReference: '', settledAmount: '', feeAmount: '', notes: '', attachAll: true },
  });
  const method = form.watch('method');
  const currency = session.tenant?.currency ?? 'AED';

  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const record = await api.reconciliations.create({
              method: values.method,
              ...(values.method === 'ONLINE_GATEWAY' ? { gateway: values.gateway } : {}),
              ...(values.branchId ? { branchId: values.branchId } : {}),
              periodStart: zonedToIso(values.from, '00:00:00', timeZone),
              periodEnd: zonedToIso(values.to, '23:59:59', timeZone),
              statementReference: values.statementReference ?? null,
              settledAmount: values.settledAmount,
              feeAmount: values.feeAmount ?? '0',
              notes: values.notes ?? null,
              attachAll: values.attachAll,
            });
            toasts.success(t('fin.reconciliation.created'), t('fin.reconciliation.createdNext'));
            await Promise.all([finKeys.reconciliations.all, finKeys.payments.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            router.push(`/finance/reconciliation/${record.id}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.reconciliation.newTitle')}</DialogTitle>
            <DialogDescription>{t('fin.reconciliation.newDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="method" label={t('fin.payments.columns.method')} required>
                {(field) => <FieldSelect {...field} onValueChange={field.onChange} options={PaymentMethodValues.map((m) => ({ value: m, label: t(`fin.methods.${m}`) }))} />}
              </FormField>
              {method === 'ONLINE_GATEWAY' ? (
                <FormField name="gateway" label={t('fin.reconciliation.gateway')} required hint={t('fin.reconciliation.gatewayHint')}>
                  {(field) => <Input {...field} dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="stripe" />}
                </FormField>
              ) : null}
              {branches.data && branches.data.length > 1 ? (
                <FormField name="branchId" label={t('fin.common.branch')}>
                  {(field) => (
                    <Select
                      {...field}
                      value={field.value || ALL}
                      onValueChange={(v) => field.onChange(v === ALL ? '' : v)}
                      options={[{ value: ALL, label: t('shell.allBranches') }, ...branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
                    />
                  )}
                </FormField>
              ) : null}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="from" label={t('fin.reconciliation.from')} required>
                {(field) => <DatePicker {...field} value={field.value} onChange={field.onChange} max={today()} />}
              </FormField>
              <FormField name="to" label={t('fin.reconciliation.to')} required>
                {(field) => <DatePicker {...field} value={field.value} onChange={field.onChange} max={today()} />}
              </FormField>
              <FormField name="settledAmount" label={t('fin.reconciliation.settled')} required hint={t('fin.reconciliation.settledHint')}>
                {(field) => <MoneyInput {...field} currency={currency} />}
              </FormField>
              <FormField name="feeAmount" label={t('fin.reconciliation.fees')} optional hint={t('fin.reconciliation.feesHint')}>
                {(field) => <MoneyInput {...field} currency={currency} />}
              </FormField>
            </div>
            <FormField name="statementReference" label={t('fin.reconciliation.statement')} optional hint={t('fin.reconciliation.statementHint')}>
              {(field) => <Input {...field} autoComplete="off" maxLength={120} dir="auto" />}
            </FormField>
            <FormField name="notes" label={t('fin.reconciliation.notes')} optional>
              {(field) => <Textarea {...field} rows={2} maxLength={1000} />}
            </FormField>
            <FormField name="attachAll" label={t('fin.reconciliation.attachAll')} hideLabel>
              {(field) => (
                <ChoiceLabel
                  htmlFor={attachId}
                  control={<Checkbox id={attachId} checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />}
                  label={t('fin.reconciliation.attachAll')}
                  description={t('fin.reconciliation.attachAllHint')}
                />
              )}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('fin.reconciliation.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
