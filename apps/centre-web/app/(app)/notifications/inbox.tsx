'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Check, CheckCheck, ChevronRight } from 'lucide-react';
import type { Page } from '@typease/types';
import { Button, Card, EmptyState, PageHeader, Pagination, Skeleton, cn, focusRing, useApi, useI18n, useToast } from '@typease/ui';
import { Loadable, SwitchRow, useRun } from '@/components/ops/common';
import type { InboxItem } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

type InboxPage = Page<InboxItem> & { unreadCount: number };

/** Where a notification leads. Only pages of the staff app; unknown kinds simply have no link. */
function linkOf(item: InboxItem): string | null {
  const id = item.relatedId;
  switch (item.relatedType) {
    case 'ServiceRequest':
      return id ? `/requests/${id}` : '/requests';
    case 'Quotation':
      return id ? `/quotations/${id}` : null;
    case 'Invoice':
      return id ? `/invoices/${id}` : null;
    case 'Payment':
      return id ? `/payments/${id}` : null;
    case 'Appointment':
      return '/appointments';
    case 'SupportTicket':
      // Staff are notified about answers of TypEase support; customer tickets notify the customer.
      return id ? (item.eventKey === 'support.response' ? `/support/platform/${id}` : `/support/${id}`) : '/support';
    case 'ReminderSchedule':
      return '/reminders';
    case 'Subscription':
      return '/subscription';
    case 'Customer':
      return id ? `/customers/${id}` : null;
    case 'AutomationExecution':
      return id ? `/automations/executions/${id}` : '/automations/executions';
    default:
      return null;
  }
}

/** The signed-in person's own notifications: unread first, mark one or all as read, open what they are about. */
export function Inbox() {
  const { t, tn, formatRelative, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const { run, busy } = useRun();
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const key = [...opsKeys.inbox.list(unreadOnly), page] as const;
  const inbox = useQuery({ queryKey: key, queryFn: () => api.client.get<InboxPage>('/me/notifications', { query: { page, pageSize: 20, unreadOnly: unreadOnly || undefined } }) });

  /** Marking as read is cheap and reversible: shown at once, rolled back if the API refuses. */
  const markRead = async (item: InboxItem) => {
    if (item.readAt) return;
    const previous = queryClient.getQueryData<InboxPage>(key);
    queryClient.setQueryData<InboxPage>(key, (old) => (old ? { ...old, unreadCount: Math.max(0, old.unreadCount - 1), data: old.data.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)) } : old));
    try {
      await api.client.post(`/me/notifications/${item.id}/read`);
      void queryClient.invalidateQueries({ queryKey: opsKeys.inbox.all });
    } catch (error) {
      queryClient.setQueryData(key, previous);
      toasts.error(error);
    }
  };

  const unread = inbox.data?.unreadCount ?? 0;

  return (
    <>
      <PageHeader
        title={t('ops.inbox.title')}
        description={inbox.data ? (unread > 0 ? tn('ops.inbox.unread', unread) : t('ops.inbox.allRead')) : t('ops.inbox.description')}
        action={
          <Button
            disabled={unread === 0}
            loading={busy === 'all'}
            loadingText={t('common.loading')}
            onClick={() => void run('all', () => api.client.post<{ updated: number }>('/me/notifications/read-all'), { success: t('ops.inbox.allMarked'), invalidate: [opsKeys.inbox.all] })}
          >
            <CheckCheck aria-hidden="true" />
            {t('ops.inbox.markAll')}
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <SwitchRow
            label={t('ops.inbox.unreadOnly')}
            checked={unreadOnly}
            onCheckedChange={(on) => {
              setUnreadOnly(on);
              setPage(1);
            }}
          />
        </div>
        <Loadable
          query={inbox}
          skeleton={
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          }
        >
          {(data) => {
            if (data.data.length === 0) return <EmptyState icon={<BellOff />} title={t(unreadOnly ? 'ops.inbox.emptyUnreadTitle' : 'ops.inbox.emptyTitle')} description={t('ops.inbox.emptyText')} />;
            // Unread first, each group newest first.
            const sorted = [...data.data].sort((a, b) => Number(!!a.readAt) - Number(!!b.readAt) || b.createdAt.localeCompare(a.createdAt));
            return (
              <>
                <ul className="divide-y">
                  {sorted.map((item) => {
                    const href = linkOf(item);
                    const isUnread = !item.readAt;
                    const text = (
                      <>
                        {/* The text keeps its own reading direction (bdi) but is aligned like the rest of the page. */}
                        <span className={cn('block text-base', isUnread ? 'font-semibold text-foreground' : 'text-foreground/90')}>
                          <bdi>{item.subject ?? t('ops.inbox.noSubject')}</bdi>
                        </span>
                        {item.body ? (
                          <span className="mt-0.5 line-clamp-2 block whitespace-pre-line text-sm text-muted-foreground">
                            <bdi>{item.body}</bdi>
                          </span>
                        ) : null}
                        <span className="mt-1 block text-sm text-muted-foreground" title={formatDateTime(item.createdAt)}>
                          {formatRelative(item.createdAt)}
                        </span>
                      </>
                    );
                    return (
                      <li key={item.id} className={cn('flex items-start gap-3 px-4 py-3.5', isUnread && 'bg-secondary-soft/40')}>
                        <span aria-hidden="true" className={cn('mt-2 size-2.5 shrink-0 rounded-full', isUnread ? 'bg-secondary' : 'bg-transparent')} />
                        {isUnread ? <span className="sr-only">{t('ops.inbox.unreadLabel')}</span> : null}
                        {href ? (
                          <Link href={href} onClick={() => void markRead(item)} className={cn('group min-w-0 flex-1 rounded-sm', focusRing)}>
                            {text}
                          </Link>
                        ) : (
                          <div className="min-w-0 flex-1">{text}</div>
                        )}
                        <span className="flex shrink-0 items-center gap-1">
                          {isUnread ? (
                            <Button variant="ghost" size="sm" onClick={() => void markRead(item)}>
                              <Check aria-hidden="true" />
                              <span className="hidden sm:inline">{t('ops.inbox.markRead')}</span>
                              <span className="sr-only sm:hidden">{t('ops.inbox.markRead')}</span>
                            </Button>
                          ) : null}
                          {href ? <ChevronRight className="rtl-mirror size-4 text-muted-foreground" aria-hidden="true" /> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {data.meta.totalPages > 1 ? <Pagination meta={data.meta} onPageChange={setPage} className="border-t px-4 py-3" /> : null}
              </>
            );
          }}
        </Loadable>
      </Card>
    </>
  );
}
