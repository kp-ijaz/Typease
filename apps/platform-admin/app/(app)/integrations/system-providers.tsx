'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleOff, FlaskConical, ScrollText, XCircle } from 'lucide-react';
import { Alert, Badge, Card, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, cn, useI18n, type Tone } from '@typease/ui';
import { Code, LoadError, RowsSkeleton } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { SystemProvider, SystemProviderStatus } from '@/lib/types';

const TONE: Record<SystemProviderStatus, Tone> = { CONFIGURED: 'success', NOT_CONFIGURED: 'danger', LOG_ONLY: 'warning', DISABLED: 'neutral', SANDBOX: 'info' };
const ICON: Record<SystemProviderStatus, React.ReactNode> = {
  CONFIGURED: <CheckCircle2 />,
  NOT_CONFIGURED: <XCircle />,
  LOG_ONLY: <ScrollText />,
  DISABLED: <CircleOff />,
  SANDBOX: <FlaskConical />,
};

/**
 * What the installation itself is configured to use (GET /platform/system/providers): the
 * driver of each dependency and whether it has what it needs. Only storage and Redis are
 * really contacted; for everything else "configured" means the variables are set, nothing
 * more, and a `log` driver is shown as not delivering.
 */
export function SystemProvidersPanel() {
  const { t, tn, has, formatTime } = useI18n();
  const api = usePlatformApi();
  const query = useQuery({ queryKey: keys.health.providers, queryFn: ({ signal }) => api.system.providers(signal), staleTime: 15_000, refetchInterval: 60_000, refetchIntervalInBackground: false });

  if (query.isPending) return <Card><RowsSkeleton rows={8} /></Card>;
  if (query.isError) return <LoadError lead={t('integ.system.loadError')} error={query.error} onRetry={() => void query.refetch()} />;

  const { providers, environment, generatedAt } = query.data;
  const configured = providers.filter((p) => p.status === 'CONFIGURED' && p.reachable !== false).length;
  const attention = providers.filter((p) => p.status === 'NOT_CONFIGURED' || p.status === 'LOG_ONLY' || p.reachable === false).length;
  const label = (p: SystemProvider) => (has(`integ.system.labels.${p.key}`) ? t(`integ.system.labels.${p.key}`) : p.label);
  const statusLine = (p: SystemProvider) => {
    if (p.reachable === undefined) return null;
    const time = p.lastCheckedAt ? formatTime(p.lastCheckedAt) : '';
    return (
      <span className={cn('mt-1 block text-xs', p.reachable ? 'text-success-text' : 'text-destructive-text')}>
        {p.reachable ? t('integ.system.reachable', { time }) : t('integ.system.unreachable', { time })}
        {p.lastError ? <span className="ltr-value block text-destructive-text">{t('integ.system.lastError', { error: p.lastError })}</span> : null}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <Alert tone={attention > 0 ? 'warning' : 'info'} title={t('integ.system.title')}>
        {t('integ.system.text')}
        <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Badge tone={environment === 'production' ? 'success' : 'neutral'}>{t('integ.system.environment', { name: has(`integ.system.environments.${environment}`) ? t(`integ.system.environments.${environment}`) : environment })}</Badge>
          <span className="tabular">{tn('integ.system.summary.configured', configured)}</span>
          <span className={cn('tabular', attention > 0 && 'font-medium text-warning-text')}>{tn('integ.system.summary.attention', attention)}</span>
          <span className="tabular text-muted-foreground">{t('integ.system.generatedAt', { time: formatTime(generatedAt) })}</span>
        </span>
      </Alert>

      <Card className="overflow-hidden">
        <Table>
          <TableCaption className="sr-only">{t('integ.tabs.system')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('integ.system.columns.provider')}</TableHead>
              <TableHead>{t('integ.system.columns.status')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('integ.system.columns.detail')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((p) => (
              <TableRow key={p.key}>
                <TableCell className="min-w-44 align-top">
                  <span className="block font-medium text-foreground">{label(p)}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                    {t('integ.system.columns.driver')} <Code>{p.driver}</Code>
                  </span>
                  {/* On a phone the detail moves under the name. */}
                  <span className="mt-2 block text-sm text-muted-foreground md:hidden" dir="ltr">
                    {p.detail}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap align-top">
                  <Badge tone={TONE[p.status]} icon={ICON[p.status]}>
                    {t(`integ.system.status.${p.status}`)}
                  </Badge>
                  {statusLine(p)}
                </TableCell>
                <TableCell className="hidden max-w-2xl align-top text-sm text-muted-foreground md:table-cell" dir="ltr">
                  {p.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t('integ.system.detailNote')}
      </p>
    </div>
  );
}
