'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, WalletCards } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { createExpenseSchema } from '@typease/validation';
import {
  Alert, Badge, Button, ConfirmDialog, DataTable, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input,
  MoneyInput, PageHeader, RequirePermission, Select, useI18n, useSession, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';
import { useFinApi } from '@/components/fin/api';
import { FinanceTabs } from '@/components/fin/finance-tabs';
import { RequestPicker } from '@/components/fin/request-picker';
import { useActiveListPage } from '@/components/fin/scope-filters';
import { FieldSelect, Money, TextLink, useBranchFilter } from '@/components/fin/shared';
import { EXPENSE_CATEGORIES, EXPENSE_METHODS, type ExpenseCategory, type ExpensePage, type ExpenseRow } from '@/components/fin/types';
import { MONEY_RESOURCES, finKeys } from '@/lib/keys/fin';

const REMITTANCE: ExpenseCategory[] = ['GOVERNMENT_FEE_REMITTANCE', 'THIRD_PARTY_PAYMENT'];
const isRemittance = (category: string | undefined): category is ExpenseCategory => REMITTANCE.includes(category as ExpenseCategory);
const NONE = '__none__';

export function Expenses() {
  return (
    <RequirePermission anyOf={['expense.manage']}>
      <ExpensesInner />
    </RequirePermission>
  );
}

interface Prefill {
  requestId?: string;
  category?: ExpenseCategory;
  amount?: string;
}

function ExpensesInner() {
  const { t, formatDate } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const branchFilter = useBranchFilter();
  const page = useActiveListPage<ExpenseRow>(finKeys.expenses.all) as ExpensePage | undefined;
  const [dialog, setDialog] = React.useState<{ expense?: ExpenseRow; prefill?: Prefill } | null>(null);
  const [removing, setRemoving] = React.useState<ExpenseRow | null>(null);

  // /finance/expenses?new=1&requestId=&category=&amount= : "Record remittance" on the liabilities page.
  React.useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (search.get('new') === null) return;
    const category = search.get('category');
    setDialog({ prefill: { requestId: search.get('requestId') ?? undefined, category: isRemittance(category ?? undefined) ? (category as ExpenseCategory) : undefined, amount: search.get('amount') ?? undefined } });
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);

  const refresh = async () => {
    await Promise.all([finKeys.expenses.all, finKeys.liabilities.all, ...MONEY_RESOURCES].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

  const columns = React.useMemo<Array<DataTableColumn<ExpenseRow>>>(
    () => [
      { id: 'date', header: t('fin.expenses.columns.paidOn'), sortField: 'paidOn', className: 'whitespace-nowrap tabular', cell: (e) => formatDate(e.paidOn.slice(0, 10)) },
      {
        id: 'description',
        header: t('fin.expenses.columns.description'),
        mobile: 'title',
        cell: (e) => (
          <>
            <span className="block font-medium text-foreground" dir="auto">
              {e.description}
            </span>
            {e.payee ? <span className="block text-sm font-normal text-muted-foreground" dir="auto">{e.payee}</span> : null}
          </>
        ),
      },
      {
        id: 'category',
        header: t('fin.expenses.columns.category'),
        mobile: 'badge',
        cell: (e) => <Badge tone={isRemittance(e.category) ? 'info' : 'neutral'}>{t(`fin.expenses.categories.${e.category}`)}</Badge>,
      },
      { id: 'request', header: t('fin.common.request'), cell: (e) => (e.requestId ? <TextLink href={`/requests/${e.requestId}`} className="font-normal">{t('fin.common.openRequest')}</TextLink> : null) },
      { id: 'branch', header: t('fin.common.branch'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (e) => e.branch.name },
      {
        id: 'method',
        header: t('fin.expenses.columns.method'),
        mobile: 'hidden',
        className: 'whitespace-nowrap',
        cell: (e) =>
          e.method || e.reference ? (
            <>
              {e.method ? t(`fin.expenses.methods.${e.method}`) : null}
              {e.reference ? <span className="block text-sm text-muted-foreground" dir="auto">{e.reference}</span> : null}
            </>
          ) : null,
      },
      { id: 'amount', header: t('fin.common.amount'), sortField: 'amount', align: 'end', cell: (e) => <Money amount={e.amount} currency={e.currency} className="font-medium" /> },
    ],
    [t, formatDate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'category', type: 'select', label: t('fin.expenses.columns.category'), options: EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t(`fin.expenses.categories.${c}`) })) },
      ...branchFilter,
      { id: 'paid', type: 'dateRange', label: t('fin.expenses.columns.paidOn'), fromKey: 'from', toKey: 'to' },
    ],
    [t, branchFilter],
  );

  const rowActions = React.useMemo<Array<RowAction<ExpenseRow>>>(
    () => [
      { id: 'edit', label: t('common.edit'), icon: <Pencil aria-hidden="true" />, onSelect: (e) => setDialog({ expense: e }) },
      { id: 'delete', label: t('common.delete'), icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: (e) => setRemoving(e) },
    ],
    [t],
  );

  const add = (
    <Button variant="accent" onClick={() => setDialog({})}>
      <Plus aria-hidden="true" />
      {t('fin.expenses.add')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('fin.expenses.title')} description={t('fin.expenses.description')} action={add} />
      <FinanceTabs current="expenses" />
      <DataTable<ExpenseRow>
        caption={t('fin.expenses.title')}
        queryKey={finKeys.expenses.all}
        queryFn={(params, signal) => api.expenses.list(params, signal)}
        columns={columns}
        rowKey={(e) => e.id}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('fin.expenses.searchPlaceholder')}
        defaultSort="paidOn:desc"
        empty={{ icon: <WalletCards />, title: t('fin.expenses.emptyTitle'), description: t('fin.expenses.emptyText'), action: add }}
      />
      {page && page.meta.total > 0 ? (
        <p className="mt-3 flex flex-wrap items-baseline justify-end gap-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-xs">
          <span className="text-muted-foreground">{t('fin.expenses.total', { count: page.meta.total })}</span>
          <Money amount={page.totalAmount} currency={page.data[0]?.currency} className="text-base font-semibold text-foreground" />
        </p>
      ) : null}

      {dialog ? <ExpenseDialog expense={dialog.expense} prefill={dialog.prefill} onClose={() => setDialog(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('fin.expenses.deleteTitle')}
        description={removing && isRemittance(removing.category) && removing.requestId ? t('fin.expenses.deleteRemittanceText') : t('fin.expenses.deleteText')}
        confirmLabel={t('fin.expenses.delete')}
        onConfirm={async () => {
          if (!removing) return;
          try {
            const result = await api.expenses.remove(removing.id);
            toasts.success(t('fin.expenses.deleted'), result.remittanceReversed ? t('fin.expenses.deletedRemittance') : undefined);
            await refresh();
          } catch (error) {
            toasts.error(error);
            throw error;
          }
        }}
      >
        {removing ? (
          <div className="flex items-center justify-between gap-4 rounded-md bg-muted/60 px-3 py-2.5 text-base">
            <span className="min-w-0 truncate" dir="auto">
              {removing.description}
            </span>
            <Money amount={removing.amount} currency={removing.currency} className="font-semibold" />
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------- form

function ExpenseDialog({ expense, prefill, onClose, onSaved }: { expense?: ExpenseRow; prefill?: Prefill; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t, pick, today, formatMoney } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const toasts = useToast();
  const branches = useBranches();
  const { branchId: currentBranch } = useBranch();
  const currency = expense?.currency ?? session.tenant?.currency ?? 'AED';
  // A remittance that settled a request's fees is part of the ledger: its amount, kind, branch and request are fixed.
  const locked = !!expense && isRemittance(expense.category) && !!expense.requestId;

  const form = useZodForm(createExpenseSchema, {
    defaultValues: {
      branchId: expense?.branchId ?? '',
      category: expense?.category ?? prefill?.category ?? 'OTHER',
      requestId: expense?.requestId ?? prefill?.requestId ?? null,
      description: expense?.description ?? '',
      amount: expense?.amount ?? prefill?.amount ?? '',
      paidOn: expense?.paidOn.slice(0, 10) ?? today(),
      payee: expense?.payee ?? '',
      reference: expense?.reference ?? '',
      method: expense?.method ?? null,
    },
  });
  const category = form.watch('category');
  const requestId = form.watch('requestId') ?? '';
  const remittance = isRemittance(category);

  React.useEffect(() => {
    if (expense || form.getValues('branchId') || !branches.data?.length) return;
    const fallback = branches.data.find((b) => b.id === currentBranch) ?? (branches.data.length === 1 ? branches.data[0] : branches.data.find((b) => b.isHeadOffice));
    if (fallback) form.setValue('branchId', fallback.id);
  }, [expense, branches.data, currentBranch, form]);

  // What was collected for this request and is not yet paid out: the most a remittance can be.
  const mayReadLiabilities = session.hasAnyPermission(['report.financial', 'payment.reconcile']);
  const liability = useQuery({
    queryKey: finKeys.liabilities.ofRequest(requestId || ''),
    queryFn: ({ signal }) => api.liabilities({ requestId, pageSize: 1 }, signal),
    enabled: remittance && !!requestId && mayReadLiabilities && !locked,
  });
  const request = liability.data?.requests.data[0];
  const owed = request ? (category === 'GOVERNMENT_FEE_REMITTANCE' ? request.governmentFee.outstanding : request.thirdPartyFee.outstanding) : null;
  const requestBrief = useQuery({
    queryKey: finKeys.requestBrief(requestId || ''),
    queryFn: ({ signal }) => api.requestBrief(requestId, signal),
    enabled: !!requestId && session.hasAnyPermission(['request.read.all', 'request.read.assigned']),
    staleTime: 5 * 60_000,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const body = {
              description: values.description,
              paidOn: values.paidOn,
              payee: values.payee ?? null,
              reference: values.reference ?? null,
              method: values.method ?? null,
              // Locked fields of a recorded remittance are not sent again.
              ...(locked ? {} : { branchId: values.branchId, category: values.category, amount: values.amount, requestId: isRemittance(values.category) && values.requestId ? values.requestId : null }),
            };
            if (expense) {
              await api.expenses.update(expense.id, body);
              toasts.success(t('fin.expenses.updated'));
            } else {
              let created: Awaited<ReturnType<typeof api.expenses.create>>;
              try {
                created = await api.expenses.create(body);
              } catch (error) {
                // More than was collected for the request: the API's own sentence belongs next to the amount.
                if (isApiError(error) && error.code === 'REMITTANCE_EXCEEDS_LIABILITY') {
                  form.setError('amount', { type: 'server', message: error.message }, { shouldFocus: true });
                  return;
                }
                throw error;
              }
              toasts.success(t('fin.expenses.added'), created.liabilitySettled ? t('fin.expenses.addedRemittance') : undefined);
            }
            await onSaved();
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{expense ? t('fin.expenses.editTitle') : t('fin.expenses.addTitle')}</DialogTitle>
            <DialogDescription>{t('fin.expenses.formDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {locked ? <Alert tone="info">{t('fin.expenses.lockedNote')}</Alert> : null}
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="category" label={t('fin.expenses.columns.category')} required>
                {(field) => <FieldSelect {...field} disabled={locked} onValueChange={field.onChange} options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t(`fin.expenses.categories.${c}`) }))} />}
              </FormField>
              {branches.data && branches.data.length > 1 ? (
                <FormField name="branchId" label={t('fin.common.branch')} required>
                  {(field) => <FieldSelect {...field} disabled={locked} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />}
                </FormField>
              ) : null}
            </div>

            {remittance ? (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <FormField name="requestId" label={t('fin.expenses.request')} optional hint={t(category === 'GOVERNMENT_FEE_REMITTANCE' ? 'fin.expenses.requestHintGovernment' : 'fin.expenses.requestHintThirdParty')}>
                  {(field) => <RequestPicker {...field} value={field.value} disabled={locked} selectedLabel={requestBrief.data?.requestNo ?? (requestId ? '…' : null)} onChange={(id) => field.onChange(id || null)} />}
                </FormField>
                {requestId && owed !== null ? (
                  <p className="text-sm text-foreground" aria-live="polite">
                    {t('fin.expenses.owedForRequest')} <span className="font-semibold">{formatMoney(owed, currency)}</span>
                    {Number(owed) > 0 ? (
                      <Button variant="link" size="sm" className="ms-2 h-auto" onClick={() => form.setValue('amount', owed, { shouldDirty: true, shouldValidate: true })}>
                        {t('fin.expenses.useAmount')}
                      </Button>
                    ) : null}
                  </p>
                ) : null}
                {!requestId ? <p className="text-sm text-muted-foreground">{t('fin.expenses.noRequestNote')}</p> : null}
              </div>
            ) : null}

            <FormField name="description" label={t('fin.expenses.columns.description')} required>
              {(field) => <Input {...field} autoComplete="off" maxLength={300} dir="auto" />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="amount" label={t('fin.common.amount')} required>
                {(field) => <MoneyInput {...field} currency={currency} disabled={locked} />}
              </FormField>
              <FormField name="paidOn" label={t('fin.expenses.columns.paidOn')} required>
                {(field) => <DatePicker {...field} value={field.value} onChange={field.onChange} max={today()} />}
              </FormField>
              <FormField name="payee" label={t('fin.expenses.payee')} optional>
                {(field) => <Input {...field} autoComplete="off" maxLength={160} dir="auto" />}
              </FormField>
              <FormField name="method" label={t('fin.expenses.columns.method')} optional>
                {(field) => (
                  <Select
                    {...field}
                    value={field.value || NONE}
                    onValueChange={(v) => field.onChange(v === NONE ? null : v)}
                    options={[{ value: NONE, label: t('common.notSet') }, ...EXPENSE_METHODS.map((m) => ({ value: m, label: t(`fin.expenses.methods.${m}`) }))]}
                  />
                )}
              </FormField>
              <FormField name="reference" label={t('fin.expenses.reference')} optional className="sm:col-span-2">
                {(field) => <Input {...field} autoComplete="off" maxLength={120} dir="auto" />}
              </FormField>
            </div>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {expense ? t('common.saveChanges') : t('fin.expenses.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
