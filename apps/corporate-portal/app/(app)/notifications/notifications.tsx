'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, CheckCheck, Mail, MessageCircle, MessageSquareText, Smartphone, type LucideIcon } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ChoiceLabel, EmptyState, PageHeader, Pagination, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger, cn, focusRing, useI18n, useToast,
} from '@typease/ui';
import { LoadError, SectionTitle, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { Inbox, InboxItem, NotificationChannel, NotificationPreferences } from '@/lib/types';

/**
 * Where a notification leads: the page of the record it is about, when the signed-in person
 * may open that page (an employee has no approvals and no invoices).
 */
export function useNotificationHref(): (item: Pick<InboxItem, 'relatedType' | 'relatedId'>) => string | null {
  const role = useRole();
  return React.useCallback(
    (item) => {
      const id = item.relatedId;
      switch (item.relatedType) {
        case 'ServiceRequest':
          return id ? `${ROUTES.requests}/${id}` : ROUTES.requests;
        case 'Quotation':
          return role.canApprove ? (id ? `${ROUTES.approvals}/${id}` : ROUTES.approvals) : null;
        case 'Invoice':
          return role.canSeeMoney ? (id ? `${ROUTES.invoices}/${id}` : ROUTES.invoices) : null;
        case 'Payment':
          return role.canSeeMoney ? ROUTES.invoices : null;
        case 'SupportTicket':
          return id ? `${ROUTES.support}/${id}` : ROUTES.support;
        case 'ReminderSchedule':
          return ROUTES.reminders;
        default:
          return null;
      }
    },
    [role.canApprove, role.canSeeMoney],
  );
}

const PAGE_SIZE = 20;

/** Updates from the centre inside the portal (mark read, open the record), and the choice of how else to be told. */
export function Notifications() {
  const { t } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const toasts = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const tab = search.get('tab') === 'settings' ? 'settings' : 'inbox';
  const setTab = (next: string) => router.replace(next === 'inbox' ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  const unread = useQuery({ queryKey: keys.notifications.unread, queryFn: ({ signal }) => api.inbox({ pageSize: 1, unreadOnly: true }, signal) });

  const markAll = useMutation({
    mutationFn: () => api.markAllRead(),
    onSuccess: async () => {
      // Lists that are not on screen (the other filter, other pages) would show the old "unread" marks for a moment when opened.
      queryClient.removeQueries({ queryKey: keys.notifications.all, type: 'inactive' });
      await queryClient.invalidateQueries({ queryKey: keys.notifications.all });
      toasts.success(t('my.notifications.allRead'));
    },
    onError: (error) => toasts.error(error),
  });

  return (
    <>
      <PageHeader
        title={t('nav.notifications')}
        description={role.company ? t('sections.notifications') : t('my.notifications.mineText')}
        secondary={
          tab === 'inbox' && (unread.data?.unreadCount ?? 0) > 0 ? (
            <Button variant="outline" loading={markAll.isPending} loadingText={t('common.loading')} onClick={() => markAll.mutate()} data-action="mark-all-read">
              <CheckCheck aria-hidden="true" />
              {t('my.notifications.markAll')}
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="-mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsTrigger value="inbox">
            {t('my.notifications.tabs.inbox')}
            {unread.data?.unreadCount ? <Badge tone="brand">{unread.data.unreadCount}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="settings">{t('my.notifications.tabs.settings')}</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox">
          <InboxList />
        </TabsContent>
        <TabsContent value="settings">
          <Preferences />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- inbox

function InboxList() {
  const { t, formatRelative, formatDateTime } = useI18n();
  const api = usePortalApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const switchId = React.useId();
  const notificationHref = useNotificationHref();
  const role = useRole();
  const queryKey = [...keys.notifications.all, 'list', page, unreadOnly] as const;
  const inbox = useQuery({ queryKey, queryFn: ({ signal }) => api.inbox({ page, pageSize: PAGE_SIZE, ...(unreadOnly ? { unreadOnly: true } : {}) }, signal), placeholderData: keepPreviousData });

  // Marking as read is cheap and reversible: shown at once, rolled back if the API refuses.
  const read = useMutation({
    mutationFn: (item: InboxItem) => api.markRead(item.id),
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Inbox>(queryKey);
      if (previous) {
        queryClient.setQueryData<Inbox>(queryKey, {
          ...previous,
          unreadCount: Math.max(0, previous.unreadCount - 1),
          data: previous.data.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)),
        });
      }
      return { previous };
    },
    onError: (_error, _item, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      queryClient.removeQueries({ queryKey: keys.notifications.all, type: 'inactive' });
      void queryClient.invalidateQueries({ queryKey: keys.notifications.all });
    },
  });

  const open = (item: InboxItem) => {
    if (!item.readAt) read.mutate(item);
    const href = notificationHref(item);
    if (href) router.push(href);
  };

  if (inbox.isPending) {
    return (
      <div className="space-y-2" role="status" aria-label={t('common.loading')}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }
  if (inbox.isError) return <LoadError error={inbox.error} onRetry={() => void inbox.refetch()} />;

  const { data: items, meta } = inbox.data;
  return (
    <div className="space-y-4">
      <ChoiceLabel
        htmlFor={switchId}
        control={
          <Switch
            id={switchId}
            checked={unreadOnly}
            onCheckedChange={(on) => {
              setUnreadOnly(on);
              setPage(1);
            }}
          />
        }
        label={t('my.notifications.unreadOnly')}
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState size="page" icon={<Bell />} title={unreadOnly ? t('my.notifications.noUnreadTitle') : t('my.notifications.emptyTitle')} description={unreadOnly ? t('my.notifications.noUnreadText') : role.company ? t('my.notifications.emptyText') : t('my.notifications.emptyTextSelf')} />
        </Card>
      ) : (
        <ul className={cn('divide-y rounded-lg border bg-card shadow-xs', inbox.isFetching && inbox.isPlaceholderData && 'opacity-60')}>
          {items.map((item) => {
            const href = notificationHref(item);
            return (
              <li key={item.id} data-unread={!item.readAt || undefined} data-notification={item.id}>
                <button type="button" onClick={() => open(item)} className={cn('flex w-full items-start gap-3 p-4 text-start transition-colors hover:bg-muted/50', focusRing)}>
                  <span aria-hidden="true" className={cn('mt-2 size-2.5 shrink-0 rounded-full', item.readAt ? 'bg-transparent' : 'bg-secondary')} />
                  <span className="min-w-0 flex-1">
                    {/* The centre wrote the message in the reader's language at the time: it is shown as it was sent. */}
                    <span className={cn('block text-base text-foreground', item.readAt ? 'font-medium' : 'font-semibold')} dir="auto" lang={item.language}>
                      {item.subject ?? t('nav.notifications')}
                      {!item.readAt ? <span className="sr-only"> ({t('my.notifications.unread')})</span> : null}
                    </span>
                    {item.body ? (
                      <span className="mt-0.5 block text-base text-foreground/80" dir="auto" lang={item.language}>
                        {item.body}
                      </span>
                    ) : null}
                    <span className="mt-1 block text-sm text-muted-foreground" title={formatDateTime(item.createdAt)}>
                      {formatRelative(item.createdAt)}
                      {href ? (
                        <>
                          <span aria-hidden="true"> – </span>
                          <span className="font-medium text-secondary-text">{t('common.open')}</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {meta.totalPages > 1 ? <Pagination meta={meta} onPageChange={setPage} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- how to be told

const CHANNEL_ICONS: Record<NotificationChannel, LucideIcon> = { EMAIL: Mail, SMS: MessageSquareText, WHATSAPP: MessageCircle, PUSH: Smartphone, IN_APP: BellRing };
const SWITCHABLE: NotificationChannel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];

/** Whether a channel is on: the person's own choice for "everything on this channel", else the centre's default (on when there is none). */
function channelEnabled(prefs: NotificationPreferences, channel: NotificationChannel): boolean {
  const own = prefs.preferences.find((p) => p.channel === channel && p.eventGroup === '*');
  if (own) return own.enabled;
  return prefs.channelDefaults?.[channel.toLowerCase() as 'email' | 'sms' | 'whatsapp' | 'push'] ?? true;
}

function Preferences() {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: keys.notifications.preferences, queryFn: () => api.notificationPreferences() });
  const save = useMutation({
    mutationFn: (change: { channel: NotificationChannel; enabled: boolean }) => api.saveNotificationPreferences({ preferences: [{ channel: change.channel, eventGroup: '*', enabled: change.enabled }] }),
    onSuccess: (next, change) => {
      queryClient.setQueryData(keys.notifications.preferences, next);
      toasts.success(change.enabled ? t('my.notifications.channelOn', { channel: t(`my.notifications.channels.${change.channel}.name`) }) : t('my.notifications.channelOff', { channel: t(`my.notifications.channels.${change.channel}.name`) }));
    },
    onError: (error) => toasts.error(error),
  });

  if (prefs.isPending) {
    return (
      <div className="space-y-2" role="status" aria-label={t('common.loading')}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  if (prefs.isError) return <LoadError error={prefs.error} onRetry={() => void prefs.refetch()} />;

  const channels = SWITCHABLE.filter((channel) => prefs.data.channels.includes(channel));
  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-5">
        <div>
          <SectionTitle>{t('my.notifications.settingsTitle')}</SectionTitle>
          <p className="mt-1 text-base text-muted-foreground">{t('my.notifications.settingsText')}</p>
        </div>
        <ul className="divide-y rounded-lg border">
          {channels.map((channel) => {
            const Icon = CHANNEL_ICONS[channel];
            const id = `channel-${channel}`;
            const on = channelEnabled(prefs.data, channel);
            const pending = save.isPending && save.variables?.channel === channel;
            return (
              <li key={channel} className="flex items-center gap-3.5 p-4">
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-base font-medium text-foreground">{t(`my.notifications.channels.${channel}.name`)}</span>
                  <span className="block text-sm text-muted-foreground">{t(`my.notifications.channels.${channel}.hint`)}</span>
                </label>
                <Switch id={id} checked={pending ? save.variables!.enabled : on} disabled={save.isPending} onCheckedChange={(enabled) => save.mutate({ channel, enabled })} />
              </li>
            );
          })}
          <li className="flex items-center gap-3.5 p-4">
            <BellRing className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium text-foreground">{t('my.notifications.channels.IN_APP.name')}</p>
              <p className="text-sm text-muted-foreground">{t('my.notifications.channels.IN_APP.hint')}</p>
            </div>
            <Badge tone="neutral">{t('my.notifications.alwaysOn')}</Badge>
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">{t('my.notifications.securityNote')}</p>
      </CardContent>
    </Card>
  );
}
