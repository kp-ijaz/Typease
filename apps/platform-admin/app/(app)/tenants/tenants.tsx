'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Building2, ExternalLink, KeyRound, PauseCircle, PlayCircle, Plus, ThumbsDown, ThumbsUp } from 'lucide-react';
import { platformCreateTenantSchema } from '@typease/validation';
import {
  Button, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection, Input, PageHeader, PermissionGate, PhoneInput,
  RequirePermission, STATUS_META, Select, StatusBadge, useApi, useI18n, useSession, useToast, useZodForm, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { RequestAccessDialog } from '@/components/request-access-dialog';
import { availableTenantActions, suspensionOf, useTenantActions, useTenantRights, type TenantActionId } from '@/components/tenant-actions';
import { usePlatformApi } from '@/lib/api';
import { EMIRATES, emirateKey } from '@/lib/emirates';
import { keys } from '@/lib/query-keys';
import type { TenantRow, TenantStatus } from '@/lib/types';

const STATUSES: TenantStatus[] = ['ACTIVE', 'TRIAL', 'ONBOARDING', 'PENDING_APPROVAL', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'ARCHIVED'];

export function Tenants() {
  return (
    <RequirePermission anyOf={['platform.tenants.read']}>
      <TenantsList />
    </RequirePermission>
  );
}

/**
 * Every centre on the platform (GET /platform/tenants): centre-level facts only.
 * Search, status / plan filters, lifecycle actions and "Add centre".
 */
function TenantsList() {
  const { t, pick, has, formatDate } = useI18n();
  const api = usePlatformApi();
  const publicApi = useApi();
  const session = useSession();
  const rights = useTenantRights();
  const actions = useTenantActions();
  const mayRequest = session.hasPermission('platform.access.request');
  const plans = useQuery({ queryKey: keys.plans.all, queryFn: () => publicApi.public.plans(), staleTime: 5 * 60_000 });
  const [requestFor, setRequestFor] = React.useState<TenantRow | null>(null);

  // /tenants?add=1 (the dashboard's action) opens the dialog.
  const addRequested = useSearchParams().get('add') === '1';
  const [adding, setAdding] = React.useState(false);
  React.useEffect(() => {
    if (!addRequested || !rights.manage) return;
    setAdding(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('add');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }, [addRequested, rights.manage]);

  const emirate = React.useCallback((name: string | null) => (name ? (has(emirateKey(name)) ? t(emirateKey(name)) : name) : null), [t, has]);

  const columns = React.useMemo<Array<DataTableColumn<TenantRow>>>(
    () => [
      {
        id: 'name',
        header: t('tenants.columns.centre'),
        sortField: 'name',
        mobile: 'title',
        className: 'min-w-56',
        cell: (row) => (
          <>
            <bdi className="block">{row.name}</bdi>
            <span className="ltr-value block text-sm font-normal text-muted-foreground">{row.slug}</span>
          </>
        ),
      },
      {
        id: 'status',
        header: t('pc.status'),
        sortField: 'status',
        mobile: 'badge',
        cell: (row) => {
          const suspension = suspensionOf(row);
          return (
            <>
              <StatusBadge kind="tenant" status={row.status} />
              {suspension ? <span className="mt-1 block max-w-56 truncate text-xs text-muted-foreground">{t(`tenants.suspension.${suspension.kind}Short`)}</span> : null}
              {row.offboardingAt ? <span className="mt-1 block text-xs font-medium text-destructive-text">{t('tenants.deletionOn', { date: formatDate(row.offboardingAt) })}</span> : null}
            </>
          );
        },
      },
      {
        id: 'plan',
        header: t('tenants.columns.plan'),
        cell: (row) =>
          row.plan ? (
            <>
              <span className="block">{row.plan.name}</span>
              {row.subscription ? <span className="block text-sm text-muted-foreground">{t(`pc.cycle.${row.subscription.billingCycle}`)}</span> : null}
            </>
          ) : (
            <span className="text-muted-foreground">{t('tenants.noPlan')}</span>
          ),
      },
      {
        id: 'subscription',
        header: t('tenants.columns.subscription'),
        className: 'whitespace-nowrap',
        cell: (row) =>
          row.subscription ? (
            <>
              <StatusBadge kind="subscription" status={row.subscription.status} />
              <span className="tabular mt-1 block text-sm text-muted-foreground">
                {row.subscription.status === 'TRIALING' && row.subscription.trialEndsAt
                  ? t('tenants.trialEnds', { date: formatDate(row.subscription.trialEndsAt) })
                  : row.subscription.currentPeriodEnd
                    ? t('tenants.periodEnds', { date: formatDate(row.subscription.currentPeriodEnd) })
                    : null}
              </span>
            </>
          ) : null,
      },
      { id: 'emirate', header: t('tenants.columns.emirate'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (row) => emirate(row.emirate) },
      {
        id: 'contact',
        header: t('tenants.columns.contact'),
        cell: (row) => (row.contactEmail ? <span className="ltr-value block max-w-56 truncate">{row.contactEmail}</span> : null),
      },
      { id: 'created', header: t('tenants.columns.signedUp'), sortField: 'createdAt', className: 'whitespace-nowrap tabular', cell: (row) => formatDate(row.createdAt) },
    ],
    [t, formatDate, emirate],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      { id: 'status', type: 'select', label: t('pc.status'), options: STATUSES.map((s) => ({ value: s, label: pick(STATUS_META.tenant[s].en, STATUS_META.tenant[s].ar) })) },
      {
        id: 'plan',
        type: 'select',
        label: t('tenants.columns.plan'),
        options: [...[...(plans.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ value: p.key, label: p.name })), { value: 'none', label: t('tenants.filters.noPlan') }],
      },
      { id: 'offboarding', type: 'select', label: t('tenants.filters.deletion'), options: [{ value: 'true', label: t('tenants.filters.deletionScheduled') }] },
      { id: 'created', type: 'dateRange', label: t('tenants.columns.signedUp'), fromKey: 'createdFrom', toKey: 'createdTo' },
    ],
    [t, pick, plans.data],
  );

  const can = React.useCallback((row: TenantRow, action: TenantActionId) => availableTenantActions(row, rights).includes(action), [rights]);
  const rowActions = React.useMemo<Array<RowAction<TenantRow>>>(
    () => [
      { id: 'open', label: t('tenants.actions.open'), icon: <ExternalLink aria-hidden="true" />, href: (row) => `/tenants/${row.id}` },
      { id: 'access', label: t('access.request.action'), icon: <KeyRound aria-hidden="true" />, hidden: (row) => !mayRequest || row.status === 'ARCHIVED', onSelect: (row) => setRequestFor(row) },
      { id: 'approve', label: t('tenants.actions.approve.label'), icon: <ThumbsUp aria-hidden="true" />, hidden: (row) => !can(row, 'approve'), onSelect: (row) => actions.ask('approve', row) },
      { id: 'reject', label: t('tenants.actions.reject.label'), icon: <ThumbsDown aria-hidden="true" />, destructive: true, hidden: (row) => !can(row, 'reject'), onSelect: (row) => actions.ask('reject', row) },
      { id: 'reactivate', label: t('tenants.actions.reactivate.label'), icon: <PlayCircle aria-hidden="true" />, hidden: (row) => !can(row, 'reactivate'), onSelect: (row) => actions.ask('reactivate', row) },
      { id: 'suspend', label: t('tenants.actions.suspend.label'), icon: <PauseCircle aria-hidden="true" />, destructive: true, hidden: (row) => !can(row, 'suspend'), onSelect: (row) => actions.ask('suspend', row) },
      { id: 'archive', label: t('tenants.actions.archive.label'), icon: <Archive aria-hidden="true" />, destructive: true, hidden: (row) => !can(row, 'archive'), onSelect: (row) => actions.ask('archive', row) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, can, mayRequest],
  );

  const add = (
    <PermissionGate permission="platform.tenants.manage">
      <Button variant="accent" onClick={() => setAdding(true)}>
        <Plus aria-hidden="true" />
        {t('tenants.add.action')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('nav.tenants')} description={t('tenants.description')} action={add} />
      <DataTable<TenantRow>
        caption={t('nav.tenants')}
        queryKey={keys.tenants.all}
        queryFn={(params, signal) => api.tenants.list(params, signal)}
        columns={columns}
        rowKey={(row) => row.id}
        rowHref={(row) => `/tenants/${row.id}`}
        rowActions={rowActions}
        filters={filters}
        searchPlaceholder={t('tenants.searchPlaceholder')}
        defaultSort="createdAt:desc"
        empty={{ icon: <Building2 />, title: t('tenants.emptyTitle'), description: t('tenants.emptyText'), action: add }}
      />
      <p className="mt-3 text-sm text-muted-foreground">{t('tenants.privacyNote')}</p>

      <AddTenantDialog open={adding} onOpenChange={setAdding} />
      <RequestAccessDialog open={!!requestFor} onOpenChange={(open) => !open && setRequestFor(null)} centre={requestFor} />
      {actions.dialogs}
    </>
  );
}

// ---------------------------------------------------------------- add a centre

const EMPTY = { businessName: '', slug: '', legalName: '', emirate: '', ownerName: '', ownerEmail: '', ownerPhone: '', preferredLanguage: 'en', planKey: '', billingCycle: 'MONTHLY', couponCode: '' } as const;
const NO_PLAN = '__none__';
const NO_EMIRATE = '__none__';

/** "alpha typing llc" -> "alpha-typing-llc": a starting point for the address part, which the person can change. */
const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

/**
 * Sets a centre up on behalf of a customer (POST /platform/tenants). The owner gets the
 * normal invitation email and chooses their own password; staff never set or see one.
 */
function AddTenantDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, formatMoney } = useI18n();
  const api = usePlatformApi();
  const publicApi = useApi();
  const toasts = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useZodForm(platformCreateTenantSchema, { defaultValues: { ...EMPTY } });
  const plans = useQuery({ queryKey: keys.plans.all, queryFn: () => publicApi.public.plans(), staleTime: 5 * 60_000, enabled: open });
  const slugTouched = React.useRef(false);
  const planKey = form.watch('planKey');
  const cycle = form.watch('billingCycle');
  const plan = (plans.data ?? []).find((p) => p.key === planKey);

  React.useEffect(() => {
    if (open) {
      form.reset({ ...EMPTY });
      slugTouched.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const created = await api.tenants.create({ ...values, couponCode: values.planKey ? values.couponCode : undefined });
            await Promise.all([keys.tenants.all, keys.dashboard.all, keys.billing.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t('tenants.add.done', { name: created.name }), t('tenants.add.doneText', { email: created.invitation?.email ?? values.ownerEmail }));
            if (created.plan?.outcome === 'FAILED') toasts.warning(t('tenants.add.planFailed'), created.plan.message);
            onOpenChange(false);
            router.push(`/tenants/${created.id}`);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('tenants.add.title')}</DialogTitle>
            <DialogDescription>{t('tenants.add.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            <FormSection title={t('tenants.add.business')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="businessName" label={t('tenants.add.businessName')} required>
                  {(field) => (
                    <Input
                      {...field}
                      autoComplete="off"
                      autoFocus
                      dir="auto"
                      onChange={(e) => {
                        field.onChange(e);
                        if (!slugTouched.current) form.setValue('slug', slugify(e.target.value), { shouldValidate: form.formState.isSubmitted });
                      }}
                    />
                  )}
                </FormField>
                <FormField name="slug" label={t('tenants.add.slug')} required hint={t('tenants.add.slugHint')}>
                  {(field) => (
                    <Input
                      {...field}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      dir="ltr"
                      className="tabular"
                      onChange={(e) => {
                        slugTouched.current = true;
                        field.onChange(e);
                      }}
                    />
                  )}
                </FormField>
                <FormField name="legalName" label={t('tenants.add.legalName')} optional>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="emirate" label={t('tenants.columns.emirate')} optional>
                  {(field) => (
                    <Select
                      {...field}
                      value={field.value || NO_EMIRATE}
                      onValueChange={(v) => field.onChange(v === NO_EMIRATE ? '' : v)}
                      options={[{ value: NO_EMIRATE, label: t('common.notSet') }, ...EMIRATES.map((e) => ({ value: e, label: t(emirateKey(e)) }))]}
                    />
                  )}
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('tenants.add.owner')} description={t('tenants.add.ownerText')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="ownerName" label={t('tenants.add.ownerName')} required>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="ownerEmail" label={t('tenants.add.ownerEmail')} required>
                  {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
                </FormField>
                <FormField name="ownerPhone" label={t('tenants.add.ownerPhone')} optional>
                  {(field) => <PhoneInput {...field} />}
                </FormField>
                <FormField name="preferredLanguage" label={t('tenants.add.language')}>
                  {(field) => (
                    <Select
                      {...field}
                      onValueChange={field.onChange}
                      options={[
                        { value: 'en', label: t('common.english') },
                        { value: 'ar', label: t('common.arabic') },
                      ]}
                    />
                  )}
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('tenants.add.plan')} description={t('tenants.add.planText')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="planKey" label={t('tenants.columns.plan')}>
                  {(field) => (
                    <Select
                      {...field}
                      value={field.value || NO_PLAN}
                      onValueChange={(v) => field.onChange(v === NO_PLAN ? '' : v)}
                      options={[{ value: NO_PLAN, label: t('tenants.add.planLater') }, ...[...(plans.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ value: p.key, label: p.name }))]}
                    />
                  )}
                </FormField>
                {planKey ? (
                  <>
                    <FormField name="billingCycle" label={t('tenants.add.cycle')}>
                      {(field) => (
                        <Select
                          {...field}
                          onValueChange={field.onChange}
                          options={[
                            { value: 'MONTHLY', label: t('pc.cycle.MONTHLY') },
                            { value: 'ANNUAL', label: t('pc.cycle.ANNUAL') },
                          ]}
                        />
                      )}
                    </FormField>
                    <FormField name="couponCode" label={t('tenants.add.coupon')} optional>
                      {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" />}
                    </FormField>
                  </>
                ) : null}
              </div>
              {plan ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {t('tenants.add.planSummary', { plan: plan.name, price: formatMoney(cycle === 'ANNUAL' ? plan.annualPrice : plan.monthlyPrice, plan.currency), cycle: t(`pc.cycle.${cycle ?? 'MONTHLY'}`) })}{' '}
                  {plan.trialDays > 0 ? tn('tenants.add.planTrial', plan.trialDays) : t('tenants.add.planNoTrial')}
                </p>
              ) : null}
            </FormSection>

            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('tenants.add.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
