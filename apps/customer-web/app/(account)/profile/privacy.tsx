'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileDown, PencilLine, Trash2 } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { privacyRequestSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Form, FormError, FormField, Skeleton, Switch, Textarea, useBranding, useI18n, useToast, useZodForm, type Tone,
} from '@typease/ui';
import { LoadError, useDocumentDownload } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { ConsentPurpose, ConsentState, PrivacyRequest, PrivacyRequestType } from '@/lib/types';

const STATUS_TONE: Record<PrivacyRequest['status'], Tone> = { RECEIVED: 'info', IN_REVIEW: 'info', APPROVED: 'warning', REJECTED: 'danger', COMPLETED: 'success' };
const OFFERED: Array<{ type: PrivacyRequestType; icon: React.ReactNode }> = [
  { type: 'EXPORT', icon: <FileDown aria-hidden="true" /> },
  { type: 'CORRECTION', icon: <PencilLine aria-hidden="true" /> },
  { type: 'DELETION', icon: <Trash2 aria-hidden="true" /> },
];

/** What the centre may use the customer's data for (consents) and the customer's requests about their data. */
export function PrivacyTab() {
  return (
    <div className="max-w-3xl space-y-6">
      <Consents />
      <DataRequests />
    </div>
  );
}

// ---------------------------------------------------------------- consents

function Consents() {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const consents = useQuery({ queryKey: keys.profile.consents, queryFn: () => api.consents() });
  const save = useMutation({
    mutationFn: (change: { purpose: ConsentPurpose; granted: boolean }) => api.saveConsents({ consents: [change] }),
    onSuccess: (result, change) => {
      queryClient.setQueryData(keys.profile.consents, { consents: result.consents });
      // Marketing and WhatsApp consent mirror the profile's contact preferences.
      void queryClient.invalidateQueries({ queryKey: keys.profile.me });
      void queryClient.invalidateQueries({ queryKey: keys.notifications.preferences });
      toasts.success(change.granted ? t('my.privacy.consents.granted') : t('my.privacy.consents.withdrawn'));
    },
    onError: (error) => toasts.error(error),
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('my.privacy.consents.title')}</CardTitle>
          <CardDescription>{t('my.privacy.consents.text')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {consents.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : consents.isError ? (
          <LoadError error={consents.error} onRetry={() => void consents.refetch()} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {consents.data.consents.map((consent: ConsentState) => {
              const id = `consent-${consent.purpose}`;
              // Handling the requests themselves rests on the contract with the centre: it is not a switch.
              const required = consent.purpose === 'SERVICE_PROCESSING';
              const pending = save.isPending && save.variables?.purpose === consent.purpose;
              return (
                <li key={consent.purpose} className="flex items-start gap-4 p-4" data-consent={consent.purpose} data-granted={consent.granted}>
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-base font-medium text-foreground">{t(`my.privacy.purposes.${consent.purpose}.name`)}</span>
                    <span className="block text-sm text-muted-foreground">{t(`my.privacy.purposes.${consent.purpose}.text`)}</span>
                    {required ? (
                      <span className="mt-1 block text-sm text-muted-foreground">{t('my.privacy.consents.required')}</span>
                    ) : consent.status === 'GRANTED' && consent.grantedAt ? (
                      <span className="mt-1 block text-sm text-muted-foreground">{t('my.privacy.consents.since', { date: formatDate(consent.grantedAt) })}</span>
                    ) : consent.status === 'WITHDRAWN' && consent.withdrawnAt ? (
                      <span className="mt-1 block text-sm text-muted-foreground">{t('my.privacy.consents.withdrawnOn', { date: formatDate(consent.withdrawnAt) })}</span>
                    ) : null}
                  </label>
                  {required ? (
                    <Badge tone="neutral">{t('my.notifications.alwaysOn')}</Badge>
                  ) : (
                    <Switch id={id} checked={pending ? save.variables!.granted : consent.granted} disabled={save.isPending} onCheckedChange={(granted) => save.mutate({ purpose: consent.purpose, granted })} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-sm text-muted-foreground">
          {t('my.privacy.consents.policy')}{' '}
          <Link href={ROUTES.privacy} className="font-medium text-secondary-text underline-offset-4 hover:underline">
            {t('nav.privacy')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- data subject requests

function DataRequests() {
  const { t, formatDate } = useI18n();
  const api = usePortalApi();
  const { name } = useBranding();
  const { download, busy } = useDocumentDownload();
  const requests = useQuery({ queryKey: keys.profile.privacy, queryFn: () => api.privacyRequests() });
  const [asking, setAsking] = React.useState<PrivacyRequestType | null>(null);
  const open = new Set((requests.data ?? []).filter((r) => r.status !== 'COMPLETED' && r.status !== 'REJECTED').map((r) => r.type));

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('my.privacy.requests.title')}</CardTitle>
          <CardDescription>{t('my.privacy.requests.text', { centre: name })}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="grid gap-3 sm:grid-cols-3">
          {OFFERED.map(({ type, icon }) => (
            <li key={type} className="flex flex-col gap-2 rounded-lg border p-3.5">
              <p className="text-base font-medium text-foreground">{t(`my.privacy.types.${type}.name`)}</p>
              <p className="flex-1 text-sm text-muted-foreground">{t(`my.privacy.types.${type}.text`)}</p>
              <Button variant={type === 'DELETION' ? 'destructive-outline' : 'outline'} size="sm" disabled={open.has(type)} onClick={() => setAsking(type)} data-privacy-type={type}>
                {icon}
                {open.has(type) ? t('my.privacy.requests.alreadyOpen') : t(`my.privacy.types.${type}.action`)}
              </Button>
            </li>
          ))}
        </ul>

        {requests.isPending ? (
          <Skeleton className="h-20" />
        ) : requests.isError ? (
          <LoadError error={requests.error} onRetry={() => void requests.refetch()} />
        ) : requests.data.length ? (
          <div className="space-y-2">
            <h3 className="text-md font-semibold">{t('my.privacy.requests.yours')}</h3>
            <ul className="divide-y rounded-lg border">
              {requests.data.map((r) => (
                <li key={r.id} className="space-y-2 p-4" data-privacy-status={r.status}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="text-base font-medium">{t(`my.privacy.types.${r.type}.name`)}</p>
                    <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{t(`my.privacy.status.${r.status}`)}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('my.privacy.requests.askedOn', { date: formatDate(r.createdAt) })}
                    {r.completedAt ? (
                      <>
                        <span aria-hidden="true"> – </span>
                        {t('my.privacy.requests.completedOn', { date: formatDate(r.completedAt) })}
                      </>
                    ) : r.dueAt && r.status !== 'REJECTED' ? (
                      <>
                        <span aria-hidden="true"> – </span>
                        {t('my.privacy.requests.answerBy', { date: formatDate(r.dueAt) })}
                      </>
                    ) : null}
                  </p>
                  {r.details ? (
                    <p className="text-base text-foreground/85" dir="auto">
                      {r.details}
                    </p>
                  ) : null}
                  {r.decisionNote ? (
                    <p className="rounded-md bg-muted/60 px-3 py-2 text-base" dir="auto">
                      <span className="block text-sm font-medium text-muted-foreground">{t('my.privacy.requests.answer', { centre: name })}</span>
                      {r.decisionNote}
                    </p>
                  ) : null}
                  {r.retentionException && r.status !== 'COMPLETED' ? (
                    <Alert tone="warning">
                      <span dir="auto">{r.retentionException}</span>
                    </Alert>
                  ) : null}
                  {r.exportDocumentId ? (
                    <Button size="sm" loading={busy === r.exportDocumentId} loadingText={t('common.loading')} onClick={() => void download(r.exportDocumentId!)}>
                      <Download aria-hidden="true" />
                      {t('my.privacy.requests.downloadExport')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
      {asking ? <AskDialog type={asking} onClose={() => setAsking(null)} /> : null}
    </Card>
  );
}

function AskDialog({ type, onClose }: { type: PrivacyRequestType; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(privacyRequestSchema, { defaultValues: { type, details: '' } });
  const [already, setAlready] = React.useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            setAlready(false);
            // A correction is useless without saying what is wrong; the other requests need no explanation.
            if (type === 'CORRECTION' && (values.details ?? '').trim().length < 5) return form.setError('details', { type: 'manual', message: t('my.privacy.requests.whatIsWrongRequired') });
            try {
              await api.createPrivacyRequest({ type, details: values.details ?? undefined });
            } catch (error) {
              if (isApiError(error) && error.code === 'REQUEST_ALREADY_OPEN') {
                await queryClient.invalidateQueries({ queryKey: keys.profile.privacy });
                return setAlready(true);
              }
              throw error;
            }
            await queryClient.invalidateQueries({ queryKey: keys.profile.privacy });
            toasts.success(t('my.privacy.requests.sent'), t('my.privacy.requests.sentText'));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(`my.privacy.types.${type}.name`)}</DialogTitle>
            <DialogDescription>{t(`my.privacy.types.${type}.confirm`)}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {type === 'DELETION' ? <Alert tone="warning">{t('my.privacy.requests.deletionWarning')}</Alert> : null}
            <FormField name="details" label={type === 'CORRECTION' ? t('my.privacy.requests.whatIsWrong') : t('my.privacy.requests.details')} required={type === 'CORRECTION'} optional={type !== 'CORRECTION'}>
              {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={2000} />}
            </FormField>
            {already ? (
              <Alert tone="warning" live>
                {t('my.privacy.requests.alreadyOpenText')}
              </Alert>
            ) : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={type === 'DELETION' ? 'destructive' : 'default'} loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t(`my.privacy.types.${type}.action`)}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
