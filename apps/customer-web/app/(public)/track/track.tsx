'use client';

import * as React from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { isApiError, type PublicTrackingResult } from '@typease/api-client';
import {
  Alert, Button, Card, CardContent, DescriptionList, Form, FormError, FormField, Input, StatusBadge, Timeline, useApi, useBranding, useI18n, useZodForm,
} from '@typease/ui';
import { PublicPage } from '@/components/public-shell';
import { ROUTES } from '@/lib/config';

/** Same rules as the API's public tracking body; the code is typed with or without its dash. */
const schema = z.object({
  requestNo: z.string().trim().toUpperCase().min(3).max(30),
  trackingCode: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().length(10, 'TRACKING_CODE_LENGTH'))
    .transform((v) => `${v.slice(0, 5)}-${v.slice(5)}`),
});

export function TrackRequest({ initialNo, initialCode }: { initialNo: string; initialCode: string }) {
  const { t, pick, formatDate, formatDateTime } = useI18n();
  const api = useApi();
  const { config } = useBranding();
  const form = useZodForm(schema, { defaultValues: { requestNo: initialNo, trackingCode: initialCode } });
  const [result, setResult] = React.useState<PublicTrackingResult | null>(null);
  const [notFound, setNotFound] = React.useState(false);

  if (result) {
    const current = result.timeline.length - 1;
    return (
      <PublicPage narrow title={<span className="tabular">{result.requestNo}</span>} description={pick(result.service.name, result.service.nameAr)}>
        <Card>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge kind="request" status={result.status} label={result.statusLabel} className="px-3 py-1 text-sm" />
            </div>
            <DescriptionList
              items={[
                { label: t('track.submitted'), value: formatDate(result.submittedAt) },
                { label: t('track.completed'), value: result.completedAt ? formatDate(result.completedAt) : null },
              ]}
            />
            {result.externalStatus ? (
              <Alert tone="info" title={t('track.externalStatus')}>
                {result.externalStatus.status}
                {/* A status typed by staff is never presented as official: its source is always shown. */}
                <span className="mt-1 block text-sm text-muted-foreground">{pick(result.externalStatus.sourceLabel.en, result.externalStatus.sourceLabel.ar)}</span>
              </Alert>
            ) : null}
            <section aria-labelledby="history-h">
              <h2 id="history-h" className="mb-4 text-md font-semibold">
                {t('track.history')}
              </h2>
              <Timeline
                items={result.timeline.map((entry, index) => ({
                  id: `${entry.status}-${entry.at}`,
                  title: pick(entry.statusLabel.en, entry.statusLabel.ar),
                  time: formatDateTime(entry.at),
                  state: index === current && !result.completedAt ? 'current' : 'done',
                }))}
              />
            </section>
          </CardContent>
        </Card>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setResult(null);
              form.reset({ requestNo: '', trackingCode: '' });
            }}
          >
            {t('track.another')}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t('track.loginHint')}{' '}
            <Link href={ROUTES.login} className="font-medium text-secondary-text underline-offset-4 hover:underline">
              {t('nav.login')}
            </Link>
          </p>
        </div>
      </PublicPage>
    );
  }

  return (
    <PublicPage narrow title={t('track.title')} description={t('track.description')}>
      <Card className="max-w-xl">
        <CardContent>
          <Form
            form={form}
            onSubmit={async (values) => {
              setNotFound(false);
              try {
                setResult(await api.public.track({ ...values, tenantSlug: config?.slug }));
              } catch (error) {
                // The API answers the same 404 for a wrong number, a wrong code and another centre's request.
                if (isApiError(error) && error.status === 404) return setNotFound(true);
                throw error;
              }
            }}
          >
            <FormField name="requestNo" label={t('track.requestNo')} required hint={t('track.requestNoHint')}>
              {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" autoFocus />}
            </FormField>
            <FormField name="trackingCode" label={t('track.trackingCode')} required hint={t('track.trackingCodeHint')}>
              {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" />}
            </FormField>
            {notFound ? (
              <Alert tone="warning" live>
                {t('track.notFound')}
              </Alert>
            ) : null}
            <FormError />
            <Button type="submit" size="lg" className="w-full sm:w-auto" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('track.submit')}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </PublicPage>
  );
}
