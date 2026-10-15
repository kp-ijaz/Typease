'use client';

import * as React from 'react';
import { ExternalLink, MonitorPlay, ShieldOff } from 'lucide-react';
import { displayTokenSchema } from '@typease/validation';
import { Alert, Button, ConfirmDialog, CopyButton, Form, FormError, FormField, Input, QrCode, useApi, useI18n, useToast, useZodForm } from '@typease/ui';
import { Panel, useRun } from '@/components/ops/common';
import type { DisplayLink } from '@/components/ops/types';

/**
 * Links for the public queue screen of this branch (a TV in the waiting area). A link is a signed
 * address that works without signing in and shows token numbers only. Links cannot be listed again
 * afterwards, so the address is shown once, here; revoking invalidates every link of the branch.
 */
export function DisplayLinks({ branchId }: { branchId: string }) {
  const { t, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const { run } = useRun();
  const [link, setLink] = React.useState<(DisplayLink & { url: string }) | null>(null);
  const [revoking, setRevoking] = React.useState(false);
  const form = useZodForm(displayTokenSchema, { defaultValues: { branchId, validDays: 90 } });

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <Panel title={t('ops.queue.display.createTitle')} description={t('ops.queue.display.createText')}>
        <Form
          form={form}
          onSubmit={async (values) => {
            const created = await api.client.post<DisplayLink>('/queue/display-tokens', values);
            // The screen itself is a page of this app: /queue-display?token=...
            setLink({ ...created, url: `${window.location.origin}/queue-display?token=${encodeURIComponent(created.token)}` });
            toasts.success(t('ops.queue.display.created'));
          }}
        >
          <FormField name="validDays" label={t('ops.queue.display.validDays')} hint={t('ops.queue.display.validDaysHint')} className="max-w-xs">
            {(field) => <Input {...field} type="number" min={1} max={365} inputMode="numeric" dir="ltr" className="tabular" onChange={(e) => field.onChange(e.target.value === '' ? '' : Number(e.target.value))} />}
          </FormField>
          <FormError />
          <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
            <MonitorPlay aria-hidden="true" />
            {t('ops.queue.display.create')}
          </Button>
        </Form>

        {link ? (
          <div className="mt-6 space-y-4 rounded-lg border bg-muted/30 p-4">
            <Alert tone="success" title={t('ops.queue.display.readyTitle')}>
              {t('ops.queue.display.readyText', { date: formatDate(link.expiresAt, 'long') })}
            </Alert>
            <div className="flex flex-wrap items-start gap-4">
              <QrCode value={link.url} size={132} label={t('ops.queue.display.qrLabel')} className="rounded-md border" />
              <div className="min-w-0 flex-1 basis-56 space-y-3">
                <p className="ltr-value break-all rounded-md border bg-card px-3 py-2 font-mono text-sm">{link.url}</p>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={link.url} label={t('ops.queue.display.copy')} showLabel variant="outline" />
                  <Button asChild variant="outline" size="sm">
                    <a href={link.url} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden="true" />
                      {t('ops.queue.display.open')}
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel title={t('ops.queue.display.aboutTitle')}>
        <ul className="list-disc space-y-2 ps-5 text-base text-foreground/90">
          <li>{t('ops.queue.display.about1')}</li>
          <li>{t('ops.queue.display.about2')}</li>
          <li>{t('ops.queue.display.about3')}</li>
        </ul>
        <Button variant="destructive-outline" className="mt-5" onClick={() => setRevoking(true)}>
          <ShieldOff aria-hidden="true" />
          {t('ops.queue.display.revoke')}
        </Button>
      </Panel>

      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t('ops.queue.display.revokeTitle')}
        description={t('ops.queue.display.revokeText')}
        confirmLabel={t('ops.queue.display.revoke')}
        onConfirm={async () => {
          await run('revoke', () => api.client.post('/queue/display-tokens/revoke', { branchId }), { success: t('ops.queue.display.revoked'), rethrow: true });
          setLink(null);
        }}
      />
    </div>
  );
}
