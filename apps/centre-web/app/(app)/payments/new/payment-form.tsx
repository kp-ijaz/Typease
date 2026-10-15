'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Building, CreditCard, FileText, Landmark, Receipt, WandSparkles } from 'lucide-react';
import { isApiError, newIdempotencyKey } from '@typease/api-client';
import { recordPaymentSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Form, FormActions, FormError, FormField, Input, Label, MoneyInput, PageHeader, RadioGroup, RadioGroupItem,
  RequirePermission, Skeleton, StatusBadge, Textarea, compareMoney, isZeroMoney, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';
import { CorporateAccountPicker, CustomerPicker } from '@/components/pickers';
import { useFinApi } from '@/components/fin/api';
import { allocateOldestFirst, diffAmounts, hundredths, isPositiveAmount, sumAmounts } from '@/components/fin/calc';
import { FieldSelect, LoadError, Money, TextLink } from '@/components/fin/shared';
import type { InvoiceRow } from '@/components/fin/types';
import { MONEY_RESOURCES, finKeys } from '@/lib/keys/fin';

const schema = recordPaymentSchema.pick({ method: true, amount: true, reference: true, notes: true, branchId: true });
const METHODS = [
  { value: 'CASH', icon: Banknote },
  { value: 'CARD_POS', icon: CreditCard },
  { value: 'BANK_TRANSFER', icon: Landmark },
  { value: 'CHEQUE', icon: FileText },
] as const;

interface Props {
  invoiceId?: string;
  customerId?: string;
  corporateAccountId?: string;
}

export function PaymentForm(props: Props) {
  return (
    <RequirePermission anyOf={['payment.record']}>
      <PaymentFormInner {...props} />
    </RequirePermission>
  );
}

function PaymentFormInner({ invoiceId, customerId: initialCustomer, corporateAccountId: initialCompany }: Props) {
  const { t, pick, formatDate, formatMoney } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const branches = useBranches();
  const { branchId: currentBranch } = useBranch();
  const methodId = React.useId();
  const currency = session.tenant?.currency ?? 'AED';

  // ONE key for the life of this form: a double click, or a retry after a timeout, can never record the payment twice.
  const idempotencyKey = React.useRef(newIdempotencyKey());

  const mayReadCompanies = session.hasPermission('corporate.read');
  const [payer, setPayer] = React.useState<'customer' | 'company'>(initialCompany && !initialCustomer ? 'company' : 'customer');
  const [customerId, setCustomerId] = React.useState(initialCustomer ?? '');
  const [customerName, setCustomerName] = React.useState<string | null>(null);
  const [companyId, setCompanyId] = React.useState(initialCompany ?? '');
  const [companyName, setCompanyName] = React.useState<string | null>(null);
  const [allocations, setAllocations] = React.useState<Record<string, string>>({});
  /** Once someone edits an allocation by hand, a changed amount no longer rewrites their split. */
  const [manual, setManual] = React.useState(false);
  const [allocationError, setAllocationError] = React.useState<string | null>(null);
  const [maybeRecorded, setMaybeRecorded] = React.useState(false);

  const form = useZodForm(schema, { defaultValues: { method: 'CASH', amount: '', reference: '', notes: '', branchId: '' } });
  const amount = form.watch('amount') as string;
  const method = form.watch('method');

  // ---- the invoice the page was opened for
  const target = useQuery({ queryKey: finKeys.invoices.detail(invoiceId ?? ''), queryFn: ({ signal }) => api.invoices.get(invoiceId as string, signal), enabled: !!invoiceId });
  const prefilled = React.useRef(false);
  React.useEffect(() => {
    if (prefilled.current || !target.data) return;
    prefilled.current = true;
    setPayer('customer');
    setCustomerId(target.data.customerId);
    setCustomerName(target.data.customer.fullName);
    form.setValue('branchId', target.data.branchId);
    if (Number(target.data.balanceDue) > 0) form.setValue('amount', target.data.balanceDue);
  }, [target.data, form]);

  const customerBrief = useQuery({
    queryKey: finKeys.customerBrief(initialCustomer ?? ''),
    queryFn: ({ signal }) => api.customerBrief(initialCustomer as string, signal),
    enabled: !!initialCustomer && !invoiceId && session.hasPermission('customer.read'),
  });
  React.useEffect(() => {
    if (customerBrief.data && !customerName) setCustomerName(customerBrief.data.fullName);
  }, [customerBrief.data, customerName]);

  React.useEffect(() => {
    if (form.getValues('branchId') || !branches.data?.length || invoiceId) return;
    const fallback = branches.data.find((b) => b.id === currentBranch) ?? (branches.data.length === 1 ? branches.data[0] : undefined);
    if (fallback) form.setValue('branchId', fallback.id);
  }, [branches.data, currentBranch, invoiceId, form]);

  // ---- open invoices of the payer
  const scopeId = payer === 'customer' ? customerId : companyId;
  const open = useQuery({
    queryKey: [...finKeys.invoices.open(scopeId), payer],
    enabled: !!scopeId,
    queryFn: async ({ signal }) => {
      const base = { pageSize: 100, sort: 'issuedAt:asc', ...(payer === 'customer' ? { customerId: scopeId } : { corporateAccountId: scopeId }) };
      const [issued, partial] = await Promise.all([api.invoices.list({ ...base, status: 'ISSUED' }, signal), api.invoices.list({ ...base, status: 'PARTIALLY_PAID' }, signal)]);
      return { rows: [...issued.data, ...partial.data], more: issued.meta.total > issued.data.length || partial.meta.total > partial.data.length };
    },
  });
  /** The invoice the page was opened for first, then the oldest. */
  const invoices = React.useMemo<InvoiceRow[]>(() => {
    const rows = [...(open.data?.rows ?? [])].filter((r) => Number(r.balanceDue) > 0).sort((a, b) => (a.issuedAt ?? '').localeCompare(b.issuedAt ?? ''));
    return invoiceId ? [...rows.filter((r) => r.id === invoiceId), ...rows.filter((r) => r.id !== invoiceId)] : rows;
  }, [open.data, invoiceId]);

  const autoFill = React.useCallback(
    (value: string) => {
      const { amounts } = allocateOldestFirst(value, invoices.map((i) => i.balanceDue));
      setAllocations(Object.fromEntries(invoices.map((inv, i) => [inv.id, isZeroMoney(amounts[i]) ? '' : amounts[i]])));
      setAllocationError(null);
    },
    [invoices],
  );
  React.useEffect(() => {
    if (!manual) autoFill(amount);
  }, [amount, manual, autoFill]);

  const allocated = sumAmounts(invoices.map((i) => allocations[i.id]));
  const remaining = diffAmounts(amount, allocated);
  const totalOpen = sumAmounts(invoices.map((i) => i.balanceDue));
  const balanced = isPositiveAmount(amount) && isZeroMoney(remaining);

  const changePayer = (next: 'customer' | 'company') => {
    setPayer(next);
    setManual(false);
    setAllocations({});
  };

  const save = async (values: { method: string; amount: string; reference?: string | null; notes?: string | null; branchId: string }) => {
    setAllocationError(null);
    setMaybeRecorded(false);
    const lines = invoices.map((inv) => ({ invoice: inv, amount: allocations[inv.id] ?? '' })).filter((l) => isPositiveAmount(l.amount));
    const invalid = invoices.find((inv) => (allocations[inv.id] ?? '') !== '' && hundredths(allocations[inv.id]) === null);
    if (invalid) return setAllocationError(t('fin.payments.form.errors.invalidAmount', { number: invalid.invoiceNo }));
    const over = lines.find((l) => compareMoney(l.amount, l.invoice.balanceDue) > 0);
    if (over) return setAllocationError(t('fin.payments.form.errors.overBalance', { number: over.invoice.invoiceNo, balance: formatMoney(over.invoice.balanceDue, over.invoice.currency) }));
    if (!lines.length) return setAllocationError(t('fin.payments.form.errors.noAllocation'));
    if (!isZeroMoney(diffAmounts(values.amount, sumAmounts(lines.map((l) => l.amount))))) {
      return setAllocationError(t('fin.payments.form.errors.mismatch', { amount: formatMoney(values.amount, currency), allocated: formatMoney(allocated, currency) }));
    }
    try {
      const payment = await api.payments.record(
        {
          method: values.method,
          amount: values.amount,
          reference: values.reference ?? null,
          notes: values.notes ?? null,
          branchId: values.branchId,
          ...(payer === 'customer' && customerId ? { customerId } : {}),
          allocations: lines.map((l) => ({ invoiceId: l.invoice.id, amount: l.amount })),
        },
        idempotencyKey.current,
      );
      toasts.success(t('fin.payments.form.recorded', { number: payment.paymentNo }), payment.receiptNo ? t('fin.payments.form.recordedDescription', { receipt: payment.receiptNo }) : undefined);
      await Promise.all(MONEY_RESOURCES.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      router.push(`/payments/${payment.id}?recorded=1`);
    } catch (error) {
      // The same key with different details: an earlier attempt of this form may already have gone through.
      if (isApiError(error) && error.code === 'IDEMPOTENCY_KEY_REUSED') {
        setMaybeRecorded(true);
        return;
      }
      throw error;
    }
  };

  const referenceLabel = t(`fin.payments.form.reference.${method as 'CASH'}`);

  return (
    <>
      <PageHeader title={t('fin.payments.form.title')} description={t('fin.payments.form.description')} breadcrumbs={[{ label: t('fin.payments.title'), href: '/payments' }]} />
      {target.isError ? <LoadError error={target.error} onRetry={() => void target.refetch()} className="mb-6" /> : null}

      <Form form={form} onSubmit={(values) => save(values as Parameters<typeof save>[0])} className="space-y-6">
        <Card>
          <CardHeader className="pb-0">
            <CardTitle>{t('fin.payments.form.who')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {mayReadCompanies && !invoiceId ? (
              <RadioGroup value={payer} onValueChange={(v) => changePayer(v as 'customer' | 'company')} aria-label={t('fin.payments.form.who')} className="flex flex-wrap gap-x-8 gap-y-2">
                {(['customer', 'company'] as const).map((value) => (
                  <div key={value} className="flex items-center gap-2.5">
                    <RadioGroupItem id={`${methodId}-payer-${value}`} value={value} />
                    <Label htmlFor={`${methodId}-payer-${value}`} className="cursor-pointer text-base font-normal">
                      {t(`fin.payments.form.payer.${value}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            ) : null}
            <div className="sm:max-w-md">
              {payer === 'customer' ? (
                <CustomerPicker
                  aria-label={t('fin.common.customer')}
                  value={customerId}
                  selectedLabel={customerName ?? (customerId ? '…' : null)}
                  disabled={!!invoiceId}
                  onChange={(id, picked) => {
                    setCustomerId(id);
                    setCustomerName(picked?.fullName ?? null);
                    setManual(false);
                    setAllocations({});
                  }}
                />
              ) : (
                <CorporateAccountPicker
                  aria-label={t('fin.common.company')}
                  value={companyId}
                  selectedLabel={companyName ?? (companyId ? '…' : null)}
                  onChange={(id, picked) => {
                    setCompanyId(id);
                    setCompanyName(picked?.companyName ?? null);
                    setManual(false);
                    setAllocations({});
                  }}
                />
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-0">
            <CardTitle>{t('fin.payments.form.how')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <FormField name="method" label={t('fin.payments.columns.method')} required>
              {(field) => (
                <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('fin.payments.columns.method')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {METHODS.map(({ value, icon: Icon }) => (
                    <label
                      key={value}
                      htmlFor={`${methodId}-${value}`}
                      className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-base transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-secondary has-[[data-state=checked]]:bg-secondary-soft/60"
                    >
                      <RadioGroupItem id={`${methodId}-${value}`} value={value} />
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0">{t(`fin.methods.${value}`)}</span>
                    </label>
                  ))}
                </RadioGroup>
              )}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <FormField name="amount" label={t('fin.payments.form.amount')} required hint={invoices.length ? t('fin.payments.form.amountHint', { total: formatMoney(totalOpen, currency) }) : undefined}>
                {(field) => <MoneyInput {...field} currency={currency} />}
              </FormField>
              <FormField name="reference" label={referenceLabel} optional={method === 'CASH'} hint={t('fin.payments.form.referenceHint')}>
                {(field) => <Input {...field} autoComplete="off" maxLength={120} dir="auto" />}
              </FormField>
              {branches.data && branches.data.length > 1 ? (
                <FormField name="branchId" label={t('fin.payments.form.branch')} required>
                  {(field) => <FieldSelect {...field} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />}
                </FormField>
              ) : null}
            </div>
            <FormField name="notes" label={t('fin.payments.form.notes')} optional>
              {(field) => <Textarea {...field} rows={2} maxLength={500} />}
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="items-center pb-4">
            <div className="min-w-0">
              <CardTitle>{t('fin.payments.form.allocate')}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">{t('fin.payments.form.allocateHint')}</p>
            </div>
            {invoices.length > 1 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setManual(false);
                  autoFill(amount);
                }}
              >
                <WandSparkles aria-hidden="true" />
                {t('fin.payments.form.autoFill')}
              </Button>
            ) : null}
          </CardHeader>
          <div className="border-t">
            {!scopeId ? (
              <EmptyState icon={<Receipt />} title={t('fin.payments.form.choosePayerTitle')} description={t('fin.payments.form.choosePayerText')} />
            ) : open.isPending ? (
              <div className="space-y-3 p-5" aria-hidden="true">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : open.isError ? (
              <div className="p-5">
                <LoadError error={open.error} onRetry={() => void open.refetch()} />
              </div>
            ) : invoices.length === 0 ? (
              <EmptyState
                icon={<Building />}
                title={t('fin.payments.form.noInvoicesTitle')}
                description={t('fin.payments.form.noInvoicesText')}
                action={
                  payer === 'customer' && session.hasPermission('invoice.manage') ? (
                    <Button asChild variant="outline">
                      <Link href={`/invoices/new?customerId=${customerId}`}>{t('fin.invoices.new')}</Link>
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <ul className="divide-y">
                  {invoices.map((inv) => (
                    <li key={inv.id} className="grid items-center gap-x-6 gap-y-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto_11rem]">
                      <div className="min-w-0">
                        <TextLink href={`/invoices/${inv.id}`} className="tabular">
                          {inv.invoiceNo}
                        </TextLink>
                        <span className="ms-2 inline-flex flex-wrap gap-1.5 align-middle">
                          <StatusBadge kind="invoice" status={inv.status} />
                          {inv.overdue ? <Badge tone="danger">{t('fin.invoices.overdue')}</Badge> : null}
                        </span>
                        <p className="text-sm text-muted-foreground">
                          {payer === 'company' ? `${inv.customer.fullName} · ` : ''}
                          {t('fin.payments.form.issuedOn', { date: formatDate(inv.issuedAt) })}
                          {inv.request ? <span className="tabular"> · {inv.request.requestNo}</span> : null}
                        </p>
                      </div>
                      <div className="text-sm sm:text-end">
                        <span className="text-muted-foreground">{t('fin.payments.form.balance')} </span>
                        <Money amount={inv.balanceDue} currency={inv.currency} className="font-medium text-foreground" />
                      </div>
                      <MoneyInput
                        aria-label={t('fin.payments.form.allocationFor', { number: inv.invoiceNo })}
                        value={allocations[inv.id] ?? ''}
                        currency={inv.currency}
                        aria-invalid={compareSafe(allocations[inv.id], inv.balanceDue) > 0}
                        onChange={(value) => {
                          setManual(true);
                          setAllocationError(null);
                          setAllocations((current) => ({ ...current, [inv.id]: value }));
                        }}
                      />
                    </li>
                  ))}
                </ul>
                {open.data?.more ? <p className="border-t px-5 py-3 text-sm text-muted-foreground">{t('fin.payments.form.moreInvoices')}</p> : null}
                <dl className="flex flex-wrap items-center justify-end gap-x-8 gap-y-1 border-t bg-muted/40 px-5 py-3.5 text-base" aria-live="polite">
                  <div className="flex items-baseline gap-2">
                    <dt className="text-muted-foreground">{t('fin.payments.form.allocated')}</dt>
                    <dd className="font-semibold">
                      <Money amount={allocated} currency={currency} />
                    </dd>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <dt className="text-muted-foreground">{t('fin.payments.form.remaining')}</dt>
                    <dd className={balanced ? 'font-semibold text-success-text' : 'font-semibold text-warning-text'}>
                      <Money amount={remaining} currency={currency} />
                    </dd>
                  </div>
                </dl>
              </>
            )}
          </div>
        </Card>

        {allocationError ? (
          <Alert tone="danger" live>
            {allocationError}
          </Alert>
        ) : null}
        {maybeRecorded ? (
          <Alert
            tone="warning"
            live
            title={t('fin.payments.form.maybeRecordedTitle')}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={customerId ? `/payments?customerId=${customerId}` : '/payments'}>{t('fin.payments.form.checkPayments')}</Link>
              </Button>
            }
          >
            {t('fin.payments.form.maybeRecordedText')}
          </Alert>
        ) : null}
        <FormError />
        <p className="text-sm text-muted-foreground">{t('fin.payments.form.next')}</p>
        <FormActions>
          <Button asChild variant="outline">
            <Link href={invoiceId ? `/invoices/${invoiceId}` : '/payments'}>{t('common.cancel')}</Link>
          </Button>
          <Button type="submit" variant="accent" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            <Banknote aria-hidden="true" />
            {t('fin.payments.form.submit')}
          </Button>
        </FormActions>
      </Form>
    </>
  );
}

/** compareMoney for a value that may still be half typed. */
function compareSafe(a: string | undefined, b: string): number {
  return hundredths(a) === null ? -1 : compareMoney(a as string, b);
}
