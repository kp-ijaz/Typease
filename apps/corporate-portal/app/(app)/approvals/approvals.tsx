'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, FileText } from 'lucide-react';
import { Badge, Button, Card, DataTable, EmptyState, PageHeader, Skeleton, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, useI18n, type DataTableColumn, type DataTableFilter } from '@typease/ui';
import { daysUntil, Gate, LoadError, Ltr, Money, PersonName, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { QuotationRow } from '@/lib/types';

/** A sent quotation past its date reads "Expired" even before the centre's job has marked it. */
export const quotationStatus = (q: Pick<QuotationRow, 'status' | 'expired'>) => (q.status === 'SENT' && q.expired ? 'EXPIRED' : q.status);

/** Quotations still waiting for the company's decision, the one that runs out first on top. */
export function useOpenQuotations(enabled = true) {
  const api = usePortalApi();
  return useQuery({
    queryKey: keys.quotations.open,
    queryFn: async ({ signal }) => {
      const page = await api.quotations({ status: 'SENT', pageSize: 100, sort: 'createdAt:asc' }, signal);
      return page.data.filter((q) => !q.expired).sort((a, b) => (a.validUntil ?? '9999').localeCompare(b.validUntil ?? '9999'));
    },
    enabled,
    staleTime: 30_000,
  });
}

const STATUSES = ['SENT', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;

/**
 * What waits for the company's decision. In the API a company approves (or declines, with a
 * reason) the centre's QUOTATION for a request; work on the request starts after that.
 */
export function Approvals() {
  return (
    <Gate anyOf={['corp.requests.approve']}>
      <ApprovalsPage />
    </Gate>
  );
}

function ApprovalsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const open = useOpenQuotations();
  const tab = search.get('tab') === 'history' ? 'history' : 'waiting';
  const setTab = (next: string) => router.replace(next === 'waiting' ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  return (
    <>
      <PageHeader title={t('nav.approvals')} description={t('my.approvals.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="-mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsTrigger value="waiting">
            {t('my.approvals.tabs.waiting')}
            {open.data?.length ? <Badge tone="warning">{open.data.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="history">{t('my.approvals.tabs.history')}</TabsTrigger>
        </TabsList>
        <TabsContent value="waiting">
          <Waiting />
        </TabsContent>
        <TabsContent value="history">
          <History />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Waiting() {
  const { t, tn, formatDate, today } = useI18n();
  const open = useOpenQuotations();
  const role = useRole();
  if (open.isPending) {
    return (
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (open.isError) return <LoadError error={open.error} onRetry={() => void open.refetch()} />;
  if (!open.data.length) {
    return (
      <Card>
        <EmptyState size="page" icon={<ClipboardCheck />} title={t('my.approvals.emptyTitle')} description={t('my.approvals.emptyText')} />
      </Card>
    );
  }
  return (
    <ul className="space-y-3">
      {open.data.map((q) => {
        const left = q.validUntil ? daysUntil(q.validUntil, today()) : null;
        return (
          <li key={q.id} className="rounded-lg border bg-card p-4 shadow-xs" data-quotation={q.quotationNo}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="min-w-0 flex-1 basis-64 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link href={`${ROUTES.approvals}/${q.id}`} className="text-md font-semibold text-foreground hover:underline">
                    {t('titles.quotationDetail')} <Ltr>{q.quotationNo}</Ltr>
                  </Link>
                  <Badge tone="warning">{t('my.approvals.waiting')}</Badge>
                </p>
                <p className="text-sm text-muted-foreground">
                  {q.customer ? <PersonName name={q.customer.fullName} erased={q.customer.erased} /> : null}
                  {q.request ? (
                    <>
                      {q.customer ? <span aria-hidden="true"> – </span> : null}
                      {t('my.approvals.forRequest')}{' '}
                      <Link href={`${ROUTES.requests}/${q.request.id}`} className="font-medium text-secondary-text hover:underline">
                        <Ltr>{q.request.requestNo}</Ltr>
                      </Link>
                    </>
                  ) : null}
                </p>
                {q.validUntil ? (
                  <p className="text-sm text-muted-foreground">
                    {t('my.approvals.validUntil', { date: formatDate(q.validUntil) })}
                    {left !== null && left <= 7 ? <span className="font-medium text-warning-text"> ({tn('my.expiry.inDays', Math.max(0, left))})</span> : null}
                  </p>
                ) : null}
              </div>
              <p className="text-xl font-semibold">
                <Money amount={q.total} currency={q.currency} />
              </p>
              <Button asChild className="w-full sm:w-auto" data-action="review">
                <Link href={`${ROUTES.approvals}/${q.id}`}>{role.canApprove ? t('my.approvals.review') : t('common.view')}</Link>
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Every quotation the centre has sent the company, with what was decided. */
function History() {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const columns = React.useMemo<Array<DataTableColumn<QuotationRow>>>(
    () => [
      { id: 'number', header: t('my.approvals.columns.number'), mobile: 'title', className: 'whitespace-nowrap', cell: (q) => <Ltr>{q.quotationNo}</Ltr> },
      { id: 'status', header: t('my.requests.columns.status'), mobile: 'badge', cell: (q) => <StatusBadge kind="quotation" status={quotationStatus(q)} label={q.status === 'SENT' && !q.expired ? { en: t('my.approvals.waiting'), ar: t('my.approvals.waiting') } : undefined} /> },
      { id: 'person', header: t('my.requests.columns.person'), cell: (q) => (q.customer ? <PersonName name={q.customer.fullName} erased={q.customer.erased} /> : null) },
      { id: 'request', header: t('my.approvals.columns.request'), className: 'whitespace-nowrap', cell: (q) => (q.request ? <Ltr>{q.request.requestNo}</Ltr> : null) },
      { id: 'total', header: t('my.fees.total'), align: 'end', className: 'whitespace-nowrap', cell: (q) => <Money amount={q.total} currency={q.currency} /> },
      { id: 'sent', header: t('my.approvals.columns.sent'), sortField: 'createdAt', className: 'whitespace-nowrap', cell: (q) => formatDate(q.sentAt ?? q.createdAt) },
      { id: 'decided', header: t('my.approvals.decided'), mobile: 'hidden', className: 'whitespace-nowrap', cell: (q) => (q.decidedAt ? formatDate(q.decidedAt) : null) },
    ],
    [t, formatDate],
  );
  const filters = React.useMemo<DataTableFilter[]>(() => [{ id: 'status', type: 'select', label: t('my.requests.columns.status'), options: STATUSES.map((s) => ({ value: s, label: t(`my.approvals.status.${s}`) })) }], [t]);
  return (
    <DataTable<QuotationRow>
      caption={t('my.approvals.tabs.history')}
      queryKey={keys.quotations.all}
      queryFn={(params, signal) => api.quotations(params, signal)}
      columns={columns}
      rowKey={(q) => q.id}
      rowHref={(q) => `${ROUTES.approvals}/${q.id}`}
      filters={filters}
      syncUrl={false}
      searchPlaceholder={t('my.approvals.search')}
      defaultSort="createdAt:desc"
      empty={{ icon: <FileText />, title: t('my.approvals.historyEmptyTitle'), description: t('my.approvals.historyEmptyText') }}
    />
  );
}
