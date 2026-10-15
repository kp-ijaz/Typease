'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Eye, FileWarning, LifeBuoy, PencilLine, ScrollText, ShieldCheck, ShieldX } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, CardContent, Checkbox, ChoiceLabel, ConfirmDialog, DataTable, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, PermissionGate, Select, Skeleton, Textarea, cn, useApi, useI18n, useSession, useToast, type DataTableColumn, type DataTableFilter, type Tone,
} from '@typease/ui';
import { usePermissionText } from '@/components/adm/permissions';
import { ActionError, Field, LoadError } from '@/components/adm/shared';
import type { SupportGrant } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

type GrantPage = Page<SupportGrant> & { pending: number };
const STATUS_TONE: Record<string, Tone> = { REQUESTED: 'warning', APPROVED: 'success', DENIED: 'neutral', REVOKED: 'neutral', EXPIRED: 'neutral' };
const DURATIONS = [15, 30, 60, 120, 240, 480, 1440];

function useDuration(): (minutes: number) => string {
  const { tn } = useI18n();
  return React.useCallback((minutes) => (minutes >= 60 && minutes % 60 === 0 ? tn('adm.settings.support.hours', minutes / 60) : tn('adm.settings.support.minutes', minutes)), [tn]);
}

/** The one thing a support session may write today is an internal note on a request; anything else that is not read-only is named generally. */
const NOTES_SCOPE = 'request.comment.internal';

/**
 * Where the centre's audit log shows what was done under a grant. The audit page filters by "TypEase support"
 * and by day; the grant id is passed along for the day the page can filter on it as well.
 */
function useAuditHref(): (grant: SupportGrant) => string {
  const timeZone = useSession().tenant?.timezone ?? 'Asia/Dubai';
  return React.useCallback(
    (grant) => {
      const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      const params = new URLSearchParams({ supportAccess: 'true', supportGrantId: grant.id, from: day(grant.startsAt ?? grant.createdAt), to: day(grant.revokedAt ?? grant.expiresAt ?? grant.decidedAt ?? grant.createdAt) });
      return `/audit-log?${params.toString()}`;
    },
    [timeZone],
  );
}

/** What a request asks for, line by line, each marked "read only" or with what it lets TypEase support change. */
function ScopeList({ grant, summary }: { grant: SupportGrant; summary?: boolean }) {
  const { t } = useI18n();
  const text = usePermissionText();
  const writes = grant.scopes.filter((s) => s.write);
  return (
    <>
      <ul className="mt-1.5 space-y-1.5">
        {grant.scopes.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
            <span>{text.describe(s)}</span>
            {s.write ? (
              <Badge tone="warning" icon={<PencilLine />}>
                {s.key === NOTES_SCOPE ? t('adm.settings.support.canAddNotes') : t('adm.settings.support.canChange')}
              </Badge>
            ) : (
              <Badge tone="neutral" icon={<Eye />}>
                {t('adm.settings.support.readOnly')}
              </Badge>
            )}
            {s.key === 'document.read' ? (
              <Badge tone="warning" icon={<FileWarning />}>
                {t('adm.settings.support.documents')}
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
      {summary ? <p className={cn('mt-2 text-sm', writes.length ? 'font-medium text-warning-text' : 'text-muted-foreground')}>{writes.length ? t('adm.settings.support.writeSummary') : t('adm.settings.support.readOnlySummary')}</p> : null}
    </>
  );
}

/**
 * TypEase staff have no access to a centre's data. They ask (reason, scopes, duration); the centre approves
 * or denies here, sees what is running and can end it at once. Requests that wait carry the warning colour;
 * `focusGrantId` (from a link that names one request) marks that request and brings it into view.
 */
export function SupportAccessTab({ focusGrantId }: { focusGrantId?: string | null }) {
  const { t, formatDateTime, formatRelative } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const duration = useDuration();
  const auditHref = useAuditHref();
  const waiting = useQuery({ queryKey: [...admKeys.supportAccess.all, 'waiting'], queryFn: () => api.client.get<GrantPage>('/support-access', { query: { status: 'REQUESTED', pageSize: 50 } }), refetchInterval: 60_000 });
  const running = useQuery({ queryKey: [...admKeys.supportAccess.all, 'running'], queryFn: () => api.client.get<GrantPage>('/support-access', { query: { status: 'APPROVED', pageSize: 50 } }), refetchInterval: 60_000 });
  const [approving, setApproving] = React.useState<SupportGrant | null>(null);
  const [denying, setDenying] = React.useState<SupportGrant | null>(null);
  const [revoking, setRevoking] = React.useState<SupportGrant | null>(null);
  const [revokeError, setRevokeError] = React.useState<unknown>(null);

  const mayAudit = useSession().hasPermission('audit.read');
  const active = (running.data?.data ?? []).filter((g) => g.active);
  const refresh = () => queryClient.invalidateQueries({ queryKey: admKeys.supportAccess.all });

  // A link that names one request ("/settings?tab=support&grant=<id>") brings that request into view, once.
  const waitingRef = React.useRef<HTMLElement>(null);
  const arrived = React.useRef(false);
  const waitingCount = waiting.data?.data.length ?? 0;
  React.useEffect(() => {
    if (arrived.current || !waitingCount || !focusGrantId) return;
    arrived.current = true;
    waitingRef.current?.querySelector<HTMLElement>(`[data-grant="${CSS.escape(focusGrantId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [waitingCount, focusGrantId]);

  const columns: Array<DataTableColumn<SupportGrant>> = [
    { id: 'who', header: t('adm.settings.support.columns.who'), mobile: 'title', cell: (g) => g.requestedByName },
    { id: 'reason', header: t('adm.settings.support.columns.reason'), cell: (g) => <span className="line-clamp-2 max-w-md whitespace-normal" dir="auto" title={g.reason}>{g.reason}</span> },
    { id: 'status', header: t('adm.settings.support.columns.status'), mobile: 'badge', cell: (g) => <Badge tone={g.active ? 'success' : (STATUS_TONE[g.status] ?? 'neutral')}>{g.status === 'APPROVED' && !g.active ? t('adm.settings.support.status.EXPIRED') : t(`adm.settings.support.status.${g.status}`)}</Badge> },
    { id: 'asked', header: t('adm.settings.support.columns.asked'), className: 'whitespace-nowrap tabular', cell: (g) => formatDateTime(g.createdAt) },
    { id: 'scopes', header: t('adm.settings.support.columns.scopes'), mobile: 'hidden', cell: (g) => (g.scopes.some((x) => x.write) ? <Badge tone="warning" icon={<PencilLine />}>{g.scopes.some((x) => x.write && x.key !== NOTES_SCOPE) ? t('adm.settings.support.canChange') : t('adm.settings.support.canAddNotes')}</Badge> : <Badge tone="neutral" icon={<Eye />}>{t('adm.settings.support.readOnly')}</Badge>) },
    { id: 'window', header: t('adm.settings.support.columns.window'), className: 'tabular', cell: (g) => <span className="whitespace-normal">{g.startsAt ? `${formatDateTime(g.startsAt)} – ${formatDateTime(g.revokedAt ?? g.expiresAt)}` : duration(g.durationMinutes)}</span> },
    { id: 'note', header: t('adm.settings.support.columns.note'), mobile: 'hidden', cell: (g) => (g.decisionNote ? <span className="line-clamp-2 max-w-xs whitespace-normal" dir="auto" title={g.decisionNote}>{g.decisionNote}</span> : null) },
    ...(mayAudit
      ? [
          {
            id: 'audit',
            header: t('adm.settings.support.columns.audit'),
            cell: (g: SupportGrant) =>
              g.startsAt ? (
                <Link href={auditHref(g)} className="whitespace-nowrap text-secondary-text underline-offset-4 hover:underline">
                  {t('adm.settings.support.viewAuditShort')}
                </Link>
              ) : null,
          } satisfies DataTableColumn<SupportGrant>,
        ]
      : []),
  ];
  const filters: DataTableFilter[] = [
    { id: 'status', type: 'select', label: t('adm.settings.support.columns.status'), options: ['REQUESTED', 'APPROVED', 'DENIED', 'REVOKED', 'EXPIRED'].map((s) => ({ value: s, label: t(`adm.settings.support.status.${s}`) })) },
  ];

  return (
    <div className="space-y-8">
      <Alert tone="info" title={t('adm.settings.support.introTitle')}>
        {t('adm.settings.support.intro')}
      </Alert>

      <section aria-labelledby="support-waiting" ref={waitingRef} className="scroll-mt-24">
        <h2 id="support-waiting" className="mb-3 text-lg font-semibold">
          {t('adm.settings.support.waitingTitle')}
        </h2>
        {waiting.isPending ? (
          <Skeleton className="h-40" />
        ) : waiting.isError ? (
          <LoadError error={waiting.error} onRetry={() => void waiting.refetch()} />
        ) : waiting.data.data.length === 0 ? (
          <Card>
            <EmptyState icon={<LifeBuoy />} title={t('adm.settings.support.noneWaitingTitle')} description={t('adm.settings.support.noneWaitingText')} />
          </Card>
        ) : (
          <ul className="space-y-4">
            {waiting.data.data.map((g) => (
              <li key={g.id} data-grant={g.id} className="scroll-mt-24">
                {/* A request that waits is the one thing on this tab that needs the owner: it carries the warning colour. */}
                <Card className={cn('border-warning/60 ring-1 ring-warning/30', focusGrantId === g.id && 'ring-2 ring-warning')}>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-md font-semibold">{t('adm.settings.support.asks', { name: g.requestedByName })}</p>
                        <p className="text-sm text-muted-foreground">{t('adm.settings.support.askedAt', { time: formatDateTime(g.createdAt) })}</p>
                      </div>
                      <Badge tone="warning">{t('adm.settings.support.status.REQUESTED')}</Badge>
                    </div>
                    <dl className="grid gap-x-8 gap-y-4 md:grid-cols-3">
                      <div className="md:col-span-1">
                        <dt className="text-sm text-muted-foreground">{t('adm.settings.support.reason')}</dt>
                        <dd className="mt-1 text-base" dir="auto">
                          {g.reason}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted-foreground">{t('adm.settings.support.wants')}</dt>
                        <dd>
                          <ScopeList grant={g} summary />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted-foreground">{t('adm.settings.support.howLong')}</dt>
                        <dd className="mt-1 text-base">{t('adm.settings.support.howLongText', { duration: duration(g.durationMinutes) })}</dd>
                      </div>
                    </dl>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <Button variant="outline" onClick={() => setDenying(g)}>
                        <ShieldX aria-hidden="true" />
                        {t('adm.settings.support.deny')}
                      </Button>
                      <Button onClick={() => setApproving(g)}>
                        <ShieldCheck aria-hidden="true" />
                        {t('adm.settings.support.approve')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="support-active">
        <h2 id="support-active" className="mb-3 text-lg font-semibold">
          {t('adm.settings.support.activeTitle')}
        </h2>
        {running.isPending ? (
          <Skeleton className="h-24" />
        ) : running.isError ? (
          <LoadError error={running.error} onRetry={() => void running.refetch()} />
        ) : active.length === 0 ? (
          <p className="rounded-lg border bg-card px-5 py-4 text-base text-muted-foreground">{t('adm.settings.support.noneActive')}</p>
        ) : (
          <ul className="space-y-4">
            {active.map((g) => (
              <li key={g.id}>
                <Card className="border-success/40">
                  <CardContent className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <p className="text-md font-semibold">{t('adm.settings.support.hasAccess', { name: g.requestedByName })}</p>
                      <p className="flex items-center gap-2 text-base">
                        <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        {t('adm.settings.support.endsAt', { time: formatDateTime(g.expiresAt), relative: formatRelative(g.expiresAt) })}
                      </p>
                      <ScopeList grant={g} />
                      <PermissionGate permission="audit.read">
                        <Button asChild variant="link">
                          <Link href={auditHref(g)}>
                            <ScrollText aria-hidden="true" />
                            {t('adm.settings.support.viewAudit')}
                          </Link>
                        </Button>
                      </PermissionGate>
                    </div>
                    <Button
                      variant="destructive-outline"
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(g);
                      }}
                    >
                      {t('adm.settings.support.revoke')}
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="support-history">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <h2 id="support-history" className="text-lg font-semibold">
              {t('adm.settings.support.historyTitle')}
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{t('adm.settings.support.auditText')}</p>
          </div>
          <PermissionGate permission="audit.read">
            <Button asChild variant="outline" size="sm">
              <Link href="/audit-log?supportAccess=true">
                <ScrollText aria-hidden="true" />
                {t('adm.settings.support.viewAllAudit')}
              </Link>
            </Button>
          </PermissionGate>
        </div>
        <DataTable<SupportGrant>
          caption={t('adm.settings.support.historyTitle')}
          queryKey={[...admKeys.supportAccess.all, 'history']}
          queryFn={(params, signal) => api.client.get<GrantPage>('/support-access', { query: params, signal })}
          columns={columns}
          rowKey={(g) => g.id}
          filters={filters}
          searchable={false}
          syncUrl={false}
          defaultPageSize={10}
          empty={{ icon: <LifeBuoy />, title: t('adm.settings.support.historyEmptyTitle'), description: t('adm.settings.support.historyEmptyText') }}
        />
      </section>

      <DecisionDialog kind="approve" grant={approving} onClose={() => setApproving(null)} onDone={refresh} />
      <DecisionDialog kind="deny" grant={denying} onClose={() => setDenying(null)} onDone={refresh} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('adm.settings.support.revokeTitle', { name: revoking?.requestedByName ?? '' })}
        description={t('adm.settings.support.revokeText')}
        confirmLabel={t('adm.settings.support.revoke')}
        onConfirm={async () => {
          if (!revoking) return;
          setRevokeError(null);
          try {
            await api.client.post(`/support-access/${revoking.id}/revoke`, {});
            toasts.success(t('adm.settings.support.revoked'), revoking.requestedByName);
            await refresh();
          } catch (error) {
            setRevokeError(error);
            throw error;
          }
        }}
      >
        {revokeError ? <ActionError error={revokeError} /> : null}
      </ConfirmDialog>
    </div>
  );
}

/** Approve (optionally with fewer scopes and a shorter time: never more) or deny, with a note for TypEase. */
function DecisionDialog({ kind, grant, onClose, onDone }: { kind: 'approve' | 'deny'; grant: SupportGrant | null; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const duration = useDuration();
  const text = usePermissionText();
  const id = React.useId();
  const [note, setNote] = React.useState('');
  const [scopeKeys, setScopeKeys] = React.useState<string[]>([]);
  const [minutes, setMinutes] = React.useState(60);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!grant) return;
    setNote('');
    setScopeKeys(grant.scopes.map((s) => s.key));
    setMinutes(grant.durationMinutes);
    setError(null);
  }, [grant]);

  const submit = async () => {
    if (!grant) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') {
        await api.client.post(`/support-access/${grant.id}/approve`, { note: note.trim() || undefined, scopes: scopeKeys, durationMinutes: minutes });
        toasts.success(t('adm.settings.support.approved'), t('adm.settings.support.approvedText', { name: grant.requestedByName, duration: duration(minutes) }));
      } else {
        await api.client.post(`/support-access/${grant.id}/deny`, { note: note.trim() || undefined });
        toasts.success(t('adm.settings.support.denied'), grant.requestedByName);
      }
      await onDone();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const durations = grant ? [...new Set([...DURATIONS.filter((d) => d < grant.durationMinutes), grant.durationMinutes])] : [];

  return (
    <Dialog open={!!grant} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'approve' ? t('adm.settings.support.approveTitle', { name: grant?.requestedByName ?? '' }) : t('adm.settings.support.denyTitle', { name: grant?.requestedByName ?? '' })}</DialogTitle>
          <DialogDescription>{kind === 'approve' ? t('adm.settings.support.approveText') : t('adm.settings.support.denyText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {kind === 'approve' && grant ? (
            <>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t('adm.settings.support.allow')}</legend>
                {grant.scopes.map((s) => (
                  <ChoiceLabel
                    key={s.key}
                    htmlFor={`${id}-${s.key}`}
                    control={<Checkbox id={`${id}-${s.key}`} checked={scopeKeys.includes(s.key)} onCheckedChange={(c) => setScopeKeys(c === true ? [...scopeKeys, s.key] : scopeKeys.filter((k) => k !== s.key))} />}
                    label={text.describe(s)}
                    description={
                      s.write ? (
                        <span className="font-medium text-warning-text">{s.key === NOTES_SCOPE ? t('adm.settings.support.notesHint') : t('adm.settings.support.canChangeHint')}</span>
                      ) : s.key === 'document.read' ? (
                        t('adm.settings.support.documentsHint')
                      ) : (
                        t('adm.settings.support.readOnly')
                      )
                    }
                  />
                ))}
              </fieldset>
              <Field label={t('adm.settings.support.duration')} htmlFor={`${id}-duration`} hint={t('adm.settings.support.durationHint')}>
                <Select id={`${id}-duration`} value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))} options={durations.map((d) => ({ value: String(d), label: duration(d) }))} />
              </Field>
            </>
          ) : null}
          <Field label={t('adm.settings.support.note')} htmlFor={`${id}-note`} hint={t('adm.settings.support.noteHint')}>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
          </Field>
          <ActionError error={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant={kind === 'deny' ? 'destructive' : 'default'} onClick={() => void submit()} disabled={kind === 'approve' && scopeKeys.length === 0} loading={busy} loadingText={t('common.saving')}>
            {kind === 'approve' ? t('adm.settings.support.approveConfirm') : t('adm.settings.support.deny')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
