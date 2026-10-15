'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BellRing, Building2, CalendarClock, CalendarDays, ChartColumn, ChartLine, ChartPie, ChevronRight, Clock, HandCoins, Landmark, MapPin, PiggyBank, Receipt, Smile, Undo2, UserCog, UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { Button, Card, EmptyState, PageHeader, PermissionGate, RequirePermission, Skeleton, cn, focusRing, useI18n } from '@typease/ui';
import { useFinApi } from '@/components/fin/api';
import { FinanceToolsMenu } from '@/components/fin/finance-tabs';
import { LoadError } from '@/components/fin/shared';
import type { ReportDefinition } from '@/components/fin/types';
import { finKeys } from '@/lib/keys/fin';

const ICONS: Record<string, LucideIcon> = {
  'daily-sales': CalendarDays,
  'monthly-service-revenue': ChartLine,
  'transactions-by-service': Receipt,
  'outstanding-payments': HandCoins,
  refunds: Undo2,
  liabilities: Landmark,
  'corporate-revenue': Building2,
  'service-profitability': PiggyBank,
  'requests-by-status': ChartPie,
  'staff-workload': UserCog,
  'branch-performance': MapPin,
  'customer-growth': UsersRound,
  'expiry-reminders': BellRing,
  'document-processing-time': Clock,
  'customer-satisfaction': Smile,
};

/** Reports the signed-in role may run, as the API lists them, grouped into financial and operational. */
export function ReportsCatalogue() {
  return (
    <RequirePermission anyOf={['report.operational', 'report.financial']}>
      <ReportsCatalogueInner />
    </RequirePermission>
  );
}

function ReportsCatalogueInner() {
  const { t } = useI18n();
  const api = useFinApi();
  const catalogue = useQuery({ queryKey: finKeys.reports.catalogue, queryFn: ({ signal }) => api.reports.catalogue(signal), staleTime: 5 * 60_000 });

  const groups = React.useMemo(() => {
    const reports = catalogue.data?.reports ?? [];
    return [
      { id: 'financial', reports: reports.filter((r) => r.permission === 'report.financial') },
      { id: 'operational', reports: reports.filter((r) => r.permission !== 'report.financial') },
    ].filter((g) => g.reports.length > 0);
  }, [catalogue.data]);

  return (
    <>
      <PageHeader
        title={t('fin.reports.title')}
        description={t('fin.reports.description')}
        secondary={
          <>
            <FinanceToolsMenu />
            <PermissionGate permission="report.export">
              <Button asChild variant="outline">
                <Link href="/reports/scheduled">
                  <CalendarClock aria-hidden="true" />
                  {t('fin.reports.scheduled.title')}
                </Link>
              </Button>
            </PermissionGate>
          </>
        }
      />
      {catalogue.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : catalogue.isError ? (
        <LoadError error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState size="page" icon={<ChartColumn />} title={t('fin.reports.emptyTitle')} description={t('fin.reports.emptyText')} />
        </Card>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`reports-${group.id}`}>
              <h2 id={`reports-${group.id}`} className="text-lg font-semibold text-foreground">
                {t(`fin.reports.groups.${group.id}.title`)}
              </h2>
              <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">{t(`fin.reports.groups.${group.id}.text`)}</p>
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {group.reports.map((report) => (
                  <li key={report.key}>
                    <ReportCard report={report} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function ReportCard({ report }: { report: ReportDefinition }) {
  const Icon = ICONS[report.key] ?? ChartColumn;
  return (
    <Link href={`/reports/${report.key}`} className={cn('group flex h-full items-start gap-3.5 rounded-lg border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm', focusRing)}>
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary-soft text-secondary-text">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground" dir="auto">
          {report.title}
        </span>
        <span className="mt-1 line-clamp-3 block text-sm text-muted-foreground" dir="auto">
          {report.description}
        </span>
      </span>
      <ChevronRight className="rtl-mirror mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}
