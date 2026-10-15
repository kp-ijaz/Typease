'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil } from 'lucide-react';
import { updateReconciliationSchema, moneyAmount } from '@typease/validation';
import {
  Alert, Badge, Button, Card, Checkbox, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField,
  Input, MoneyInput, PageHeader, RequirePermission, Textarea, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { FinanceTabs } from '@/components/fin/finance-tabs';
import { DetailSkeleton, ImmutableNote, LoadError, Money, ReasonDialog, Section, TextLink } from '@/components/fin/shared';
import type { ReconciliationDetail as Reconciliation, ReconciliationPayment } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';
import { RECONCILIATION_TONE } from '../reconciliation';

export function ReconciliationDetail({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['payment.reconcile']}>
      <ReconciliationDetailInner id={id} />
    </RequirePermission>
  );
}

function ReconciliationDetailInner({ id }: { id: string }) {
  const { t, formatDate } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const record = useQuery({ queryKey: finKeys.reconciliations.detail(id), queryFn: ({ signal }) => api.reconciliations.get(id, signal) });
  const [editing, setEditing] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [busy, setBusy] = React.useState<'attach' | 'detach' | null>(null);
  const [pickAttach, setPickAttach] = React.useState<Set<string>>(new Set());
  const [pickDetach, setPickDetach] = React.useState<Set<string>>(new Set());

  const breadcrumbs = [{ label: t('fin.reconciliation.title'), href: '/finance/reconciliation' }];
  const apply = async (next: Reconciliation) => {
    queryClient.setQueryData(finKeys.reconciliations.detail(id), next);
    await Promise.all([finKeys.reconciliations.all, finKeys.payments.all].map((queryKey) => queryClient.invalidateQueries({ queryKey, refetchType: 'inactive' })));
  };

  if (record.isPending) return <DetailSkeleton />;
  if (record.isError) {
    return (
      <>
        <PageHeader title={t('fin.reconciliation.detail.title')} breadcrumbs={breadcrumbs} />
        <LoadError error={record.error} onRetry={() => void record.refetch()} />
      </>
    );
  }

  const r = record.data;
  const closed = r.status === 'CLOSED';
  const currency = session.tenant?.currency ?? 'AED';
  const hasDifference = Number(r.difference) !== 0;

  const move = async (kind: 'attach' | 'detach', ids: string[]) => {
    if (!ids.length) return;
    setBusy(kind);
    try {
      await apply(kind === 'attach' ? await api.reconciliations.attach(r.id, ids) : await api.reconciliations.detach(r.id, ids));
      toasts.success(kind === 'attach' ? t('fin.reconciliation.detail.attached', { count: ids.length }) : t('fin.reconciliation.detail.detached', { count: ids.length }));
      setPickAttach(new Set());
      setPickDetach(new Set());
    } catch (error) {
      toasts.error(error);
    } finally {
      setBusy(null);
    }
  };

  const paymentList = (payments: ReconciliationPayment[], picked: Set<string>, setPicked: (next: Set<string>) => void, caption: string) => (
    <ul className="divide-y" aria-label={caption}>
      {payments.map((p) => {
        const net = Number(p.refundedAmount) === 0;
        return (
          <li key={p.id} className="flex items-center gap-3 px-5 py-3">
            {!closed ? (
              <Checkbox
                aria-label={`${caption}: ${p.paymentNo}`}
                checked={picked.has(p.id)}
                onCheckedChange={(checked) => {
                  const next = new Set(picked);
                  if (checked === true) next.add(p.id);
                  else next.delete(p.id);
                  setPicked(next);
                }}
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <TextLink href={`/payments/${p.id}`} className="tabular">
                {p.paymentNo}
              </TextLink>
              <p className="truncate text-sm text-muted-foreground">
                <bdi>{formatDate(p.receivedAt)}</bdi>
                {p.reference ? (
                  <>
                    {' · '}
                    <bdi>{p.reference}</bdi>
                  </>
                ) : null}
              </p>
            </div>
            <div className="text-end">
              <Money amount={p.amount} currency={currency} className="font-medium" />
              {!net ? (
                <p className="text-xs text-muted-foreground">
                  {t('fin.payments.refundedShort')} <Money amount={p.refundedAmount} currency={currency} />
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <PageHeader
        title={t('fin.reconciliation.detail.heading', { method: t(`fin.methods.${r.method}`) })}
        breadcrumbs={breadcrumbs}
        meta={<Badge tone={RECONCILIATION_TONE[r.status]}>{t(`fin.reconciliation.status.${r.status}`)}</Badge>}
        description={t('fin.reconciliation.detail.description', { from: formatDate(r.periodStart), to: formatDate(r.periodEnd) })}
        action={
          !closed ? (
            <Button variant="accent" onClick={() => setClosing(true)} disabled={r.attached.count === 0}>
              <Lock aria-hidden="true" />
              {t('fin.reconciliation.detail.close')}
            </Button>
          ) : null
        }
        secondary={
          !closed ? (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" />
              {t('fin.reconciliation.detail.edit')}
            </Button>
          ) : null
        }
      />
      <FinanceTabs current="reconciliation" />

      {closed ? <ImmutableNote className="mb-6">{t('fin.reconciliation.detail.closedNote')}</ImmutableNote> : null}
      {!closed && r.attached.count === 0 ? (
        <Alert tone="info" className="mb-6" title={t('fin.reconciliation.detail.openTitle')}>
          {t('fin.reconciliation.detail.openText')}
        </Alert>
      ) : null}
      {!closed && r.status === 'DISCREPANCY' ? (
        <Alert tone="danger" className="mb-6" title={t('fin.reconciliation.detail.discrepancyTitle')}>
          {t('fin.reconciliation.detail.discrepancyText')}
        </Alert>
      ) : null}

      {/* expected vs statement */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {(
          [
            ['expected', r.expectedAmount, r.attached.count ? t('fin.reconciliation.detail.expectedAttached', { count: r.attached.count }) : t('fin.reconciliation.detail.expectedCandidates', { count: r.candidates.count })],
            ['settled', r.settledAmount, t('fin.reconciliation.settledHint')],
            ['fees', r.feeAmount, t('fin.reconciliation.feesHint')],
          ] as const
        ).map(([key, amount, hint]) => (
          <Card key={key} className="p-4">
            <p className="text-sm font-medium text-muted-foreground">{t(`fin.reconciliation.${key}`)}</p>
            <Money amount={amount} currency={currency} className="mt-1 block text-xl font-semibold text-foreground sm:text-2xl" />
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </Card>
        ))}
        <Card className={hasDifference ? 'border-destructive/30 bg-destructive-soft/60 p-4' : 'border-success/25 bg-success-soft/60 p-4'}>
          <p className="text-sm font-medium text-muted-foreground">{t('fin.reconciliation.difference')}</p>
          <Money amount={r.difference} currency={currency} className="mt-1 block text-xl font-semibold text-foreground sm:text-2xl" />
          <p className="mt-1 text-xs text-muted-foreground">{t('fin.reconciliation.detail.differenceHint')}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Section
            title={t('fin.reconciliation.detail.attachedTitle', { count: r.attached.count })}
            description={t('fin.reconciliation.detail.attachedHint')}
            flush
            action={
              !closed && pickDetach.size > 0 ? (
                <Button variant="outline" size="sm" onClick={() => void move('detach', [...pickDetach])} loading={busy === 'detach'}>
                  {t('fin.reconciliation.detail.detach', { count: pickDetach.size })}
                </Button>
              ) : (
                <Money amount={r.attached.total} currency={currency} className="font-semibold" />
              )
            }
          >
            {r.attached.payments.length === 0 ? <EmptyState title={t('fin.reconciliation.detail.noAttached')} /> : paymentList(r.attached.payments, pickDetach, setPickDetach, t('fin.reconciliation.detail.selectToRemove'))}
          </Section>

          {!closed ? (
            <Section
              title={t('fin.reconciliation.detail.candidatesTitle', { count: r.candidates.count })}
              description={t('fin.reconciliation.detail.candidatesHint')}
              flush
              action={
                r.candidates.payments.length ? (
                  <span className="inline-flex flex-wrap gap-2">
                    {pickAttach.size > 0 ? (
                      <Button size="sm" onClick={() => void move('attach', [...pickAttach])} loading={busy === 'attach'}>
                        {t('fin.reconciliation.detail.attach', { count: pickAttach.size })}
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => void move('attach', r.candidates.payments.map((p) => p.id))} loading={busy === 'attach'}>
                        {t('fin.reconciliation.detail.attachAll')}
                      </Button>
                    )}
                  </span>
                ) : undefined
              }
            >
              {r.candidates.payments.length === 0 ? (
                <EmptyState title={t('fin.reconciliation.detail.noCandidates')} description={t('fin.reconciliation.detail.noCandidatesText')} />
              ) : (
                paymentList(r.candidates.payments, pickAttach, setPickAttach, t('fin.reconciliation.detail.selectToAttach'))
              )}
            </Section>
          ) : null}
        </div>

        <Section title={t('fin.reconciliation.detail.statementTitle')}>
          <DescriptionList
            columns={1}
            items={[
              { label: t('fin.payments.columns.method'), value: `${t(`fin.methods.${r.method}`)}${r.gateway ? ` (${r.gateway})` : ''}` },
              { label: t('fin.common.period'), value: `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}` },
              { label: t('fin.reconciliation.statement'), value: r.statementReference ? <span dir="auto">{r.statementReference}</span> : null },
              { label: t('fin.reconciliation.notes'), value: r.notes ? <span dir="auto">{r.notes}</span> : null },
            ]}
          />
        </Section>
      </div>

      {editing ? <EditDialog record={r} currency={currency} onClose={() => setEditing(false)} onSaved={apply} /> : null}
      <ReasonDialog
        open={closing}
        onOpenChange={setClosing}
        title={t('fin.reconciliation.detail.closeTitle')}
        description={hasDifference ? t('fin.reconciliation.detail.closeDiscrepancyText') : t('fin.reconciliation.detail.closeText')}
        label={t('fin.reconciliation.notes')}
        hint={hasDifference ? t('fin.reconciliation.detail.closeNoteRequired') : undefined}
        required={hasDifference && !r.notes}
        submitLabel={t('fin.reconciliation.detail.close')}
        onSubmit={async (notes) => {
          await apply(await api.reconciliations.close(r.id, { notes: notes || null }));
          toasts.success(t('fin.reconciliation.detail.closedToast'));
        }}
      >
        <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2.5 text-base">
          <span>{t('fin.reconciliation.difference')}</span>
          <Money amount={r.difference} currency={currency} className="font-semibold" />
        </div>
      </ReasonDialog>
    </>
  );
}

const editSchema = updateReconciliationSchema.extend({ settledAmount: moneyAmount });

function EditDialog({ record, currency, onClose, onSaved }: { record: Reconciliation; currency: string; onClose: () => void; onSaved: (next: Reconciliation) => Promise<void> }) {
  const { t } = useI18n();
  const api = useFinApi();
  const toasts = useToast();
  // The settled amount stays mandatory when the figures are corrected; emptied fees mean "no fees".
  const form = useZodForm(editSchema, {
    defaultValues: { statementReference: record.statementReference ?? '', settledAmount: record.settledAmount, feeAmount: record.feeAmount, notes: record.notes ?? '' },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await onSaved(await api.reconciliations.update(record.id, { settledAmount: values.settledAmount, feeAmount: values.feeAmount ?? '0', statementReference: values.statementReference ?? null, notes: values.notes ?? null }));
            toasts.success(t('fin.reconciliation.detail.saved'));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('fin.reconciliation.detail.edit')}</DialogTitle>
            <DialogDescription>{t('fin.reconciliation.detail.editText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="settledAmount" label={t('fin.reconciliation.settled')} required hint={t('fin.reconciliation.settledHint')}>
                {(field) => <MoneyInput {...field} currency={currency} />}
              </FormField>
              <FormField name="feeAmount" label={t('fin.reconciliation.fees')} hint={t('fin.reconciliation.feesHint')}>
                {(field) => <MoneyInput {...field} currency={currency} />}
              </FormField>
            </div>
            <FormField name="statementReference" label={t('fin.reconciliation.statement')} optional>
              {(field) => <Input {...field} autoComplete="off" maxLength={120} dir="auto" />}
            </FormField>
            <FormField name="notes" label={t('fin.reconciliation.notes')} optional>
              {(field) => <Textarea {...field} rows={3} maxLength={1000} />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
