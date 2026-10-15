'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus, Pencil, Plus, Tags } from 'lucide-react';
import { PLAN_LIMIT_KEYS, type PlanLimitKey } from '@typease/types';
import { PLAN_FEATURES } from './features';
import type { PublicPlan } from '@typease/api-client';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, PermissionGate, Skeleton, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
  useApi, useErrorMessage, useI18n, useSession,
} from '@typease/ui';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformPlan } from '@/lib/types';
import { PlanDialog } from './plan-dialog';

/** A plan as the comparison shows it. `admin` is set for staff who manage plans: the full record with its counts. */
type ViewPlan = PublicPlan & { admin?: PlatformPlan };

interface Row {
  id: string;
  label: string;
  cell: (plan: ViewPlan) => React.ReactNode;
}

/**
 * Plans compared: a table from `md` up, one card per plan on phones, both built from the
 * same rows. Staff who manage plans see every plan (GET /platform/plans: also private and
 * no longer offered ones, with their subscriptions) and can add, edit and delete them;
 * everybody else sees the plans as centres do (GET /public/plans).
 */
export function Plans() {
  const { t, tn, formatMoney, formatNumber, formatFileSize } = useI18n();
  const api = useApi();
  const platform = usePlatformApi();
  const session = useSession();
  const describe = useErrorMessage();
  const mayManage = session.hasPermission('platform.plans.manage');
  const [editing, setEditing] = React.useState<PlatformPlan | 'new' | null>(null);
  const publicPlans = useQuery({ queryKey: keys.plans.all, queryFn: () => api.public.plans(), staleTime: 5 * 60_000, enabled: !mayManage });
  const adminPlans = useQuery({
    queryKey: keys.plans.admin,
    queryFn: async ({ signal }): Promise<ViewPlan[]> =>
      (await platform.plans.list(signal)).map((plan) => ({ ...plan, annualSaving: Math.max(0, Number(plan.monthlyPrice) * 12 - Number(plan.annualPrice)).toFixed(2), admin: plan })),
    staleTime: 60_000,
    enabled: mayManage,
  });
  const plans: { data?: ViewPlan[]; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown } = mayManage ? adminPlans : publicPlans;

  // -1 = unlimited, 0 = not part of the plan.
  const limit = (plan: PublicPlan, key: PlanLimitKey) => {
    const value = plan.limits[key];
    if (value < 0) return t('plans.unlimited');
    if (value === 0) return <span className="text-muted-foreground">{t('plans.notIncluded')}</span>;
    // "50 GB" is written left to right in Arabic too.
    return key === 'storageMb' ? <span className="tabular ltr-value">{formatFileSize(value * 1024 * 1024)}</span> : <span className="tabular">{formatNumber(value)}</span>;
  };
  const yesNo = (included: boolean) =>
    included ? (
      <span className="inline-flex items-center gap-1.5 text-success-text">
        <Check className="size-4" aria-hidden="true" />
        {t('plans.included')}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Minus className="size-4" aria-hidden="true" />
        {t('plans.notIncluded')}
      </span>
    );

  const groups: Array<{ id: string; label: string; rows: Row[] }> = [
    {
      id: 'price',
      label: t('plans.groups.price'),
      rows: [
        { id: 'monthly', label: t('plans.rows.monthly'), cell: (p) => <span className="tabular font-semibold text-foreground">{formatMoney(p.monthlyPrice, p.currency)}</span> },
        {
          id: 'annual',
          label: t('plans.rows.annual'),
          cell: (p) => (
            <>
              <span className="tabular font-semibold text-foreground">{formatMoney(p.annualPrice, p.currency)}</span>
              {Number(p.annualSaving) > 0 ? <span className="block text-sm text-muted-foreground">{t('plans.saving', { amount: formatMoney(p.annualSaving, p.currency) })}</span> : null}
            </>
          ),
        },
        { id: 'trial', label: t('plans.rows.trial'), cell: (p) => (p.trialDays > 0 ? tn('plans.trialDays', p.trialDays) : t('plans.noTrial')) },
        ...(mayManage ? [{ id: 'subscribers', label: t('planAdmin.row'), cell: (p: ViewPlan) => <span className="tabular">{tn('planAdmin.subscribers', p.admin?.subscriptionCount ?? 0)}</span> }] : []),
      ],
    },
    { id: 'limits', label: t('plans.groups.limits'), rows: PLAN_LIMIT_KEYS.map((key) => ({ id: key, label: t(`plans.limits.${key}`), cell: (p: ViewPlan) => limit(p, key) })) },
    { id: 'features', label: t('plans.groups.features'), rows: PLAN_FEATURES.map((key) => ({ id: key, label: t(`plans.features.${key}`), cell: (p: ViewPlan) => yesNo(p.features[key]) })) },
  ];

  const list = [...(plans.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  /** Marks of a plan centres cannot simply pick, and the way into its form: only for staff who manage plans. */
  const manage = (plan: ViewPlan) =>
    plan.admin ? (
      <span className="mt-2 flex flex-wrap items-center gap-2">
        {plan.admin.isActive ? null : <Badge tone="warning">{t('planAdmin.inactive')}</Badge>}
        {plan.admin.isPublic ? null : <Badge tone="neutral">{t('planAdmin.private')}</Badge>}
        <Button size="sm" variant="outline" aria-label={t('planAdmin.editFor', { name: plan.name })} onClick={() => setEditing(plan.admin as PlatformPlan)}>
          <Pencil aria-hidden="true" />
          {t('planAdmin.edit')}
        </Button>
      </span>
    ) : null;

  return (
    <>
      <PageHeader
        title={t('plans.title')}
        description={mayManage ? `${t('plans.description')} ${t('planAdmin.managerNote')}` : t('plans.description')}
        action={
          mayManage ? (
            <Button variant="accent" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              {t('planAdmin.add')}
            </Button>
          ) : undefined
        }
        secondary={
          <PermissionGate permission="platform.plans.manage">
            <Button asChild variant="outline">
              <Link href="/plans/coupons">{t('plans.coupons')}</Link>
            </Button>
          </PermissionGate>
        }
      />

      {plans.isPending ? (
        <Card role="status" aria-label={t('common.loading')} className="space-y-3 p-5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </Card>
      ) : plans.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void plans.refetch()}>{t('common.retry')}</Button>}>
          {t('plans.loadError')} {describe(plans.error)}
        </Alert>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState size="page" icon={<Tags />} title={t('plans.empty')} description={t('plans.emptyText')} />
        </Card>
      ) : (
        <>
          {/* md and up: plans side by side */}
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <TableCaption className="sr-only">{t('plans.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="w-[24%]">
                    {t('plans.feature')}
                  </TableHead>
                  {list.map((plan) => (
                    <TableHead key={plan.key} scope="col" className="align-top">
                      <span className="block text-md font-semibold text-foreground">{plan.name}</span>
                      {plan.description ? (
                        <span className="mt-0.5 block whitespace-normal text-sm font-normal text-muted-foreground">
                          {/* Plan texts are in one language: isolate them so punctuation stays put in the other direction. */}
                          <bdi>{plan.description}</bdi>
                        </span>
                      ) : null}
                      {manage(plan)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              {groups.map((group) => (
                <TableBody key={group.id}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead scope="colgroup" colSpan={list.length + 1} className="h-9 text-sm font-semibold text-foreground">
                      {group.label}
                    </TableHead>
                  </TableRow>
                  {group.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableHead scope="row" className="text-base font-medium text-foreground">
                        {row.label}
                      </TableHead>
                      {list.map((plan) => (
                        <TableCell key={plan.key}>{row.cell(plan)}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              ))}
            </Table>
          </Card>

          {/* phones: one card per plan */}
          <div className="space-y-4 md:hidden">
            {list.map((plan) => (
              <Card key={plan.key}>
                <CardHeader>
                  <div>
                    <CardTitle>{plan.name}</CardTitle>
                    {plan.description ? (
                      <p className="mt-1 text-base text-muted-foreground">
                        <bdi>{plan.description}</bdi>
                      </p>
                    ) : null}
                    {manage(plan)}
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  {groups.map((group) => (
                    <section key={group.id} aria-label={group.label}>
                      <h3 className="mb-1 text-sm font-semibold text-muted-foreground">{group.label}</h3>
                      <dl className="divide-y">
                        {group.rows.map((row) => (
                          <div key={row.id} className="flex items-baseline justify-between gap-4 py-2 text-base">
                            <dt>{row.label}</dt>
                            <dd className="text-end">{row.cell(plan)}</dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
      {mayManage ? <PlanDialog target={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
