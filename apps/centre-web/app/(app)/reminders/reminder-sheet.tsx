'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Link2, Pause, Pencil, Play, XCircle } from 'lucide-react';
import {
  Alert, Button, ConfirmDialog, CopyButton, DescriptionList, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, Timeline, cn, focusRing, useApi, useI18n,
  useSession, type Tone,
} from '@typease/ui';
import { Loadable, OpsStatusBadge, useRun } from '@/components/ops/common';
import type { Reminder } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const DISPATCH_TONE: Record<string, Tone | undefined> = { FAILED: 'danger', SKIPPED_NO_CONSENT: 'warning', SKIPPED_OPT_OUT: 'warning' };

/** One schedule: whose document, when it expires, what was sent or skipped (and why), and what can be done. */
export function ReminderSheet({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (reminder: Reminder) => void }) {
  const { t, tn, pick, formatDate, formatDateTime, formatNumber } = useI18n();
  const api = useApi();
  const session = useSession();
  const canManage = session.hasPermission('reminder.manage');
  const { run, busy } = useRun();
  const [cancelling, setCancelling] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const reminder = useQuery({ queryKey: opsKeys.reminders.detail(id ?? ''), queryFn: () => api.client.get<Reminder>(`/reminders/${id}`), enabled: !!id });
  const invalidate = [opsKeys.reminders.all];

  React.useEffect(() => setLink(null), [id]);

  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('ops.reminders.detailTitle')}</SheetTitle>
          <SheetDescription>{reminder.data ? pick(reminder.data.documentTypeName, reminder.data.documentTypeNameAr) : t('common.loading')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {id ? (
            <Loadable query={reminder} skeleton={<Skeleton className="h-72 w-full" />}>
              {(r) => {
                const open = r.status === 'ACTIVE' || r.status === 'PAUSED';
                return (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <OpsStatusBadge kind="reminder" status={r.status} />
                      <span className={cn('text-sm', r.daysLeft <= 30 && open ? 'font-medium text-warning-text' : 'text-muted-foreground')}>
                        {r.daysLeft < 0 ? t('ops.reminders.expired') : r.daysLeft === 0 ? t('ops.reminders.expiresToday') : tn('ops.reminders.daysLeft', r.daysLeft)}
                      </span>
                    </div>
                    <DescriptionList
                      columns={1}
                      items={[
                        { label: t('ops.reminders.columns.subject'), value: <span dir="auto">{r.subjectLabel}</span> },
                        ...(r.customerId
                          ? [{ label: t('ops.common.customer'), value: <Link href={`/customers/${r.customerId}`} className={cn('rounded-sm text-secondary-text hover:underline', focusRing)}>{r.customerName} <span className="tabular text-sm text-muted-foreground">{r.customerNo}</span></Link> }]
                          : []),
                        ...(r.corporateAccountId ? [{ label: t('ops.common.company'), value: <Link href={`/corporate/${r.corporateAccountId}`} className={cn('rounded-sm text-secondary-text hover:underline', focusRing)}>{r.corporateName}</Link> }] : []),
                        { label: t('ops.reminders.columns.expiry'), value: <span className="tabular">{formatDate(r.expiryDate, 'long')}</span> },
                        { label: t('ops.reminders.columns.offsets'), value: t('ops.reminders.offsetsLine', { list: r.offsetsDays.map((d) => formatNumber(d)).join(', ') }) },
                        { label: t('ops.reminders.columns.next'), value: r.status === 'ACTIVE' && r.nextReminderOn ? formatDate(r.nextReminderOn, 'long') : null },
                        ...(r.documentId ? [{ label: t('ops.reminders.document'), value: <Link href={`/documents/${r.documentId}`} className="text-secondary-text hover:underline">{t('ops.reminders.openDocument')}</Link> }] : []),
                        ...(r.renewalRequestId ? [{ label: t('ops.reminders.renewalRequest'), value: <Link href={`/requests/${r.renewalRequestId}`} className="text-secondary-text hover:underline">{t('ops.reminders.openRequest')}</Link> }] : []),
                      ]}
                    />

                    {canManage && open ? (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => onEdit(r)}>
                          <Pencil aria-hidden="true" />
                          {t('common.edit')}
                        </Button>
                        {r.status === 'ACTIVE' ? (
                          <Button variant="outline" size="sm" loading={busy === 'pause'} onClick={() => void run('pause', () => api.client.post(`/reminders/${r.id}/pause`), { success: t('ops.reminders.paused'), description: t('ops.reminders.pausedText'), invalidate })}>
                            <Pause aria-hidden="true" />
                            {t('ops.reminders.pause')}
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" loading={busy === 'resume'} onClick={() => void run('resume', () => api.client.post(`/reminders/${r.id}/resume`), { success: t('ops.reminders.resumed'), invalidate })}>
                            <Play aria-hidden="true" />
                            {t('ops.reminders.resume')}
                          </Button>
                        )}
                        <Button variant="destructive-outline" size="sm" onClick={() => setCancelling(true)}>
                          <XCircle aria-hidden="true" />
                          {t('ops.reminders.cancel')}
                        </Button>
                      </div>
                    ) : null}

                    <section className="space-y-2">
                      <h3 className="text-md font-semibold">{t('ops.reminders.renewalTitle')}</h3>
                      <p className="text-sm text-muted-foreground">{t('ops.reminders.renewalText')}</p>
                      {link ? (
                        <div className="flex items-start gap-2">
                          <p className="ltr-value min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">{link}</p>
                          <CopyButton value={link} label={t('ops.reminders.copyLink')} variant="outline" />
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busy === 'link'}
                          onClick={() => void run('link', () => api.client.post<{ link: string }>(`/reminders/${r.id}/renewal-link`)).then((result) => result && setLink(result.link))}
                        >
                          <Link2 aria-hidden="true" />
                          {t('ops.reminders.renewalLink')}
                        </Button>
                      )}
                    </section>

                    <section className="space-y-3">
                      <h3 className="text-md font-semibold">{t('ops.reminders.historyTitle')}</h3>
                      {(r.dispatches ?? []).length === 0 ? (
                        <Alert tone="info">{t('ops.reminders.historyEmpty')}</Alert>
                      ) : (
                        <Timeline
                          items={(r.dispatches ?? []).map((d) => ({
                            id: d.id,
                            title: (
                              <span className="flex flex-wrap items-center gap-2">
                                {d.offsetDays === 0 ? t('ops.reminders.onTheDay') : tn('ops.reminders.daysBefore', d.offsetDays)}
                                <OpsStatusBadge kind="dispatch" status={d.status} />
                              </span>
                            ),
                            time: d.processedAt ? formatDateTime(d.processedAt) : t('ops.reminders.dueOn', { date: formatDate(d.dueOn) }),
                            description: (
                              <>
                                {d.status === 'SKIPPED_NO_CONSENT' ? <p>{t('ops.reminders.reason.noConsent')}</p> : null}
                                {d.status === 'SKIPPED_OPT_OUT' ? <p>{t('ops.reminders.reason.optOut')}</p> : null}
                                {d.detail ? <p className="text-muted-foreground" dir="auto">{d.detail}</p> : null}
                              </>
                            ),
                            state: d.status === 'SENT' ? 'done' : 'current',
                            tone: DISPATCH_TONE[d.status],
                          }))}
                        />
                      )}
                    </section>
                  </>
                );
              }}
            </Loadable>
          ) : null}
        </SheetBody>
      </SheetContent>
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('ops.reminders.cancelTitle')}
        description={t('ops.reminders.cancelText')}
        confirmLabel={t('ops.reminders.cancel')}
        onConfirm={async () => {
          await run('cancel', () => api.client.post(`/reminders/${id}/cancel`, {}), { success: t('ops.reminders.cancelled'), invalidate, rethrow: true });
        }}
      />
    </Sheet>
  );
}
