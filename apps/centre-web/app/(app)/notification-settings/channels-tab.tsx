'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Lock, Mail, MessageCircle, MessageSquareText, Smartphone } from 'lucide-react';
import { notificationSettingsSchema } from '@typease/validation';
import {
  Badge, Button, Form, FormError, FormField, Input, Skeleton, Switch, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, useApi, useI18n, useSession, useToast,
  useZodForm,
} from '@typease/ui';
import { Loadable, Panel, useRun } from '@/components/ops/common';
import type { ChannelStatus, NotificationChannel, NotificationSettings } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { CHANNELS, useEventLabel } from './settings-page';

const ICONS: Record<NotificationChannel, React.ReactNode> = {
  EMAIL: <Mail aria-hidden="true" />,
  SMS: <MessageSquareText aria-hidden="true" />,
  WHATSAPP: <MessageCircle aria-hidden="true" />,
  IN_APP: <Bell aria-hidden="true" />,
  PUSH: <Smartphone aria-hidden="true" />,
};

/** Channel status (which provider sends), the events x channels matrix, and the hourly limit per recipient. */
export function ChannelsTab() {
  const { t, has } = useI18n();
  const api = useApi();
  const session = useSession();
  const eventLabel = useEventLabel();
  const { run, busy } = useRun();
  const channels = useQuery({ queryKey: opsKeys.notifications.channels, queryFn: () => api.client.get<ChannelStatus[]>('/notifications/channels') });
  const settings = useQuery({ queryKey: opsKeys.notifications.settings, queryFn: () => api.client.get<NotificationSettings>('/notifications/settings') });

  return (
    <div className="space-y-4">
      <Panel
        title={t('ops.notify.channels.title')}
        description={t('ops.notify.channels.text')}
        action={
          session.hasPermission('integration.manage') ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/integrations">{t('ops.notify.channels.integrations')}</Link>
            </Button>
          ) : undefined
        }
      >
        <Loadable query={channels} skeleton={<Skeleton className="h-28 w-full" />}>
          {(list) => (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {list.map((c) => (
                <li key={c.channel} className="rounded-lg border p-4">
                  <p className="flex items-center gap-2 font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                    {ICONS[c.channel]}
                    {t(`ops.notify.channelNames.${c.channel}`)}
                  </p>
                  <p className="mt-2">
                    <Badge tone={c.configured ? 'success' : 'warning'}>{t(c.configured ? 'ops.notify.channels.ready' : 'ops.notify.channels.notReady')}</Badge>
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t(`ops.notify.channels.source.${c.source}`)}
                    {c.provider && c.source !== 'BUILT_IN' ? (
                      <>
                        {' · '}
                        <span className="ltr-value">{c.provider}</span>
                      </>
                    ) : null}
                  </p>
                  {c.detail ? (
                    <p className="mt-1.5 text-sm text-foreground/80" dir="auto">
                      {c.provider === 'log' && has('ops.notify.channels.devMode') ? t('ops.notify.channels.devMode') : c.detail}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Loadable>
      </Panel>

      <Panel title={t('ops.notify.matrix.title')} description={t('ops.notify.matrix.text')} bodyClassName="px-0 pb-0">
        <Loadable query={settings} skeleton={<Skeleton className="mx-5 mb-5 h-96" />}>
          {(data) => {
            const groups = [...new Set(data.events.map((e) => e.group))];
            const groupName = (group: string) => (has(`ops.notify.groups.${group}`) ? t(`ops.notify.groups.${group}`) : group);
            const note = (event: NotificationSettings['events'][number]) => (event.locked ? t('ops.notify.matrix.locked') : has(`ops.notify.audience.${event.audience}`) ? t(`ops.notify.audience.${event.audience}`) : event.audience);
            const toggle = (event: NotificationSettings['events'][number], channel: NotificationChannel, name: string) => (
              <Switch
                checked={event.channels[channel] === true}
                disabled={event.locked || busy !== null}
                aria-label={t('ops.notify.matrix.toggle', { event: name, channel: t(`ops.notify.channelNames.${channel}`) })}
                onCheckedChange={(enabled) =>
                  void run(`${event.eventKey}-${channel}`, () => api.client.patch(`/notifications/events/${encodeURIComponent(event.eventKey)}/channels/${channel}`, { enabled }), {
                    success: t(enabled ? 'ops.notify.matrix.switchedOn' : 'ops.notify.matrix.switchedOff', { event: name, channel: t(`ops.notify.channelNames.${channel}`) }),
                    invalidate: [opsKeys.notifications.settings],
                  })
                }
              />
            );
            return (
              <>
                {/* Phones: one block per event with its channels as labelled switches (a five-column table does not fit). */}
                <div className="border-t md:hidden">
                  {groups.map((group) => (
                    <section key={group}>
                      <h3 className="bg-muted/40 px-5 py-2 text-sm font-semibold text-muted-foreground">{groupName(group)}</h3>
                      <ul className="divide-y">
                        {data.events
                          .filter((e) => e.group === group)
                          .map((event) => {
                            const name = eventLabel(event.eventKey, event.label);
                            return (
                              <li key={event.eventKey} className="px-5 py-3.5">
                                <p className="flex items-center gap-2 font-medium">
                                  {name}
                                  {event.locked ? <Lock className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                                </p>
                                <p className="text-sm text-muted-foreground">{note(event)}</p>
                                <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
                                  {CHANNELS.filter((channel) => event.channels[channel] !== undefined).map((channel) => (
                                    <li key={channel} className="flex items-center gap-2 text-sm">
                                      {toggle(event, channel, name)}
                                      <span aria-hidden="true">{t(`ops.notify.channelNames.${channel}`)}</span>
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            );
                          })}
                      </ul>
                    </section>
                  ))}
                </div>
                <div className="hidden md:block">
                  <Table className="border-t">
                    <TableCaption>{t('ops.notify.matrix.title')}</TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-56">{t('ops.notify.matrix.event')}</TableHead>
                        {CHANNELS.map((c) => (
                          <TableHead key={c} className="text-center">
                            {t(`ops.notify.channelNames.${c}`)}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {groups.map((group) => (
                        <React.Fragment key={group}>
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={CHANNELS.length + 1} className="py-2 text-sm font-semibold text-muted-foreground">
                              {groupName(group)}
                            </TableCell>
                          </TableRow>
                          {data.events
                            .filter((e) => e.group === group)
                            .map((event) => {
                              const name = eventLabel(event.eventKey, event.label);
                              return (
                                <TableRow key={event.eventKey}>
                                  <TableCell>
                                    <span className="flex items-center gap-2 font-medium">
                                      {name}
                                      {event.locked ? <Lock className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                                    </span>
                                    <span className="block text-sm text-muted-foreground">{note(event)}</span>
                                  </TableCell>
                                  {CHANNELS.map((channel) => (
                                    <TableCell key={channel} className="text-center">
                                      {event.channels[channel] === undefined ? (
                                        <span className="text-muted-foreground" title={t('ops.notify.matrix.notAvailable')}>
                                          –
                                        </span>
                                      ) : (
                                        toggle(event, channel, name)
                                      )}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              );
                            })}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            );
          }}
        </Loadable>
      </Panel>

      <Panel title={t('ops.notify.limit.title')} description={t('ops.notify.limit.text')}>
        <Loadable query={settings} skeleton={<Skeleton className="h-20 w-full" />}>
          {(data) => <RateLimitForm value={data.rateLimitPerHour} />}
        </Loadable>
      </Panel>
    </div>
  );
}

function RateLimitForm({ value }: { value: number }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(notificationSettingsSchema.pick({ rateLimitPerHour: true }), { defaultValues: { rateLimitPerHour: value } });
  React.useEffect(() => {
    form.reset({ rateLimitPerHour: value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Form
      form={form}
      className="flex flex-wrap items-end gap-3 space-y-0"
      onSubmit={async (input) => {
        await api.client.put('/notifications/settings', input);
        toasts.success(t('ops.notify.limit.saved'));
        await queryClient.invalidateQueries({ queryKey: opsKeys.notifications.settings });
      }}
    >
      <FormField name="rateLimitPerHour" label={t('ops.notify.limit.field')} className="w-56">
        {(field) => <Input {...field} type="number" min={1} max={200} inputMode="numeric" dir="ltr" className="tabular" onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))} />}
      </FormField>
      <Button type="submit" disabled={!form.formState.isDirty} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
        {t('common.save')}
      </Button>
      <FormError className="basis-full" />
    </Form>
  );
}

