'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag } from 'lucide-react';
import { Badge, Button, EmptyState, Select, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, useI18n, useToast } from '@typease/ui';
import { Code, ConfirmAction, LoadError, RowsSkeleton, Section } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { TenantFlag } from '@/lib/types';

type Choice = 'default' | 'on' | 'off';
const choiceOf = (flag: TenantFlag): Choice => (flag.source === 'TENANT' ? (flag.enabled ? 'on' : 'off') : 'default');

/**
 * Feature flags as they apply to one centre (GET /platform/tenants/:id/feature-flags).
 * The centre's own setting wins over the platform default; without either the feature is off.
 */
export function TenantFlags({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const flags = useQuery({ queryKey: keys.tenants.flags(tenantId), queryFn: ({ signal }) => api.tenants.flags(tenantId, signal) });
  const [change, setChange] = React.useState<{ flag: TenantFlag; to: Choice } | null>(null);

  const apply = async () => {
    if (!change) return;
    if (change.to === 'default') await api.tenants.clearFlag(tenantId, change.flag.key);
    else await api.tenants.setFlag(tenantId, change.flag.key, { enabled: change.to === 'on' });
    await Promise.all([keys.tenants.flags(tenantId), keys.flags.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    toasts.success(t('flags.tenant.saved', { flag: change.flag.key }));
  };

  const defaultLabel = (flag: TenantFlag) => t(flag.globalDefault ? 'flags.tenant.followOn' : 'flags.tenant.followOff');

  return (
    <Section
      flush
      title={t('flags.tenant.title')}
      description={t('flags.tenant.text')}
      action={
        <Button asChild variant="link">
          <Link href="/feature-flags">{t('flags.tenant.allFlags')}</Link>
        </Button>
      }
    >
      {flags.isPending ? (
        <RowsSkeleton />
      ) : flags.isError ? (
        <LoadError className="m-4" error={flags.error} onRetry={() => void flags.refetch()} />
      ) : flags.data.length === 0 ? (
        <EmptyState icon={<Flag />} title={t('flags.emptyTitle')} description={t('flags.tenant.emptyText')} />
      ) : (
        <Table>
          <TableCaption className="sr-only">{t('flags.tenant.title')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('flags.columns.flag')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('flags.tenant.applies')}</TableHead>
              <TableHead className="sm:w-72">{t('flags.tenant.setting')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flags.data.map((flag) => {
              const description = typeof flag.payload?.description === 'string' ? flag.payload.description : null;
              return (
                <TableRow key={flag.key}>
                  <TableCell className="sm:min-w-56">
                    <Code className="break-all">{flag.key}</Code>
                    {description ? (
                      <span className="mt-1 block text-sm text-muted-foreground" dir="auto">
                        {description}
                      </span>
                    ) : null}
                    {/* On a phone what applies now moves under the key, so that the setting stays on the screen. */}
                    <span className="mt-2 flex flex-wrap items-center gap-2 sm:hidden">
                      <Badge tone={flag.enabled ? 'success' : 'neutral'} dot>
                        {flag.enabled ? t('pc.on') : t('pc.off')}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{t(`flags.tenant.source.${flag.source}`)}</span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge tone={flag.enabled ? 'success' : 'neutral'} dot>
                      {flag.enabled ? t('pc.on') : t('pc.off')}
                    </Badge>
                    <span className="mt-1 block text-sm text-muted-foreground">{t(`flags.tenant.source.${flag.source}`)}</span>
                  </TableCell>
                  <TableCell className="min-w-44">
                    <Select
                      aria-label={t('flags.tenant.settingFor', { flag: flag.key })}
                      value={choiceOf(flag)}
                      onValueChange={(to) => (to !== choiceOf(flag) ? setChange({ flag, to: to as Choice }) : undefined)}
                      options={[
                        { value: 'default', label: defaultLabel(flag) },
                        { value: 'on', label: t('flags.tenant.alwaysOn') },
                        { value: 'off', label: t('flags.tenant.alwaysOff') },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmAction
        open={!!change}
        onOpenChange={(open) => !open && setChange(null)}
        tone="default"
        title={t('flags.tenant.confirmTitle', { flag: change?.flag.key ?? '' })}
        description={change ? t(`flags.tenant.confirm.${change.to}`, { name: tenantName }) : ''}
        confirmLabel={t('common.saveChanges')}
        onConfirm={apply}
      />
    </Section>
  );
}
