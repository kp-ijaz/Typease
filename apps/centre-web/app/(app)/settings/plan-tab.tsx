'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, Check, Minus } from 'lucide-react';
import type { PublicPlan } from '@typease/api-client';
import { Button, Card, CardContent, CardFooter, CardHeader, CardTitle, PermissionGate, Skeleton, StatusBadge, cn, useApi, useI18n } from '@typease/ui';
import { LoadError } from '@/components/adm/shared';
import type { TenantUsage } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

const FEATURES = ['whiteLabel', 'customDomains', 'corporatePortal', 'automation', 'aiAssistant', 'scheduledReports', 'apiAccess'] as const;

/** What the plan includes and how much of it is used (GET /tenant/usage). Changing the plan happens under /subscription. */
export function PlanTab() {
  const { t, has, formatNumber } = useI18n();
  const api = useApi();
  const usage = useQuery({ queryKey: admKeys.tenant.usage, queryFn: () => api.client.get<TenantUsage>('/tenant/usage') });
  const plans = useQuery({ queryKey: admKeys.plans, queryFn: () => api.public.plans(), staleTime: 10 * 60_000 });

  if (usage.isPending) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    );
  }
  if (usage.isError) return <LoadError error={usage.error} onRetry={() => void usage.refetch()} />;

  const plan = usage.data.plan;
  const planName = (plans.data as PublicPlan[] | undefined)?.find((p) => p.key === plan?.key)?.name ?? plan?.key ?? '';
  const manage = (
    <PermissionGate permission="subscription.manage">
      <Button asChild>
        <Link href="/subscription">
          <ArrowUpCircle aria-hidden="true" />
          {t('adm.settings.plan.manage')}
        </Link>
      </Button>
    </PermissionGate>
  );

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>{t('adm.settings.plan.usageTitle')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{t('adm.settings.plan.usageText')}</p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-5">
            {usage.data.usage.map((u) => {
              const unlimited = u.limit === null || u.limit === undefined || u.limit < 0;
              const none = u.limit === 0;
              const ratio = unlimited || none ? 0 : Math.min(1, u.used / (u.limit as number));
              const label = has(`adm.settings.plan.metrics.${u.metric}`) ? t(`adm.settings.plan.metrics.${u.metric}`) : u.metric;
              return (
                <li key={u.metric}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="text-base font-medium">{label}</span>
                    <span className="tabular text-sm text-muted-foreground">
                      {none ? t('adm.settings.plan.notIncluded') : unlimited ? t('adm.settings.plan.unlimited', { used: formatNumber(u.used) }) : t('adm.settings.plan.usedOf', { used: formatNumber(u.used), limit: formatNumber(u.limit) })}
                    </span>
                  </div>
                  {none || unlimited ? null : (
                    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={u.limit as number} aria-valuenow={u.used} className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-destructive' : ratio >= 0.8 ? 'bg-warning' : 'bg-secondary')} style={{ width: `${Math.max(ratio * 100, u.used > 0 ? 2 : 0)}%` }} />
                    </div>
                  )}
                  {!none && !unlimited && ratio >= 1 ? <p className="mt-1 text-sm text-destructive-text">{t('adm.settings.plan.limitReached')}</p> : null}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="items-center">
          <CardTitle>{t('adm.settings.plan.planTitle')}</CardTitle>
          {plan ? <StatusBadge kind="subscription" status={plan.status} /> : null}
        </CardHeader>
        <CardContent>
          {plan ? (
            <>
              <p className="text-2xl font-semibold capitalize">{planName}</p>
              <ul className="mt-4 space-y-2">
                {FEATURES.map((f) => {
                  const on = plan.features[f] === true;
                  return (
                    <li key={f} className={cn('flex items-start gap-2 text-base', !on && 'text-muted-foreground')}>
                      {on ? <Check className="mt-1 size-4 shrink-0 text-success-text" aria-hidden="true" /> : <Minus className="mt-1 size-4 shrink-0" aria-hidden="true" />}
                      <span>
                        {t(`adm.settings.plan.features.${f}`)}
                        <span className="sr-only">: {on ? t('adm.settings.plan.included') : t('adm.settings.plan.notIncluded')}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="text-base text-muted-foreground">{t('adm.settings.plan.noPlan')}</p>
          )}
        </CardContent>
        <CardFooter>{manage}</CardFooter>
      </Card>
    </div>
  );
}
