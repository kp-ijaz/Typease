'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormContext } from 'react-hook-form';
import { Ban, CheckCircle2, Pencil, Plus, TicketPercent, Trash2 } from 'lucide-react';
import { couponSchema, updateCouponSchema } from '@typease/validation';
import {
  Badge, Button, Checkbox, ChoiceLabel, DataTable, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection, Input,
  MoneyInput, PageHeader, PermissionGate, RadioGroup, RadioGroupItem, RequirePermission, Select, Switch, useI18n, useSession, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction,
  type Tone,
} from '@typease/ui';
import { CouponDiscount } from '@/components/billing';
import { ConfirmAction, matches, pageOf } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { Coupon, PlatformPlan } from '@/lib/types';

type CouponState = 'active' | 'inactive' | 'scheduled' | 'expired' | 'usedUp';
const STATE_TONE: Record<CouponState, Tone> = { active: 'success', inactive: 'neutral', scheduled: 'info', expired: 'neutral', usedUp: 'warning' };

/** Whether a coupon can be redeemed right now, and if not, why. */
function couponState(coupon: Coupon, now: number): CouponState {
  if (!coupon.isActive) return 'inactive';
  if (coupon.validUntil && new Date(coupon.validUntil).getTime() < now) return 'expired';
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) return 'usedUp';
  if (coupon.validFrom && new Date(coupon.validFrom).getTime() > now) return 'scheduled';
  return 'active';
}

export function Coupons() {
  return (
    <RequirePermission anyOf={['platform.plans.manage', 'platform.billing.manage']}>
      <CouponsScreen />
    </RequirePermission>
  );
}

/** Discount codes for TypEase subscriptions (GET /platform/coupons): list, create, change availability, deactivate. */
function CouponsScreen() {
  const { t, tn, formatDate, formatNumber } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const mayManage = session.hasPermission('platform.plans.manage');
  const plans = useQuery({ queryKey: keys.plans.admin, queryFn: ({ signal }) => api.plans.list(signal), staleTime: 60_000 });
  const [editing, setEditing] = React.useState<Coupon | 'new' | null>(null);
  const [confirm, setConfirm] = React.useState<{ kind: 'deactivate' | 'activate' | 'delete'; coupon: Coupon } | null>(null);
  // "Now" is read once per mount, in the browser: the list is never rendered on the server.
  const now = React.useMemo(() => Date.now(), []);
  const planName = React.useCallback((key: string) => (plans.data ?? []).find((p) => p.key === key)?.name ?? key, [plans.data]);

  const columns = React.useMemo<Array<DataTableColumn<Coupon>>>(
    () => [
      {
        id: 'code',
        header: t('coupons.columns.code'),
        sortField: 'code',
        mobile: 'title',
        className: 'min-w-48',
        cell: (c) => (
          <>
            <span className="ltr-value tabular block font-semibold">{c.code}</span>
            {c.description ? (
              <span className="block max-w-72 text-sm font-normal text-muted-foreground" dir="auto">
                {c.description}
              </span>
            ) : null}
          </>
        ),
      },
      {
        id: 'discount',
        header: t('coupons.columns.discount'),
        cell: (c) => (
          <>
            <span className="block font-medium">
              <CouponDiscount coupon={c} />
            </span>
            <span className="block text-sm text-muted-foreground">{c.durationMonths ? tn('coupons.forMonths', c.durationMonths) : t('coupons.forever')}</span>
          </>
        ),
      },
      { id: 'plans', header: t('coupons.columns.plans'), className: 'max-w-56', cell: (c) => (c.planKeys.length ? c.planKeys.map(planName).join(' · ') : t('coupons.allPlans')) },
      {
        id: 'validity',
        header: t('coupons.columns.validity'),
        className: 'whitespace-nowrap',
        cell: (c) =>
          c.validFrom || c.validUntil ? (
            <span className="tabular">
              {c.validFrom ? formatDate(c.validFrom) : t('coupons.fromStart')} – {c.validUntil ? formatDate(c.validUntil) : t('coupons.noEnd')}
            </span>
          ) : (
            t('coupons.alwaysValid')
          ),
      },
      {
        id: 'used',
        header: t('coupons.columns.used'),
        sortField: 'redeemedCount',
        cell: (c) => (
          <>
            <span className="tabular block">{c.maxRedemptions !== null ? t('coupons.usedOf', { used: formatNumber(c.redeemedCount), max: formatNumber(c.maxRedemptions) }) : formatNumber(c.redeemedCount)}</span>
            <span className="block text-sm text-muted-foreground">{tn('coupons.activeNow', c.activeSubscriptions)}</span>
          </>
        ),
      },
      {
        id: 'state',
        header: t('pc.status'),
        mobile: 'badge',
        cell: (c) => {
          const state = couponState(c, now);
          return <Badge tone={STATE_TONE[state]}>{t(`coupons.states.${state}`)}</Badge>;
        },
      },
    ],
    [t, tn, formatDate, formatNumber, planName, now],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'state', type: 'select', label: t('pc.status'), options: (['active', 'scheduled', 'usedUp', 'expired', 'inactive'] as const).map((s) => ({ value: s, label: t(`coupons.states.${s}`) })) }],
    [t],
  );

  const rowActions = React.useMemo<Array<RowAction<Coupon>>>(
    () =>
      mayManage
        ? [
            { id: 'edit', label: t('coupons.edit.action'), icon: <Pencil aria-hidden="true" />, onSelect: (c) => setEditing(c) },
            { id: 'deactivate', label: t('coupons.deactivate.action'), icon: <Ban aria-hidden="true" />, destructive: true, hidden: (c) => !c.isActive, onSelect: (c) => setConfirm({ kind: 'deactivate', coupon: c }) },
            { id: 'activate', label: t('coupons.activate.action'), icon: <CheckCircle2 aria-hidden="true" />, hidden: (c) => c.isActive, onSelect: (c) => setConfirm({ kind: 'activate', coupon: c }) },
            { id: 'delete', label: t('coupons.delete.action'), icon: <Trash2 aria-hidden="true" />, destructive: true, hidden: (c) => c.redeemedCount > 0, onSelect: (c) => setConfirm({ kind: 'delete', coupon: c }) },
          ]
        : [],
    [t, mayManage],
  );

  const create = (
    <PermissionGate permission="platform.plans.manage">
      <Button variant="accent" onClick={() => setEditing('new')}>
        <Plus aria-hidden="true" />
        {t('coupons.create.action')}
      </Button>
    </PermissionGate>
  );

  const refresh = () => Promise.all([keys.coupons.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  return (
    <>
      <PageHeader title={t('titles.coupons')} description={t('coupons.description')} breadcrumbs={[{ label: t('nav.plans'), href: '/plans' }]} action={create} />
      <DataTable<Coupon>
        caption={t('titles.coupons')}
        queryKey={keys.coupons.all}
        queryFn={async (params, signal) => {
          const rows = await api.coupons.list(signal);
          const visible = rows.filter((c) => matches(params.q as string | undefined, c.code, c.description) && (!params.state || couponState(c, now) === params.state));
          return pageOf(visible, params, { code: (c) => c.code, redeemedCount: (c) => c.redeemedCount, createdAt: (c) => c.createdAt });
        }}
        columns={columns}
        rowKey={(c) => c.id}
        rowActions={rowActions.length ? rowActions : undefined}
        filters={filters}
        searchPlaceholder={t('coupons.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <TicketPercent />, title: t('coupons.emptyTitle'), description: t('coupons.emptyText'), action: create }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('coupons.note')}</p>

      <CouponDialog target={editing} plans={plans.data ?? []} onClose={() => setEditing(null)} />
      <ConfirmAction
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone={confirm?.kind === 'activate' ? 'default' : 'destructive'}
        title={confirm ? t(`coupons.${confirm.kind}.title`, { code: confirm.coupon.code }) : ''}
        description={confirm ? (confirm.kind === 'deactivate' ? tn('coupons.deactivate.text', confirm.coupon.activeSubscriptions) : t(`coupons.${confirm.kind}.text`)) : ''}
        confirmLabel={confirm ? t(`coupons.${confirm.kind}.action`) : ''}
        onConfirm={async () => {
          const { kind, coupon } = confirm!;
          if (kind === 'delete') await api.coupons.remove(coupon.id);
          else await api.coupons.update(coupon.id, { isActive: kind === 'activate' });
          await refresh();
          toasts.success(t(`coupons.${kind}.done`, { code: coupon.code }));
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- create / edit

/** YYYY-MM-DD of an instant in a time zone (the day an operator means when they pick a date). */
const dayIn = (iso: string | null | undefined, timeZone: string) => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : '');
// Coupons are valid from the start of the first day to the end of the last day, UAE time (UTC+4, no daylight saving).
const startOfDay = (day: string) => (day ? `${day}T00:00:00+04:00` : '');
const endOfDay = (day: string) => (day ? `${day}T23:59:59+04:00` : '');

const numberProps = (field: { value: unknown; onChange: (value: unknown) => void }) => ({
  value: field.value === null || field.value === undefined ? '' : String(field.value),
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => field.onChange(e.target.value === '' ? '' : Number(e.target.value)),
});

function CouponDialog({ target, plans, onClose }: { target: Coupon | 'new' | null; plans: PlatformPlan[]; onClose: () => void }) {
  const coupon = target && target !== 'new' ? target : null;
  // Two forms with their own schema: creating fixes the discount, editing only changes availability.
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">{target === 'new' ? <CreateForm plans={plans} onClose={onClose} /> : coupon ? <EditForm coupon={coupon} plans={plans} onClose={onClose} /> : null}</DialogContent>
    </Dialog>
  );
}

function CreateForm({ plans, onClose }: { plans: PlatformPlan[]; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(couponSchema, { defaultValues: { code: '', description: '', percentOff: '' as unknown as number, amountOff: '', currency: 'AED', durationMonths: '' as unknown as number, maxRedemptions: '' as unknown as number, planKeys: [], validFrom: '', validUntil: '', isActive: true } });
  const [kind, setKind] = React.useState<'percent' | 'amount'>('percent');
  const id = React.useId();
  const currency = form.watch('currency') || 'AED';
  const currencies = React.useMemo(() => [...new Set(['AED', ...plans.map((plan) => plan.currency)])], [plans]);

  // The schema wants exactly one of the two discounts. The form shows one field at a time, so the
  // empty one is caught here, on the field the person sees, before the shared schema runs.
  const discountMissing = () => {
    const field = kind === 'percent' ? 'percentOff' : 'amountOff';
    const value = form.getValues(field);
    if (value !== '' && value !== null && value !== undefined) return false;
    form.setError(field, { type: 'required', message: 'Required' });
    form.setFocus(field);
    return true;
  };

  return (
    <Form
      form={form}
      className="flex min-h-0 flex-1 flex-col space-y-0"
      onSubmitCapture={(event) => {
        if (discountMissing()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onSubmit={async (values) => {
        const created = await api.coupons.create({ ...values, percentOff: kind === 'percent' ? values.percentOff : null, amountOff: kind === 'amount' ? values.amountOff : null });
        await Promise.all([keys.coupons.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        toasts.success(t('coupons.create.done', { code: created.code }));
        onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('coupons.create.title')}</DialogTitle>
        <DialogDescription>{t('coupons.create.text')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField name="code" label={t('coupons.columns.code')} required hint={t('coupons.form.codeHint')}>
            {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" autoFocus />}
          </FormField>
          <FormField name="description" label={t('coupons.form.description')} optional>
            {(field) => <Input {...field} autoComplete="off" dir="auto" maxLength={300} />}
          </FormField>
        </div>

        <FormSection title={t('coupons.form.discount')} description={t('coupons.form.discountText')}>
          <RadioGroup
            value={kind}
            onValueChange={(next) => {
              setKind(next as 'percent' | 'amount');
              form.setValue('percentOff', '' as unknown as number);
              form.setValue('amountOff', '');
              form.clearErrors(['percentOff', 'amountOff']);
            }}
            aria-label={t('coupons.form.discount')}
            className="flex flex-wrap gap-x-8 gap-y-2"
          >
            <ChoiceLabel htmlFor={`${id}-percent`} control={<RadioGroupItem id={`${id}-percent`} value="percent" />} label={t('coupons.form.percent')} />
            <ChoiceLabel htmlFor={`${id}-amount`} control={<RadioGroupItem id={`${id}-amount`} value="amount" />} label={t('coupons.form.amount')} />
          </RadioGroup>
          <div className="grid gap-5 sm:grid-cols-2">
            {kind === 'percent' ? (
              <FormField name="percentOff" label={t('coupons.form.percentOff')} required>
                {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="decimal" dir="ltr" min={0.01} max={100} step={0.01} className="tabular" endAdornment={<span aria-hidden="true">%</span>} />}
              </FormField>
            ) : (
              <FormField name="amountOff" label={t('coupons.form.amountOff')} required hint={t('coupons.form.amountOffHint')}>
                {(field) => <MoneyInput {...field} currency={currency} />}
              </FormField>
            )}
            <FormField name="durationMonths" label={t('coupons.form.duration')} optional hint={t('coupons.form.durationHint')}>
              {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="numeric" dir="ltr" min={1} max={60} step={1} className="tabular" />}
            </FormField>
            {kind === 'amount' && currencies.length > 1 ? (
              <FormField name="currency" label={t('dash.revenue.currency')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={currencies.map((c) => ({ value: c, label: c }))} />}
              </FormField>
            ) : null}
          </div>
        </FormSection>

        <AvailabilityFields plans={plans} />
        <FormError />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('coupons.create.submit')}
        </Button>
      </DialogFooter>
    </Form>
  );
}

function EditForm({ coupon, plans, onClose }: { coupon: Coupon; plans: PlatformPlan[]; onClose: () => void }) {
  const { t, tn, timeZone } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(updateCouponSchema, {
    emptyAs: 'null',
    defaultValues: {
      description: coupon.description ?? '',
      durationMonths: coupon.durationMonths ?? ('' as unknown as number),
      maxRedemptions: coupon.maxRedemptions ?? ('' as unknown as number),
      planKeys: coupon.planKeys,
      validFrom: startOfDay(dayIn(coupon.validFrom, timeZone)),
      validUntil: endOfDay(dayIn(coupon.validUntil, timeZone)),
      isActive: coupon.isActive,
    },
  });
  return (
    <Form
      form={form}
      className="flex min-h-0 flex-1 flex-col space-y-0"
      onSubmit={async (values) => {
        await api.coupons.update(coupon.id, values);
        await Promise.all([keys.coupons.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        toasts.success(t('coupons.edit.done', { code: coupon.code }));
        onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('coupons.edit.title', { code: coupon.code })}</DialogTitle>
        <DialogDescription>{t('coupons.edit.text')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-6">
        <p className="rounded-md bg-muted/60 px-3 py-2.5 text-base">
          <span className="font-medium text-foreground">
            <CouponDiscount coupon={coupon} />
          </span>{' '}
          <span className="text-muted-foreground">· {tn('coupons.redeemed', coupon.redeemedCount)}</span>
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField name="description" label={t('coupons.form.description')} optional>
            {(field) => <Input {...field} autoComplete="off" dir="auto" maxLength={300} />}
          </FormField>
          <FormField name="durationMonths" label={t('coupons.form.duration')} optional hint={t('coupons.form.durationEditHint')}>
            {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="numeric" dir="ltr" min={1} max={60} step={1} className="tabular" />}
          </FormField>
        </div>
        <AvailabilityFields plans={plans} />
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
  );
}

/** Who may use a coupon, how often and until when: the part of a coupon that can still change after it exists. */
function AvailabilityFields({ plans }: { plans: PlatformPlan[] }) {
  const { t, timeZone } = useI18n();
  const id = React.useId();
  const { watch } = useFormContext();
  // The two dates limit each other, so "ends before it starts" cannot be entered.
  const from = watch('validFrom') as string | undefined;
  const until = watch('validUntil') as string | undefined;
  return (
    <FormSection title={t('coupons.form.availability')}>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField name="validFrom" label={t('coupons.form.validFrom')} optional>
          {(field) => <DatePicker {...field} value={dayIn(field.value, timeZone)} max={dayIn(until, timeZone) || undefined} onChange={(day) => field.onChange(startOfDay(day))} />}
        </FormField>
        <FormField name="validUntil" label={t('coupons.form.validUntil')} optional hint={t('coupons.form.validUntilHint')}>
          {(field) => <DatePicker {...field} value={dayIn(field.value, timeZone)} min={dayIn(from, timeZone) || undefined} onChange={(day) => field.onChange(endOfDay(day))} />}
        </FormField>
        <FormField name="maxRedemptions" label={t('coupons.form.maxRedemptions')} optional hint={t('coupons.form.maxRedemptionsHint')}>
          {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="numeric" dir="ltr" min={1} step={1} className="tabular" />}
        </FormField>
        <FormField name="isActive" label={t('coupons.form.active')}>
          {(field) => (
            <div className="flex h-10 items-center gap-3">
              <Switch id={field.id} ref={field.ref} checked={!!field.value} onCheckedChange={field.onChange} />
              <span className="text-base text-muted-foreground">{field.value ? t('coupons.form.activeOn') : t('coupons.form.activeOff')}</span>
            </div>
          )}
        </FormField>
      </div>
      <FormField name="planKeys" label={t('coupons.form.plans')} hint={t('coupons.form.plansHint')}>
        {(field) => {
          const value: string[] = Array.isArray(field.value) ? field.value : [];
          return (
            <ul id={field.id} role="group" aria-label={t('coupons.form.plans')} className="flex flex-wrap gap-x-8 gap-y-2.5 rounded-lg border p-3">
              {[...plans]
                .filter((plan) => plan.isActive || value.includes(plan.key))
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((plan) => (
                  <li key={plan.key}>
                    <ChoiceLabel
                      htmlFor={`${id}-${plan.key}`}
                      control={<Checkbox id={`${id}-${plan.key}`} checked={value.includes(plan.key)} onCheckedChange={(checked) => field.onChange(checked === true ? [...value.filter((k) => k !== plan.key), plan.key] : value.filter((k) => k !== plan.key))} />}
                      label={plan.name}
                    />
                  </li>
                ))}
            </ul>
          );
        }}
      </FormField>
    </FormSection>
  );
}
