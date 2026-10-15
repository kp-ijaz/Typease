'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Mail, MapPin, Pencil, Phone, Plus, Power, PowerOff } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, PermissionGate, RequirePermission, Skeleton, cn, formatPhone, useApi, useI18n, useSession, useToast,
} from '@typease/ui';
import { BranchDialog } from '@/components/adm/branch-dialog';
import { ActionError, LoadError, useEmirateName, useHoursSummary } from '@/components/adm/shared';
import type { BranchRow, TenantUsage } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

export function BranchesPage() {
  return (
    <RequirePermission anyOf={['branch.manage', 'branch.read']}>
      <Branches />
    </RequirePermission>
  );
}

function Branches() {
  const { t, pick, formatNumber } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const summary = useHoursSummary();
  const emirate = useEmirateName();
  const canManage = session.hasPermission('branch.manage');
  const branches = useQuery({ queryKey: admKeys.branches.admin, queryFn: () => api.client.get<BranchRow[]>('/branches', { query: { includeInactive: true } }) });
  // Plan usage is for the centre's own staff: a TypEase support session cannot read it, so it is not asked for.
  const usage = useQuery({ queryKey: admKeys.tenant.usage, queryFn: () => api.client.get<TenantUsage>('/tenant/usage'), staleTime: 60_000, enabled: !session.supportGrant });
  const [dialog, setDialog] = React.useState<{ branch: BranchRow | null } | null>(null);
  const [toggle, setToggle] = React.useState<BranchRow | null>(null);
  const [toggleError, setToggleError] = React.useState<unknown>(null);

  const limit = usage.data?.usage.find((u) => u.metric === 'branches');
  const list = branches.data ?? [];

  const add = (
    <PermissionGate permission="branch.manage">
      <Button variant="accent" onClick={() => setDialog({ branch: null })}>
        <Plus aria-hidden="true" />
        {t('adm.branches.add')}
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader title={t('adm.branches.title')} description={t('adm.branches.description')} action={add} />

      {limit && limit.limit !== null ? (
        <p className="mb-4 text-sm text-muted-foreground">
          {t('adm.branches.planUsage', { used: formatNumber(limit.used), limit: formatNumber(limit.limit) })}
        </p>
      ) : null}

      {branches.isPending ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : branches.isError ? (
        <LoadError error={branches.error} onRetry={() => void branches.refetch()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState size="page" icon={<MapPin />} title={t('adm.branches.emptyTitle')} description={t('adm.branches.emptyText')} action={add} />
        </Card>
      ) : (
        <ul className="space-y-4">
          {list.map((b) => (
            <li key={b.id}>
              <Card className={cn('p-5', !b.isActive && 'bg-muted/40')}>
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <h2 className="text-md font-semibold">{pick(b.name, b.nameAr)}</h2>
                      <Badge tone="outline" className="tabular">
                        {b.code}
                      </Badge>
                      {b.isHeadOffice ? <Badge tone="brand">{t('adm.branches.headOffice')}</Badge> : null}
                      <Badge tone={b.isActive ? 'success' : 'neutral'}>{b.isActive ? t('adm.branches.active') : t('adm.branches.inactive')}</Badge>
                    </div>
                    {b.nameAr && b.name !== pick(b.name, b.nameAr) ? <p className="mt-0.5 text-sm text-muted-foreground">{b.name}</p> : null}
                    {b.nameAr && b.nameAr !== pick(b.name, b.nameAr) ? (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        <bdi lang="ar">{b.nameAr}</bdi>
                      </p>
                    ) : null}
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="subtle" size="sm" onClick={() => setDialog({ branch: b })}>
                        <Pencil aria-hidden="true" />
                        {t('common.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setToggleError(null);
                          setToggle(b);
                        }}
                      >
                        {b.isActive ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
                        {b.isActive ? t('adm.branches.deactivate') : t('adm.branches.reactivate')}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <dl className="mt-4 grid gap-x-8 gap-y-3 text-base sm:grid-cols-2 xl:grid-cols-3">
                  <div className="flex gap-2.5">
                    <MapPin className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <dt className="sr-only">{t('adm.branches.fields.address')}</dt>
                      <dd dir="auto">{[b.address, emirate(b.emirate)].filter(Boolean).join(' · ') || <span className="text-muted-foreground">{t('adm.branches.noAddress')}</span>}</dd>
                    </div>
                  </div>
                  <div className="flex gap-2.5">
                    <Clock className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0">
                      <dt className="sr-only">{t('adm.branches.hours')}</dt>
                      <dd className="tabular">{summary(b.workingHours) || <span className="text-muted-foreground">{t('adm.branches.noHours')}</span>}</dd>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <dt className="sr-only">{t('adm.branches.contact')}</dt>
                    {b.phone ? (
                      <dd className="flex items-center gap-2.5">
                        <Phone className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="ltr-value tabular">{formatPhone(b.phone)}</span>
                      </dd>
                    ) : null}
                    {b.email ? (
                      <dd className="flex items-center gap-2.5">
                        <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="ltr-value truncate">{b.email}</span>
                      </dd>
                    ) : null}
                    {!b.phone && !b.email ? <dd className="text-muted-foreground">{t('adm.branches.noContact')}</dd> : null}
                  </div>
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <BranchDialog open={!!dialog} onOpenChange={(open) => !open && setDialog(null)} branch={dialog?.branch ?? null} first={list.length === 0} />
      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(open) => !open && setToggle(null)}
        tone={toggle?.isActive ? 'destructive' : 'default'}
        title={toggle?.isActive ? t('adm.branches.deactivateTitle', { name: toggle?.name ?? '' }) : t('adm.branches.reactivateTitle', { name: toggle?.name ?? '' })}
        description={toggle?.isActive ? t('adm.branches.deactivateText') : t('adm.branches.reactivateText')}
        confirmLabel={toggle?.isActive ? t('adm.branches.deactivate') : t('adm.branches.reactivate')}
        onConfirm={async () => {
          if (!toggle) return;
          setToggleError(null);
          try {
            await api.client.patch(`/branches/${toggle.id}`, { isActive: !toggle.isActive });
            toasts.success(toggle.isActive ? t('adm.branches.deactivated') : t('adm.branches.reactivated'), toggle.name);
            await queryClient.invalidateQueries({ queryKey: admKeys.branches.all });
            await queryClient.invalidateQueries({ queryKey: admKeys.tenant.usage });
          } catch (error) {
            setToggleError(error);
            throw error;
          }
        }}
      >
        {toggleError ? <ActionError error={toggleError} /> : null}
      </ConfirmDialog>
    </>
  );
}
