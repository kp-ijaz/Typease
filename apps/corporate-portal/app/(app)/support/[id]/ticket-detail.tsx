'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { isApiError, uploadDocument, type UploadSummary } from '@typease/api-client';
import { customerReplySchema } from '@typease/validation';
import { Alert, Button, Card, CardContent, FileUpload, Form, FormActions, FormError, FormField, PageHeader, Textarea, useApiClient, useI18n, useToast, useZodForm, type UploadItem } from '@typease/ui';
import { UPLOAD_ACCEPT, UPLOAD_ACCEPT_LABEL } from '@/components/portal/checklist';
import { FeedbackCard } from '@/components/portal/feedback';
import { DetailSkeleton, Gate, LoadError, Ltr, MessageThread, NoAccess, NotFoundCard, isForbidden, isNotFound, retryUnlessFinal, useDocumentDownload, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { TicketDetail as Ticket } from '@/lib/types';
import { TicketStatus, useCategoryLabel } from '../support-list';

/** One support conversation with the centre: the messages, a reply box while it is open, and (for employees) a rating once it is resolved. */
export function TicketDetail({ id }: { id: string }) {
  return (
    <Gate anyOf={['self.tickets']}>
      <Detail id={id} />
    </Gate>
  );
}

function Detail({ id }: { id: string }) {
  const { t, formatDate } = useI18n();
  const role = useRole();
  const api = usePortalApi();
  const categoryLabel = useCategoryLabel();
  const { download } = useDocumentDownload();
  const query = useQuery({ queryKey: keys.tickets.detail(id), queryFn: () => api.ticket(id), retry: retryUnlessFinal });

  const crumbs = [{ label: t('nav.support'), href: ROUTES.support }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.ticket')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.ticket')} />
        {isNotFound(query.error) ? (
          <NotFoundCard title={t('my.support.notFoundTitle')} text={t('my.support.notFoundText')} backHref={ROUTES.support} backLabel={t('nav.support')} />
        ) : isForbidden(query.error) ? (
          <NoAccess />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const ticket = query.data;
  const category = categoryLabel(ticket.category);
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={<span dir="auto">{ticket.subject}</span>}
        meta={<TicketStatus status={ticket.status} className="px-3 py-1 text-sm" />}
        description={
          <>
            <Ltr>{ticket.ticketNo}</Ltr>
            <span aria-hidden="true"> – </span>
            {t('my.support.openedOn', { date: formatDate(ticket.createdAt) })}
            {category ? (
              <>
                <span aria-hidden="true"> – </span>
                {category}
              </>
            ) : null}
            {ticket.requestId && ticket.requestNo ? (
              <>
                <span aria-hidden="true"> – </span>
                {t('my.support.aboutRequest')}{' '}
                <Link href={`${ROUTES.requests}/${ticket.requestId}`} className="font-medium text-secondary-text hover:underline">
                  <Ltr>{ticket.requestNo}</Ltr>
                </Link>
              </>
            ) : null}
          </>
        }
      />

      <div className="max-w-3xl space-y-5">
        {ticket.status === 'WAITING_CUSTOMER' ? <Alert tone="warning">{t('my.support.waitingText')}</Alert> : null}
        <Card>
          <CardContent>
            <MessageThread
              messages={ticket.messages.map((m) => ({ id: m.id, fromCentre: m.fromSupport, authorName: m.authorName, body: m.body, attachments: m.attachments, createdAt: m.createdAt }))}
              onOpenAttachment={(documentId) => void download(documentId)}
            />
          </CardContent>
        </Card>

        {ticket.status === 'RESOLVED' || ticket.status === 'CLOSED' ? (
          <Alert tone="success" title={ticket.status === 'CLOSED' ? t('my.support.closedTitle') : t('my.support.resolvedTitle')}>
            {ticket.resolutionSummary ? <span dir="auto">{ticket.resolutionSummary}</span> : ticket.canReply ? t('my.support.resolvedText') : null}
          </Alert>
        ) : null}

        {ticket.canReply ? (
          <ReplyForm ticket={ticket} />
        ) : (
          <Alert
            tone="info"
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={`${ROUTES.support}?new=1`}>{t('my.support.ask')}</Link>
              </Button>
            }
          >
            {t('my.support.cannotReply')}
          </Alert>
        )}

        {/* Ratings belong to a customer record: an employee has one, a company administrator does not. */}
        {ticket.feedback || (ticket.canRate && !role.company) ? (
          <Card>
            <CardContent>
              <FeedbackCard target={{ ticketId: ticket.id }} existing={ticket.feedback} canRate={ticket.canRate && !role.company} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function ReplyForm({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const client = useApiClient();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(customerReplySchema, { defaultValues: { body: '', attachments: [] } });
  const [uploads, setUploads] = React.useState(0);
  const [uploaderKey, setUploaderKey] = React.useState(0);
  const [showFiles, setShowFiles] = React.useState(false);
  return (
    <Card>
      <CardContent>
        <Form
          form={form}
          onSubmit={async (values) => {
            try {
              const next = await api.replyTicket(ticket.id, values);
              queryClient.setQueryData(keys.tickets.detail(ticket.id), next);
            } catch (error) {
              // The reopen window passed while the page was open: show the conversation as it is now.
              if (isApiError(error) && error.code === 'TICKET_CLOSED') await queryClient.invalidateQueries({ queryKey: keys.tickets.detail(ticket.id) });
              throw error;
            }
            void queryClient.invalidateQueries({ queryKey: keys.tickets.all, predicate: (q) => q.queryKey[1] !== 'detail' });
            form.reset({ body: '', attachments: [] });
            setUploaderKey((k) => k + 1);
            setShowFiles(false);
            toasts.success(t('my.support.replySent'));
          }}
        >
          <FormField name="body" label={t('my.support.reply')} required hint={ticket.status === 'RESOLVED' ? t('my.support.reopenHint') : undefined}>
            {(field) => <Textarea {...field} rows={4} dir="auto" maxLength={5000} />}
          </FormField>
          {showFiles ? (
            <FileUpload<UploadSummary>
              key={uploaderKey}
              multiple
              maxFiles={5}
              accept={UPLOAD_ACCEPT}
              acceptLabel={UPLOAD_ACCEPT_LABEL}
              capture="environment"
              // Filed in the vault of whoever replies (the company's for an administrator, their own for an employee).
              upload={(file, o) => uploadDocument(client, { file, documentTypeKey: 'other', title: file.name, ...o })}
              onFilesChange={(items: Array<UploadItem<UploadSummary>>) => {
                setUploads(items.filter((i) => i.status === 'uploading' || i.status === 'queued').length);
                form.setValue('attachments', items.filter((i) => i.status === 'done' && i.result).map((i) => i.result!.documentId));
              }}
            />
          ) : null}
          <FormError />
          <FormActions className="sm:justify-between">
            {showFiles ? <span /> : (
              <Button variant="outline" onClick={() => setShowFiles(true)}>
                {t('my.support.attach')}
              </Button>
            )}
            <Button type="submit" disabled={uploads > 0} loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              <Send className="rtl-mirror" aria-hidden="true" />
              {t('my.support.sendReply')}
            </Button>
          </FormActions>
        </Form>
      </CardContent>
    </Card>
  );
}
