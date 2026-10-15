'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { PAYMENT_POLICIES, TAX_MODES, servicePriceSchema, updateServiceSchema, z } from '@typease/validation';
import {
  Alert, Badge, Button, ConfirmDialog, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormActions, FormError,
  FormField, Input, MoneyInput, Select, Skeleton, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { useBranches } from '@/components/branch';
import { Loadable, Panel, useRun } from '@/components/ops/common';
import type { EffectivePrice, PriceRow } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import type { ServiceTabProps } from './service-editor';

const DEFAULT = '__default__';

const termsSchema = updateServiceSchema
  .pick({ taxMode: true, paymentPolicy: true, depositPercent: true })
  .superRefine((v, ctx) => {
    if (v.paymentPolicy === 'DEPOSIT' && (v.depositPercent === null || v.depositPercent === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['depositPercent'], message: 'Enter the deposit percentage' });
  });

/**
 * Fees of a service. The service fee is the centre's own charge; the government and
 * third-party amounts are ESTIMATES and are always named so. Prices are never edited:
 * a new price replaces the current one from now on and the history keeps what applied when.
 */
export function PricingTab({ service, editable }: ServiceTabProps) {
  const { t, pick, formatMoney, formatDateTime } = useI18n();
  const api = useApi();
  const branches = useBranches();
  const { run } = useRun();
  const [branchDialog, setBranchDialog] = React.useState(false);
  const [ending, setEnding] = React.useState<PriceRow | null>(null);
  const [previewBranch, setPreviewBranch] = React.useState(DEFAULT);

  const offeredBranches = (branches.data ?? []).filter((b) => service.allBranches || service.branchIds.includes(b.id));
  const branchName = (id: string | null) => {
    const b = (branches.data ?? []).find((x) => x.id === id);
    return b ? pick(b.name, b.nameAr) : t('ops.services.pricing.unknownBranch');
  };
  const branchPrices = service.activePrices.filter((p) => p.branchId);
  const history = useQuery({ queryKey: opsKeys.services.prices(service.id), queryFn: () => api.client.get<PriceRow[]>(`/services/${service.id}/prices`) });
  const invalidate = [opsKeys.services.all];

  return (
    <div className="space-y-4">
      <Alert tone="info">{t('ops.services.pricing.estimateNote')}</Alert>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title={t('ops.services.pricing.priceTitle')} description={t('ops.services.pricing.priceDescription')}>
          {service.price ? (
            <DescriptionList
              columns={3}
              className="mb-6"
              items={[
                { label: t('ops.services.pricing.serviceFee'), value: <span className="tabular font-medium">{formatMoney(service.price.serviceFee, service.price.currency)}</span> },
                { label: t('ops.services.pricing.governmentFee'), value: <span className="tabular">{formatMoney(service.price.governmentFeeEstimate, service.price.currency)}</span> },
                { label: t('ops.services.pricing.thirdPartyFee'), value: <span className="tabular">{formatMoney(service.price.thirdPartyFeeEstimate, service.price.currency)}</span> },
              ]}
            />
          ) : (
            <Alert tone="warning" className="mb-5">
              {t('ops.services.pricing.noPrice')}
            </Alert>
          )}
          {editable ? <PriceForm serviceId={service.id} current={service.price} /> : null}
        </Panel>

        <Panel
          title={t('ops.services.pricing.previewTitle')}
          description={t('ops.services.pricing.previewDescription')}
          action={
            offeredBranches.length > 1 || branchPrices.length > 0 ? (
              <Select
                aria-label={t('ops.services.pricing.previewBranch')}
                size="sm"
                className="w-52"
                value={previewBranch}
                onValueChange={setPreviewBranch}
                options={[{ value: DEFAULT, label: t('ops.services.pricing.defaultPrice') }, ...offeredBranches.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
              />
            ) : undefined
          }
        >
          <PricePreview serviceId={service.id} branchId={previewBranch === DEFAULT ? undefined : previewBranch} version={service.version} />
        </Panel>
      </div>

      <Panel title={t('ops.services.pricing.termsTitle')} description={t('ops.services.pricing.termsDescription')}>
        <TermsForm service={service} editable={editable} />
      </Panel>

      {(branches.data?.length ?? 0) > 1 ? (
        <Panel
          title={t('ops.services.pricing.branchTitle')}
          description={t('ops.services.pricing.branchDescription')}
          action={
            editable && service.price ? (
              <Button variant="outline" size="sm" onClick={() => setBranchDialog(true)}>
                <Plus aria-hidden="true" />
                {t('ops.services.pricing.branchAdd')}
              </Button>
            ) : undefined
          }
        >
          {branchPrices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('ops.services.pricing.branchEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {branchPrices.map((price) => (
                <li key={price.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
                  <div>
                    <p className="font-medium">{branchName(price.branchId)}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('ops.services.pricing.branchLine', {
                        fee: formatMoney(price.serviceFee, price.currency),
                        government: formatMoney(price.governmentFeeEstimate, price.currency),
                        thirdParty: formatMoney(price.thirdPartyFeeEstimate, price.currency),
                      })}
                    </p>
                  </div>
                  {editable ? (
                    <Button variant="destructive-outline" size="sm" onClick={() => setEnding(price)}>
                      {t('ops.services.pricing.branchEnd')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <Panel title={t('ops.services.pricing.historyTitle')} description={t('ops.services.pricing.historyDescription')} bodyClassName="px-0 pb-0">
        <Loadable query={history} skeleton={<Skeleton className="mx-5 mb-5 h-32" />}>
          {(rows) => (
            <Table className="border-t">
              <TableCaption>{t('ops.services.pricing.historyTitle')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ops.services.pricing.columns.from')}</TableHead>
                  <TableHead>{t('ops.services.pricing.columns.to')}</TableHead>
                  <TableHead>{t('ops.services.pricing.columns.scope')}</TableHead>
                  <TableHead className="text-end">{t('ops.services.pricing.serviceFee')}</TableHead>
                  <TableHead className="text-end">{t('ops.services.pricing.governmentFee')}</TableHead>
                  <TableHead className="text-end">{t('ops.services.pricing.thirdPartyFee')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular whitespace-nowrap">{formatDateTime(row.validFrom)}</TableCell>
                    <TableCell className="tabular whitespace-nowrap">{row.isActive && !row.validTo ? <Badge tone="success">{t('ops.services.pricing.inForce')}</Badge> : formatDateTime(row.validTo)}</TableCell>
                    <TableCell className="whitespace-nowrap">{row.branchId ? (row.branch ? pick(row.branch.name, row.branch.nameAr) : branchName(row.branchId)) : t('ops.services.pricing.defaultPrice')}</TableCell>
                    <TableCell className="tabular whitespace-nowrap text-end">{formatMoney(row.serviceFee, row.currency)}</TableCell>
                    <TableCell className="tabular whitespace-nowrap text-end">{formatMoney(row.governmentFeeEstimate, row.currency)}</TableCell>
                    <TableCell className="tabular whitespace-nowrap text-end">{formatMoney(row.thirdPartyFeeEstimate, row.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Loadable>
      </Panel>

      <BranchPriceDialog open={branchDialog} onOpenChange={setBranchDialog} serviceId={service.id} branches={offeredBranches.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} base={service.price} />
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(next) => !next && setEnding(null)}
        title={t('ops.services.pricing.branchEndTitle', { branch: branchName(ending?.branchId ?? null) })}
        description={t('ops.services.pricing.branchEndText')}
        confirmLabel={t('ops.services.pricing.branchEnd')}
        onConfirm={async () => {
          await run('end', () => api.client.delete(`/services/${service.id}/prices/${ending!.id}`), { success: t('ops.services.pricing.branchEnded'), invalidate, rethrow: true });
        }}
      />
    </div>
  );
}

/** Replaces the default price (all branches). */
function PriceForm({ serviceId, current }: { serviceId: string; current: PriceRow | null }) {
  const { t, formatMoney } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const values = { serviceFee: current ? Number(current.serviceFee).toFixed(2) : '', governmentFeeEstimate: current ? Number(current.governmentFeeEstimate).toFixed(2) : '0.00', thirdPartyFeeEstimate: current ? Number(current.thirdPartyFeeEstimate).toFixed(2) : '0.00' };
  const form = useZodForm(servicePriceSchema, { defaultValues: values });
  React.useEffect(() => {
    form.reset(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  return (
    <Form
      form={form}
      onSubmit={async (input) => {
        const row = await api.client.post<PriceRow>(`/services/${serviceId}/prices`, { serviceFee: input.serviceFee, governmentFeeEstimate: input.governmentFeeEstimate, thirdPartyFeeEstimate: input.thirdPartyFeeEstimate });
        toasts.success(t('ops.services.pricing.priceSaved'), t('ops.services.pricing.priceSavedDescription', { amount: formatMoney(row.serviceFee, row.currency) }));
        await queryClient.invalidateQueries({ queryKey: opsKeys.services.all });
      }}
    >
      <p className="text-sm font-medium text-foreground">{t(current ? 'ops.services.pricing.newPrice' : 'ops.services.pricing.firstPrice')}</p>
      <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-3">
        <FormField name="serviceFee" label={t('ops.services.pricing.serviceFee')} required>
          {(field) => <MoneyInput {...field} />}
        </FormField>
        <FormField name="governmentFeeEstimate" label={t('ops.services.pricing.governmentFee')}>
          {(field) => <MoneyInput {...field} />}
        </FormField>
        <FormField name="thirdPartyFeeEstimate" label={t('ops.services.pricing.thirdPartyFee')}>
          {(field) => <MoneyInput {...field} />}
        </FormField>
      </div>
      <p className="text-sm text-muted-foreground">{t('ops.services.pricing.newPriceHint')}</p>
      <FormError />
      <FormActions>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')} disabled={!form.formState.isDirty}>
          {t('ops.services.pricing.setPrice')}
        </Button>
      </FormActions>
    </Form>
  );
}

/** Tax mode and payment policy (with the deposit percentage). */
function TermsForm({ service, editable }: ServiceTabProps) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const values = { taxMode: service.taxMode, paymentPolicy: service.paymentPolicy, depositPercent: service.depositPercent === null ? ('' as unknown as number) : Number(service.depositPercent) };
  const form = useZodForm(termsSchema, { defaultValues: values, emptyAs: 'null', disabled: !editable });
  React.useEffect(() => {
    form.reset(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.version]);
  const policy = form.watch('paymentPolicy');
  return (
    <Form
      form={form}
      onSubmit={async (input) => {
        await api.client.patch(`/services/${service.id}`, { ...input, depositPercent: input.paymentPolicy === 'DEPOSIT' ? input.depositPercent : null, version: service.version });
        toasts.success(t('ops.services.pricing.termsSaved'));
        await queryClient.invalidateQueries({ queryKey: opsKeys.services.all });
      }}
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <FormField name="taxMode" label={t('ops.services.pricing.taxMode')} hint={t('ops.services.pricing.taxModeHint')}>
          {(field) => <Select {...field} onValueChange={field.onChange} options={TAX_MODES.map((m) => ({ value: m, label: t(`ops.services.pricing.taxModes.${m}`) }))} />}
        </FormField>
        <FormField name="paymentPolicy" label={t('ops.services.pricing.paymentPolicy')} hint={t(`ops.services.pricing.policyHints.${policy ?? 'BEFORE_PROCESSING'}`)}>
          {(field) => <Select {...field} onValueChange={field.onChange} options={PAYMENT_POLICIES.map((p) => ({ value: p, label: t(`ops.services.pricing.policies.${p}`) }))} />}
        </FormField>
        {policy === 'DEPOSIT' ? (
          <FormField name="depositPercent" label={t('ops.services.pricing.depositPercent')} required>
            {(field) => <Input {...field} type="number" min={1} max={100} step="0.01" inputMode="decimal" dir="ltr" className="tabular" endAdornment={<span className="px-2 text-sm">%</span>} />}
          </FormField>
        ) : null}
      </div>
      <FormError />
      {editable ? (
        <FormActions>
          <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')} disabled={!form.formState.isDirty}>
            {t('common.saveChanges')}
          </Button>
        </FormActions>
      ) : null}
    </Form>
  );
}

/** What a customer is charged, as calculated by the price endpoint (never in the browser). */
function PricePreview({ serviceId, branchId, version }: { serviceId: string; branchId?: string; version: number }) {
  const { t, formatMoney, formatNumber } = useI18n();
  const api = useApi();
  const price = useQuery({
    queryKey: [...opsKeys.services.price(serviceId, branchId), version],
    queryFn: () => api.client.get<EffectivePrice>(`/services/${serviceId}/price`, { query: { branchId } }),
    retry: false,
  });
  return (
    <Loadable query={price} skeleton={<Skeleton className="h-52 w-full" />}>
      {(p) => (
        <div className="space-y-4">
          <dl className="divide-y rounded-md border">
            {p.components.map((c) => (
              <div key={c.component} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                <dt className="flex flex-wrap items-center gap-2">
                  {t(`ops.services.pricing.components.${c.component}`)}
                  {c.isEstimate ? <Badge tone="warning">{t('ops.services.pricing.estimate')}</Badge> : null}
                </dt>
                <dd className="tabular text-end">
                  {formatMoney(c.amount, p.currency)}
                  {Number(c.taxAmount) > 0 ? <span className="block text-sm text-muted-foreground">{t('ops.services.pricing.plusTax', { amount: formatMoney(c.taxAmount, p.currency) })}</span> : null}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
              <dt>{t('ops.services.pricing.tax', { rate: formatNumber(p.taxRatePercent, { maximumFractionDigits: 2 }) })}</dt>
              <dd className="tabular">{formatMoney(p.taxAmount, p.currency)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 bg-muted/40 px-4 py-3 font-semibold">
              <dt>{t(p.containsEstimates ? 'ops.services.pricing.totalEstimated' : 'ops.services.pricing.total')}</dt>
              <dd className="tabular text-lg">{formatMoney(p.total, p.currency)}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {t(`ops.services.pricing.due.${p.paymentPolicy}`, { amount: formatMoney(p.dueBeforeProcessing, p.currency), percent: formatNumber(p.depositPercent ?? 0, { maximumFractionDigits: 2 }) })}{' '}
            {t(p.source === 'BRANCH' ? 'ops.services.pricing.sourceBranch' : 'ops.services.pricing.sourceDefault')}
          </p>
        </div>
      )}
    </Loadable>
  );
}

function BranchPriceDialog({ open, onOpenChange, serviceId, branches, base }: { open: boolean; onOpenChange: (open: boolean) => void; serviceId: string; branches: Array<{ value: string; label: string }>; base: PriceRow | null }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const schema = React.useMemo(() => servicePriceSchema.extend({ branchId: z.string().uuid() }), []);
  // Starts on the first branch: the shared Select is not used with an empty value (see the report on Select).
  const empty = { branchId: branches[0]?.value ?? '', serviceFee: base ? Number(base.serviceFee).toFixed(2) : '', governmentFeeEstimate: base ? Number(base.governmentFeeEstimate).toFixed(2) : '0.00', thirdPartyFeeEstimate: base ? Number(base.thirdPartyFeeEstimate).toFixed(2) : '0.00' };
  const form = useZodForm(schema, { defaultValues: empty });
  React.useEffect(() => {
    if (open) form.reset(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (input) => {
            await api.client.post(`/services/${serviceId}/prices`, input);
            toasts.success(t('ops.services.pricing.branchSaved'), branches.find((b) => b.value === input.branchId)?.label);
            await queryClient.invalidateQueries({ queryKey: opsKeys.services.all });
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.services.pricing.branchAdd')}</DialogTitle>
            <DialogDescription>{t('ops.services.pricing.branchDialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="branchId" label={t('ops.services.pricing.branch')} required>
              {(field) => <Select {...field} onValueChange={field.onChange} options={branches} placeholder={t('common.selectPlaceholder')} />}
            </FormField>
            <FormField name="serviceFee" label={t('ops.services.pricing.serviceFee')} required>
              {(field) => <MoneyInput {...field} />}
            </FormField>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField name="governmentFeeEstimate" label={t('ops.services.pricing.governmentFee')}>
                {(field) => <MoneyInput {...field} />}
              </FormField>
              <FormField name="thirdPartyFeeEstimate" label={t('ops.services.pricing.thirdPartyFee')}>
                {(field) => <MoneyInput {...field} />}
              </FormField>
            </div>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.services.pricing.branchSave')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
