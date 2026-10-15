'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronRight, MessageSquare } from 'lucide-react';
import type { RequestListItem } from '@typease/api-client';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Skeleton, cn, focusRing, useBranding, useI18n } from '@typease/ui';
import { LoadError, SectionTitle } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import { useSeenMessages } from '@/lib/seen';
import type { RequestComment } from '@/lib/types';

const fromCentre = (m: RequestComment) => m.authorType !== 'CUSTOMER' && m.authorType !== 'CORPORATE';

/**
 * Conversations with the centre, one per request. The messages themselves live on
 * the request (its Messages tab); this page is the overview: who wrote last, and
 * where the centre has written something the customer has not opened here yet.
 */
export function Messages() {
  const { t, tn, pick, formatRelative } = useI18n();
  const api = usePortalApi();
  const { name } = useBranding();
  const { isNew } = useSeenMessages();
  const requests = useQuery({ queryKey: keys.requests.recent, queryFn: ({ signal }) => api.requests({ pageSize: 50, sort: 'updatedAt:desc' }, signal) });
  // A draft has no conversation yet: the centre has not seen it.
  const candidates = (requests.data?.data ?? []).filter((r) => r.status !== 'DRAFT');
  const threads = useQueries({
    queries: candidates.map((r) => ({ queryKey: keys.requests.comments(r.id), queryFn: ({ signal }: { signal: AbortSignal }) => api.comments(r.id, signal), staleTime: 30_000 })),
  });

  const header = <PageHeader title={t('nav.messages')} description={t('account.sections.messages')} />;
  if (requests.isPending) {
    return (
      <>
        {header}
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </>
    );
  }
  if (requests.isError) {
    return (
      <>
        {header}
        <LoadError error={requests.error} onRetry={() => void requests.refetch()} />
      </>
    );
  }

  const loading = threads.some((q) => q.isPending);
  const failed = threads.filter((q) => q.isError).length;
  const rows = candidates
    .map((request, index) => {
      const messages = [...(threads[index]?.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = messages[messages.length - 1];
      const lastFromCentre = [...messages].reverse().find(fromCentre);
      return { request, messages, last, unread: isNew(request.id, lastFromCentre?.createdAt) };
    })
    .sort((a, b) => (b.last?.createdAt ?? '').localeCompare(a.last?.createdAt ?? ''));
  const withMessages = rows.filter((row) => row.last);
  const silent = rows.filter((row) => !row.last && row.request.status !== 'COMPLETED' && row.request.status !== 'CANCELLED');

  const row = (request: RequestListItem, body: React.ReactNode, unread: boolean) => (
    <li key={request.id}>
      <Link href={`/requests/${request.id}?tab=messages`} className={cn('flex items-center gap-3.5 rounded-lg border bg-card p-4 shadow-xs transition-shadow hover:shadow-md', unread && 'border-secondary/40', focusRing)} data-unread={unread || undefined}>
        <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', unread ? 'bg-secondary text-secondary-foreground' : 'bg-muted text-muted-foreground')}>
          <MessageSquare className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className={cn('text-base text-foreground', unread ? 'font-semibold' : 'font-medium')}>{pick(request.service.name, request.service.nameAr)}</span>
            <span className="tabular ltr-value text-sm text-muted-foreground">{request.requestNo}</span>
            {unread ? <Badge tone="brand">{t('my.messages.new')}</Badge> : null}
          </span>
          {body}
        </span>
        <ChevronRight className="rtl-mirror size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );

  return (
    <>
      {header}
      {failed ? (
        <Alert tone="warning" className="mb-4">
          {t('my.messages.partial')}
        </Alert>
      ) : null}
      {loading ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : rows.length === 0 || (withMessages.length === 0 && silent.length === 0) ? (
        <Card>
          <EmptyState
            size="page"
            icon={<MessageSquare />}
            title={t('my.messages.emptyTitle')}
            description={t('my.messages.emptyText')}
            action={
              <Button asChild variant="outline">
                <Link href="/requests">{t('nav.requests')}</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-8">
          {withMessages.length ? (
            <ul className="space-y-3">
              {withMessages.map(({ request, last, messages, unread }) =>
                row(
                  request,
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    <span className="line-clamp-2" dir="auto">
                      <span className="font-medium text-foreground/80">{fromCentre(last!) ? name : t('my.common.you')}:</span> {last!.body}
                    </span>
                    <span className="mt-0.5 block">
                      {formatRelative(last!.createdAt)}
                      <span aria-hidden="true"> – </span>
                      {tn('my.messages.count', messages.length)}
                    </span>
                  </span>,
                  unread,
                ),
              )}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-base text-muted-foreground">{t('my.messages.noneYet')}</p>
          )}
          {silent.length ? (
            <section aria-labelledby="write-h" className="space-y-3">
              <SectionTitle id="write-h">{t('my.messages.writeAbout')}</SectionTitle>
              <ul className="space-y-3">{silent.map(({ request }) => row(request, <span className="mt-0.5 block text-sm text-muted-foreground">{t('my.messages.noMessages')}</span>, false))}</ul>
            </section>
          ) : null}
        </div>
      )}
      <p className="mt-6 text-sm text-muted-foreground">
        {t('my.messages.supportHint')}{' '}
        <Link href="/support" className="font-medium text-secondary-text underline-offset-4 hover:underline">
          {t('nav.support')}
        </Link>
      </p>
    </>
  );
}
