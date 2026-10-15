'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { isApiError, newIdempotencyKey } from '@typease/api-client';
import { requestRefundSchema, z } from '@typease/validation';
import {
  Alert, Button, Card, CardContent, CardHeader, CardTitle, Combobox, DescriptionList, Form, FormActions, FormError, FormField, MoneyInput, PageHeader, RequirePermission, StatusBadge, Textarea,
  compareMoney, subtractMoney, useI18n, useSession, useToast, useZodForm, type ComboboxOption,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { minAmount, sumAmounts } from '@/components/fin/calc';
import { ChargeChoice } from '@/components/fin/charge-choice';
import { DetailSkeleton, FieldSelect, LoadError, Money, TextLink, useApprovers } from '@/components/fin/shared';
import type { PaymentDetail } from '@/components/fin/types';
import { MONEY_RESOURCES, finKeys } from '@/lib/keys/fin';

const OPEN_REFUND = new Set(['REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED']);
const schema = requestRefundSchema.pick({ amount: true, reason: true, invoiceId: true }).extend({ charge: z.enum(['cancel', 'keep'], { message: 'Required' }) });

export function RefundForm({ paymentId }: { paymentId?: string }) {
  return (
    <RequirePermission anyOf={['refund.request']}>
      <RefundFormInner paymentId={paymentId} />
    </RequirePermission>
  );
}

function RefundFormInner({ paymentId: initialPayment }: { paymentId?: string }) {
  const { t } = useI18n();
  const api = useFinApi();
  const [paymentId, setPaymentId] = React.useState(initialPayment ?? '');
  const payment = useQuery({ queryKey: finKeys.payments.detail(paymentId), queryFn: ({ signal }) => api.payments.get(paymentId, signal), enabled: !!paymentId });

  // Without a payment in the link, the first step is to find it.
  const loadPayments = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const [completed, partly] = await Promise.all([
        api.payments.list({ q: q || undefined, pageSize: 15, sort: 'createdAt:desc', status: 'COMPLETED' }, signal),
        api.payments.list({ q: q || undefined, pageSize: 5, sort: 'createdAt:desc', status: 'PARTIALLY_REFUNDED' }, signal),
      ]);
      return [...completed.data, ...partly.data].map((p) => ({ value: p.id, label: p.paymentNo, description: [p.customer?.fullName, p.receiptNo, `${p.currency} ${p.amount}`].filter(Boolean).join(' · ') }));
    },
    [api],
  );

  return (
    <>
      <PageHeader title={t('fin.refunds.form.title')} description={t('fin.refunds.form.description')} breadcrumbs={[{ label: t('fin.refunds.title'), href: '/refunds' }]} />
      {!initialPayment ? (
        <Card className="mb-6">
          <CardHeader className="pb-0">
            <CardTitle>{t('fin.refunds.form.findPayment')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="sm:max-w-md">
              <Combobox
                aria-label={t('fin.refunds.form.findPayment')}
                value={paymentId}
                onValueChange={(id) => setPaymentId(id)}
                loadOptions={loadPayments}
                placeholder={t('fin.refunds.form.paymentPlaceholder')}
                searchPlaceholder={t('fin.payments.searchPlaceholder')}
                selectedLabel={payment.data?.paymentNo}
                clearable
              />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t('fin.refunds.form.findPaymentHint')}</p>
          </CardContent>
        </Card>
      ) : null}
      {!paymentId ? null : payment.isPending ? <DetailSkeleton /> : payment.isError ? <LoadError error={payment.error} onRetry={() => void payment.refetch()} /> : <RefundFields key={payment.data.id} payment={payment.data} />}
    </>
  );
}

function RefundFields({ payment }: { payment: PaymentDetail }) {
  const { t, formatMoney, formatDateTime } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const approvers = useApprovers('refund.approve', session.user?.id);
  // One key per form: a double click can never create two refund requests.
  const idempotencyKey = React.useRef(newIdempotencyKey());

  const allocations = payment.paymentAllocations;
  const form = useZodForm(schema, { defaultValues: { amount: '', reason: '', invoiceId: allocations.length === 1 ? allocations[0].invoiceId : '', charge: (allocations.length === 0 ? 'keep' : '') as 'keep' } });
  const invoiceId = form.watch('invoiceId') as string;

  const waiting = sumAmounts(payment.refunds.filter((r) => OPEN_REFUND.has(r.status)).map((r) => r.amount));
  const refundable = subtractMoney(subtractMoney(payment.amount, payment.refundedAmount), waiting);
  // For one invoice: what was allocated to it, minus refunds of that invoice that are done or still open.
  const allocation = allocations.find((a) => a.invoiceId === invoiceId);
  const taken = sumAmounts(payment.refunds.filter((r) => r.invoiceId === invoiceId && (OPEN_REFUND.has(r.status) || r.status === 'COMPLETED')).map((r) => r.amount));
  const max = allocation ? minAmount(refundable, subtractMoney(allocation.amount, taken)) : refundable;
  const refundableStatus = payment.status === 'COMPLETED' || payment.status === 'PARTIALLY_REFUNDED';
  const possible = refundableStatus && Number(refundable) > 0;

  const summary = (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle>{t('fin.refunds.form.payment')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DescriptionList
          columns={3}
          items={[
            {
              label: t('fin.common.payment'),
              value: (
                <>
                  <TextLink href={`/payments/${payment.id}`} className="tabular">
                    {payment.paymentNo}
                  </TextLink>
                  <span className="ms-2 inline-flex align-middle">
                    <StatusBadge kind="payment" status={payment.status} />
                  </span>
                </>
              ),
            },
            { label: t('fin.common.customer'), value: payment.customer?.fullName ?? null },
            { label: t('fin.payments.columns.method'), value: `${t(`fin.methods.${payment.method}`)} · ${formatDateTime(payment.receivedAt)}` },
            { label: t('fin.payments.detail.received'), value: <Money amount={payment.amount} currency={payment.currency} /> },
            { label: t('fin.refunds.form.alreadyRefunded'), value: <Money amount={sumAmounts([payment.refundedAmount, waiting])} currency={payment.currency} /> },
            { label: t('fin.refunds.form.refundable'), value: <Money amount={Number(refundable) > 0 ? refundable : '0.00'} currency={payment.currency} className="font-semibold" /> },
          ]}
        />
        {Number(waiting) > 0 ? <p className="mt-3 text-sm text-muted-foreground">{t('fin.refunds.form.waitingNote', { amount: formatMoney(waiting, payment.currency) })}</p> : null}
      </CardContent>
    </Card>
  );

  if (!possible) {
    return (
      <div className="space-y-6">
        {summary}
        <Alert tone="warning" title={t('fin.refunds.form.notPossibleTitle')}>
          {refundableStatus ? t('fin.refunds.form.nothingLeft') : t('fin.refunds.form.notCompleted')}
        </Alert>
      </div>
    );
  }

  return (
    <Form
      form={form}
      className="space-y-6"
      onSubmit={async (values) => {
        if (allocations.length > 1 && !values.invoiceId) {
          form.setError('invoiceId', { type: 'required', message: t('fin.refunds.form.invoiceRequired') });
          return;
        }
        if (compareMoney(values.amount, max) > 0) {
          form.setError('amount', { type: 'max', message: t('fin.refunds.form.tooMuch', { max: formatMoney(max, payment.currency) }) });
          form.setFocus('amount');
          return;
        }
        try {
          const refund = await api.refunds.request(
            { paymentId: payment.id, ...(values.invoiceId ? { invoiceId: values.invoiceId } : {}), amount: values.amount, reason: values.reason, cancelCharge: values.charge === 'cancel' },
            idempotencyKey.current,
          );
          toasts.success(t('fin.refunds.form.requested', { number: refund.refundNo }), t('fin.refunds.form.requestedDescription'));
          await Promise.all(MONEY_RESOURCES.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
          router.push(`/refunds/${refund.id}`);
        } catch (error) {
          if (isApiError(error) && error.code === 'IDEMPOTENCY_KEY_REUSED') {
            form.setError('root.server', { type: error.code, message: t('fin.refunds.form.maybeRequested') });
            return;
          }
          throw error;
        }
      }}
    >
      {summary}

      <Card>
        <CardHeader className="pb-0">
          <CardTitle>{t('fin.refunds.form.what')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {allocations.length > 1 ? (
              <FormField name="invoiceId" label={t('fin.refunds.form.invoice')} required hint={t('fin.refunds.form.invoiceHint')}>
                {(field) => <FieldSelect {...field} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={allocations.map((a) => ({ value: a.invoiceId, label: `${a.invoice.invoiceNo} · ${formatMoney(a.amount, payment.currency)}` }))} />}
              </FormField>
            ) : null}
            <FormField name="amount" label={t('fin.refunds.form.amount')} required hint={t('fin.refunds.form.amountHint', { max: formatMoney(max, payment.currency) })}>
              {(field) => <MoneyInput {...field} currency={payment.currency} />}
            </FormField>
          </div>
          <FormField name="reason" label={t('fin.common.reason')} required hint={t('fin.refunds.form.reasonHint')}>
            {(field) => <Textarea {...field} rows={3} maxLength={500} />}
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <div>
            <CardTitle>{t('fin.refunds.charge.label')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{t('fin.refunds.charge.help')}</p>
          </div>
        </CardHeader>
        <CardContent>
          {allocations.length === 0 ? (
            <Alert tone="info">{t('fin.refunds.charge.noInvoice')}</Alert>
          ) : (
            <FormField name="charge" label={t('fin.refunds.charge.label')} hideLabel>
              {(field) => <ChargeChoice id={field.id} value={field.value} onChange={field.onChange} invalid={field['aria-invalid']} />}
            </FormField>
          )}
        </CardContent>
      </Card>

      <Alert tone="info" title={t('fin.refunds.form.nextTitle')}>
        <p>{t('fin.refunds.form.nextText')}</p>
        {approvers !== null ? <p className="mt-1">{approvers.length ? t('fin.refunds.approvers', { names: approvers.join(', ') }) : t('fin.refunds.approversNone')}</p> : null}
      </Alert>

      <FormError />
      <FormActions>
        <Button asChild variant="outline">
          <Link href={`/payments/${payment.id}`}>{t('common.cancel')}</Link>
        </Button>
        <Button type="submit" variant="accent" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          <Undo2 aria-hidden="true" />
          {t('fin.refunds.form.submit')}
        </Button>
      </FormActions>
    </Form>
  );
}
