'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { platformTicketReplySchema } from '@typease/validation';
import { Alert, Button, Card, Form, FormError, FormField, PageHeader, PageSkeleton, RequirePermission, StatusBadge, Textarea, useApi, useErrorMessage, useI18n, useToast, useZodForm } from '@typease/ui';
import { Conversation } from '@/components/ops/conversation';
import type { PlatformTicket } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

export function PlatformTicketPage({ id }: { id: string }) {
  return (
    <RequirePermission anyOf={['settings.manage', 'ticket.manage']}>
      <PlatformTicketView id={id} />
    </RequirePermission>
  );
}

function PlatformTicketView({ id }: { id: string }) {
  const { t, formatDateTime } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const ticket = useQuery({ queryKey: opsKeys.platformTickets.detail(id), queryFn: () => api.client.get<PlatformTicket>(`/support/platform-tickets/${id}`), retry: (count, error) => !(isApiError(error) && error.status === 404) && count < 2 });
  const form = useZodForm(platformTicketReplySchema, { defaultValues: { body: '' } });
  const crumbs = [
    { label: t('ops.support.title'), href: '/support' },
    { label: t('ops.support.platform.title'), href: '/support/platform' },
  ];

  if (ticket.isPending) return <PageSkeleton label={t('common.loading')} />;
  if (ticket.isError) {
    return (
      <>
        <PageHeader title={t('ops.support.platform.ticket')} breadcrumbs={crumbs} />
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={() => void ticket.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {describe(ticket.error)}
        </Alert>
      </>
    );
  }
  const data = ticket.data;

  return (
    <>
      <PageHeader
        title={<span dir="auto">{data.subject}</span>}
        breadcrumbs={crumbs}
        description={
          <>
            <span className="tabular">{data.ticketNo}</span> · {t('ops.support.openedOn', { date: formatDateTime(data.createdAt) })}
            {data.category ? ` · ${data.category}` : ''}
          </>
        }
        meta={
          <>
            <StatusBadge kind="ticket" status={data.status} label={data.status === 'WAITING_CUSTOMER' ? { en: t('ops.support.platform.waitingForYou'), ar: t('ops.support.platform.waitingForYou') } : undefined} />
            {data.priority === 'HIGH' || data.priority === 'URGENT' ? <StatusBadge kind="priority" status={data.priority} /> : null}
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4">
        <Card className="p-4 sm:p-5">
          <Conversation
            usLabel={t('ops.support.platform.you')}
            themLabel={t('ops.support.platform.agent')}
            messages={(data.messages ?? []).map((m) => ({ id: m.id, side: m.fromSupport ? 'them' : 'us', authorName: m.fromSupport ? m.authorName ?? t('ops.support.platform.agent') : m.authorName, body: m.body, createdAt: m.createdAt }))}
          />
          {data.resolutionSummary ? (
            <Alert tone="success" className="mt-4" title={t('ops.support.resolution')}>
              <span dir="auto">{data.resolutionSummary}</span>
            </Alert>
          ) : null}
        </Card>
        {data.canReply ? (
          <Card className="p-4 sm:p-5">
            <Form
              form={form}
              onSubmit={async (values) => {
                await api.client.post(`/support/platform-tickets/${id}/messages`, values);
                toasts.success(t('ops.support.platform.replySent'));
                form.reset({ body: '' });
                await queryClient.invalidateQueries({ queryKey: opsKeys.platformTickets.all });
              }}
            >
              <FormField name="body" label={t('ops.support.platform.reply')} required>
                {(field) => <Textarea {...field} rows={4} dir="auto" />}
              </FormField>
              <FormError />
              <div className="flex justify-end">
                <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
                  <Send className="rtl-mirror" aria-hidden="true" />
                  {t('ops.support.platform.sendReply')}
                </Button>
              </div>
            </Form>
          </Card>
        ) : (
          <Alert tone="info">{t('ops.support.platform.closedNote')}</Alert>
        )}
      </div>
    </>
  );
}
