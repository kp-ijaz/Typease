'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ClipboardList } from 'lucide-react';
import type { RequestStatus } from '@typease/types';
import type { RequestListItem } from '@typease/api-client';
import { Alert, Button, Card, EmptyState, PageHeader, Skeleton, StatusBadge, cn, focusRing, useApi, useBranding, useErrorMessage, useI18n, useSession } from '@typease/ui';
import { ROUTES } from '@/lib/config';

/** Statuses where the next move is the customer's. */
const NEEDS_CUSTOMER: RequestStatus[] = ['DRAFT', 'AWAITING_CUSTOMER', 'QUOTED', 'AWAITING_PAYMENT'];
const CLOSED: RequestStatus[] = ['COMPLETED', 'CANCELLED'];

function RequestRow({ request, highlight }: { request: RequestListItem; highlight?: boolean }) {
  const { t, pick, formatDate, has } = useI18n();
  const nextKey = `account.dashboard.next.${request.status}`;
  return (
    <li>
      <Link href={`/requests/${request.id}`} className={cn('flex items-center gap-4 rounded-lg border bg-card p-4 shadow-xs transition-shadow hover:shadow-md', highlight && 'border-warning/50', focusRing)}>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-md font-semibold text-foreground">{pick(request.service.name, request.service.nameAr)}</span>
            {/* The API words the label for customers ("Action needed from you"). */}
            <StatusBadge kind="requestCustomer" status={request.status} label={request.statusLabel} />
          </div>
          {has(nextKey) ? <p className="text-base text-foreground/85">{t(nextKey)}</p> : null}
          <p className="text-sm text-muted-foreground">
            <span className="tabular">{request.requestNo}</span>
            <span aria-hidden="true"> – </span>
            {t('account.dashboard.requested', { date: formatDate(request.createdAt) })}
          </p>
        </div>
        <ChevronRight className="rtl-mirror size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function CustomerDashboard() {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const { name } = useBranding();
  const describe = useErrorMessage();
  const requests = useQuery({ queryKey: ['requests', 'mine'], queryFn: () => api.requests.list({ pageSize: 20, sort: 'createdAt:desc' }) });

  const open = (requests.data?.data ?? []).filter((r) => !CLOSED.includes(r.status));
  const action = open.filter((r) => NEEDS_CUSTOMER.includes(r.status));
  const progress = open.filter((r) => !NEEDS_CUSTOMER.includes(r.status));
  const firstName = session.user?.fullName.trim().split(/\s+/)[0] ?? '';

  return (
    <>
      <PageHeader title={t('account.dashboard.greeting', { name: firstName })} description={t('account.dashboard.description', { centre: name })} />

      {requests.isPending ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : requests.isError ? (
        <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void requests.refetch()}>{t('common.retry')}</Button>}>
          {describe(requests.error)}
        </Alert>
      ) : open.length === 0 ? (
        <Card>
          <EmptyState
            size="page"
            icon={<ClipboardList />}
            title={t('account.dashboard.emptyTitle')}
            description={t('account.dashboard.emptyText')}
            action={
              <Button asChild variant="accent">
                <Link href={ROUTES.services}>{t('account.dashboard.browse')}</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-8">
          <section aria-labelledby="action-h">
            <h2 id="action-h" className="mb-3 text-lg font-semibold">
              {t('account.dashboard.actionTitle')}
            </h2>
            {action.length ? (
              <ul className="space-y-3">
                {action.map((r) => (
                  <RequestRow key={r.id} request={r} highlight />
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-base text-muted-foreground">{t('account.dashboard.actionEmpty')}</p>
            )}
          </section>
          <section aria-labelledby="progress-h">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="progress-h" className="text-lg font-semibold">
                {t('account.dashboard.progressTitle')}
              </h2>
              <Button asChild variant="link">
                <Link href="/requests">{t('account.dashboard.viewAll')}</Link>
              </Button>
            </div>
            {progress.length ? (
              <ul className="space-y-3">
                {progress.map((r) => (
                  <RequestRow key={r.id} request={r} />
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-base text-muted-foreground">{t('account.dashboard.progressEmpty')}</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
