'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, ExternalLink, KeyRound, ShieldAlert, XCircle } from 'lucide-react';
import {
  Alert, Badge, Button, DataTable, DescriptionList, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Skeleton, Timeline, useI18n, useSession, useToast,
  type DataTableColumn, type DataTableFilter, type RowAction, type TimelineItem,
} from '@typease/ui';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import { SENSITIVE_SCOPES, scopeKey } from '@/lib/scopes';
import type { AccessGrant, AccessGrantStatus } from '@/lib/types';
import { AccessStatusBadge, accessState } from './access-status';
import { useDurationLabel, useScopeLabel } from './request-access-dialog';
import { CentreCell, ConfirmAction, LoadError, TextLink } from './shared';

const STATUSES: AccessGrantStatus[] = ['REQUESTED', 'APPROVED', 'DENIED', 'REVOKED', 'EXPIRED'];

/**
 * "Enter centre": for the requester of an approved, current grant. POST .../enter answers with a
 * one-time hand-off URL (the code is in its fragment, valid 60 seconds, usable once); the console
 * opens it in a new tab and keeps nothing of the answer. The tab must be opened synchronously in
 * the click, before the request, or browsers block it: it is opened blank and then pointed at the URL.
 */
export function useEnterCentre() {
  const { t } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState<string | null>(null);
  const canEnter = React.useCallback((grant: AccessGrant) => accessState(grant) === 'ACTIVE' && grant.requestedById === session.user?.id, [session.user?.id]);
  const enter = React.useCallback(
    async (grant: AccessGrant) => {
      // A window opened with "noopener" is not returned, so the link to this window is cut by hand instead.
      const tab = window.open('', '_blank');
      if (tab) tab.opener = null;
      setBusy(grant.id);
      try {
        const { handoff } = await api.access.enter(grant.id);
        if (tab) {
          tab.location.href = handoff.url;
          toasts.success(t('access.enter.opened'), t('access.enter.openedText'));
        } else {
          toasts.error(t('access.enter.blocked'), t('access.enter.blockedText'));
        }
      } catch (error) {
        tab?.close();
        toasts.error(error);
      } finally {
        setBusy(null);
        // Entering is on the centre's audit trail and may change what the grant looks like.
        await queryClient.invalidateQueries({ queryKey: keys.access.all });
      }
    },
    [api, toasts, t, queryClient],
  );
  return { canEnter, enter, busy };
}

/** Who may withdraw a request or end an access early: the person who asked, or a super admin for anyone. */
function useCanRevoke(): (grant: AccessGrant) => boolean {
  const session = useSession();
  return React.useCallback(
    (grant: AccessGrant) => {
      const state = accessState(grant);
      return (state === 'REQUESTED' || state === 'ACTIVE') && (grant.requestedById === session.user?.id || session.user?.platformRole === 'SUPER_ADMIN');
    },
    [session.user?.id, session.user?.platformRole],
  );
}

/**
 * Support access requests (GET /platform/access-grants): who asked which centre for what,
 * why, for how long, and what the centre decided. `centreId` narrows the list to one centre;
 * without `platform.audit.read` only the signed-in person's own requests exist for the API.
 */
export function AccessTable({ centreId, everyone, embedded, empty }: { centreId?: string; /** Requests of all staff (needs platform.audit.read); otherwise only the signed-in person's own. */ everyone?: boolean; embedded?: boolean; empty?: { title: string; description?: string; action?: React.ReactNode } }) {
  const { t, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const duration = useDurationLabel();
  const scopeLabel = useScopeLabel();
  const canRevoke = useCanRevoke();
  const entering = useEnterCentre();
  const all = !!everyone && session.hasPermission('platform.audit.read');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<AccessGrant | null>(null);

  const columns = React.useMemo<Array<DataTableColumn<AccessGrant>>>(
    () => [
      ...(centreId
        ? []
        : [
            {
              id: 'centre',
              header: t('pc.centre'),
              mobile: 'title' as const,
              className: 'min-w-48',
              cell: (g: AccessGrant) => (
                <>
                  <bdi className="block">{g.centre.name}</bdi>
                  <span className="ltr-value block text-sm font-normal text-muted-foreground">{g.centre.slug}</span>
                </>
              ),
            },
          ]),
      {
        id: 'requested',
        header: t('access.columns.requested'),
        sortField: 'createdAt',
        mobile: centreId ? 'title' : 'field',
        className: 'whitespace-nowrap',
        cell: (g) => (
          <>
            <span className="tabular block">{formatDateTime(g.createdAt)}</span>
            <span className="block text-sm font-normal text-muted-foreground">
              <bdi>{g.requestedByName ?? t('access.unknownPerson')}</bdi>
            </span>
          </>
        ),
      },
      {
        id: 'reason',
        header: t('access.columns.reason'),
        className: 'min-w-44 max-w-72',
        cell: (g) => (
          <span className="line-clamp-2" dir="auto" title={g.reason}>
            {g.reason}
          </span>
        ),
      },
      {
        id: 'scopes',
        header: t('access.columns.scopes'),
        mobile: 'hidden',
        className: 'max-w-56',
        cell: (g) => (
          <span className="flex flex-wrap gap-1">
            {g.scopes.slice(0, 3).map((scope) => (
              <Badge key={scope} tone={SENSITIVE_SCOPES.has(scope) ? 'warning' : 'outline'}>
                {scopeLabel(scope)}
              </Badge>
            ))}
            {g.scopes.length > 3 ? <Badge tone="outline">{t('access.moreScopes', { count: g.scopes.length - 3 })}</Badge> : null}
          </span>
        ),
      },
      { id: 'status', header: t('pc.status'), sortField: 'status', mobile: 'badge', cell: (g) => <AccessStatusBadge grant={g} /> },
      {
        id: 'time',
        header: t('access.columns.time'),
        sortField: 'expiresAt',
        className: 'min-w-32',
        cell: (g) => (
          <>
            <span className="block">{duration(g.durationMinutes)}</span>
            {g.expiresAt ? <span className="tabular block text-sm text-muted-foreground">{t(accessState(g) === 'ACTIVE' ? 'access.until' : 'access.ended', { time: formatDateTime(g.revokedAt ?? g.expiresAt) })}</span> : null}
          </>
        ),
      },
    ],
    [t, formatDateTime, duration, scopeLabel, centreId],
  );

  const filters = React.useMemo<DataTableFilter[]>(
    () => [{ id: 'status', type: 'select', label: t('pc.status'), options: STATUSES.map((s) => ({ value: s, label: t(`access.filter.${s}`) })) }],
    [t],
  );

  const rowActions = React.useMemo<Array<RowAction<AccessGrant>>>(
    () => [
      { id: 'view', label: t('access.view'), icon: <Eye aria-hidden="true" />, onSelect: (g) => setOpenId(g.id) },
      { id: 'enter', label: t('access.enter.action'), icon: <ExternalLink aria-hidden="true" />, hidden: (g) => !entering.canEnter(g), onSelect: (g) => void entering.enter(g) },
      { id: 'revoke', label: t('access.revoke.withdraw'), icon: <XCircle aria-hidden="true" />, destructive: true, hidden: (g) => !canRevoke(g) || accessState(g) !== 'REQUESTED', onSelect: setRevoking },
      { id: 'end', label: t('access.revoke.end'), icon: <XCircle aria-hidden="true" />, destructive: true, hidden: (g) => !canRevoke(g) || accessState(g) !== 'ACTIVE', onSelect: setRevoking },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, canRevoke, entering.canEnter],
  );

  const fixed = React.useMemo(() => ({ centreId, all: all ? true : undefined }), [centreId, all]);

  return (
    <>
      <DataTable<AccessGrant>
        caption={t('nav.access')}
        queryKey={keys.access.all}
        queryFn={(params, signal) => api.access.list(params, signal)}
        fixedParams={fixed}
        columns={columns}
        rowKey={(g) => g.id}
        onRowClick={(g) => setOpenId(g.id)}
        rowActions={rowActions}
        filters={filters}
        searchable={!embedded}
        syncUrl={!embedded}
        searchPlaceholder={t('access.searchPlaceholder')}
        defaultSort="createdAt:desc"
        defaultPageSize={embedded ? 10 : 20}
        empty={{ icon: <KeyRound />, title: empty?.title ?? t('access.emptyTitle'), description: empty?.description ?? t('access.emptyText'), action: empty?.action }}
      />
      <AccessSheet id={openId} onClose={() => setOpenId(null)} onRevoke={setRevoking} entering={entering} />
      <RevokeDialog grant={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}

function RevokeDialog({ grant, onClose }: { grant: AccessGrant | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const waiting = grant ? accessState(grant) === 'REQUESTED' : false;
  return (
    <ConfirmAction
      open={!!grant}
      onOpenChange={(open) => !open && onClose()}
      title={t(waiting ? 'access.revoke.withdrawTitle' : 'access.revoke.endTitle', { name: grant?.centre.name ?? '' })}
      description={t(waiting ? 'access.revoke.withdrawText' : 'access.revoke.endText')}
      confirmLabel={t(waiting ? 'access.revoke.withdraw' : 'access.revoke.end')}
      onConfirm={async () => {
        await api.access.revoke(grant!.id);
        await Promise.all([keys.access.all, keys.tenants.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
        toasts.success(t(waiting ? 'access.revoke.withdrawn' : 'access.revoke.ended'));
      }}
    />
  );
}

/** Everything about one request: the wish, the centre's decision and the time box. */
function AccessSheet({ id, onClose, onRevoke, entering }: { id: string | null; onClose: () => void; onRevoke: (grant: AccessGrant) => void; entering: ReturnType<typeof useEnterCentre> }) {
  const { t, formatDateTime } = useI18n();
  const api = usePlatformApi();
  const session = useSession();
  const duration = useDurationLabel();
  const canRevoke = useCanRevoke();
  const grant = useQuery({ queryKey: keys.access.detail(id ?? ''), queryFn: ({ signal }) => api.access.get(id as string, signal), enabled: !!id, refetchInterval: 30_000 });
  const g = grant.data;
  const state = g ? accessState(g) : null;

  const steps: TimelineItem[] = [];
  if (g) {
    steps.push({ id: 'requested', title: t('access.timeline.requested', { name: g.requestedByName ?? t('access.unknownPerson') }), time: formatDateTime(g.createdAt), state: 'done' });
    if (g.status === 'REQUESTED') steps.push({ id: 'waiting', title: t('access.timeline.waiting'), description: t('access.timeline.waitingText'), state: 'current' });
    if (g.decidedAt && g.status === 'DENIED') steps.push({ id: 'denied', title: t('access.timeline.denied', { name: g.decidedByName ?? t('access.theCentre') }), time: formatDateTime(g.decidedAt), state: 'done', tone: 'danger' });
    if (g.startsAt) steps.push({ id: 'approved', title: t('access.timeline.approved', { name: g.decidedByName ?? t('access.theCentre') }), time: formatDateTime(g.startsAt), state: 'done' });
    if (state === 'ACTIVE' && g.expiresAt) steps.push({ id: 'active', title: t('access.timeline.active'), time: t('access.until', { time: formatDateTime(g.expiresAt) }), state: 'current' });
    if (g.revokedAt) steps.push({ id: 'revoked', title: t(g.startsAt ? 'access.timeline.revoked' : 'access.timeline.withdrawn'), time: formatDateTime(g.revokedAt), state: 'done', tone: 'warning' });
    else if (state === 'EXPIRED') steps.push({ id: 'expired', title: t(g.startsAt ? 'access.timeline.expired' : 'access.timeline.lapsed'), time: g.expiresAt ? formatDateTime(g.expiresAt) : undefined, state: 'done' });
  }

  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="end" className="w-[min(36rem,96vw)]">
        <SheetHeader>
          <SheetTitle>{g ? t('access.detail.title', { name: g.centre.name }) : t('access.detail.loading')}</SheetTitle>
          <SheetDescription>{t('access.detail.text')}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          {grant.isPending ? (
            <div className="space-y-3" aria-hidden="true">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : grant.isError ? (
            <LoadError error={grant.error} onRetry={() => void grant.refetch()} />
          ) : g ? (
            <>
              <DescriptionList
                columns={2}
                items={[
                  { label: t('pc.centre'), value: <CentreCell centre={g.centre} link={session.hasPermission('platform.tenants.read')} /> },
                  { label: t('pc.status'), value: <AccessStatusBadge grant={g} /> },
                  { label: t('access.columns.reason'), wide: true, value: <span dir="auto">{g.reason}</span> },
                  { label: t('access.detail.asked'), value: duration(g.durationMinutes) },
                  { label: t('access.detail.ticket'), value: g.ticketId ? session.hasPermission('platform.support.manage') ? <TextLink href={`/support/${g.ticketId}`}>{t('access.detail.openTicket')}</TextLink> : t('common.yes') : null },
                  ...(g.decisionNote ? [{ label: t('access.detail.decisionNote'), wide: true, value: <span dir="auto">{g.decisionNote}</span> }] : []),
                ]}
              />

              <section aria-labelledby="access-scopes">
                <h3 id="access-scopes" className="text-md font-semibold text-foreground">
                  {t('access.detail.scopes')}
                </h3>
                <p className="mb-3 mt-1 text-sm text-muted-foreground">{t('access.detail.scopesText')}</p>
                <ul className="space-y-2">
                  {g.scopes.map((scope) => (
                    <ScopeLine key={scope} scope={scope} />
                  ))}
                </ul>
              </section>

              <section aria-labelledby="access-history">
                <h3 id="access-history" className="mb-3 text-md font-semibold text-foreground">
                  {t('access.detail.history')}
                </h3>
                <Timeline items={steps} />
              </section>

              {state === 'ACTIVE' ? (
                <Alert tone="warning">
                  {t('access.detail.activeNote')}
                  {entering.canEnter(g) ? <span className="mt-1 block">{t('access.enter.text')}</span> : null}
                </Alert>
              ) : null}
            </>
          ) : null}
        </SheetBody>
        {g && (canRevoke(g) || entering.canEnter(g)) ? (
          <SheetFooter>
            {canRevoke(g) ? (
              <Button variant="destructive-outline" onClick={() => onRevoke(g)}>
                <XCircle aria-hidden="true" />
                {t(state === 'REQUESTED' ? 'access.revoke.withdraw' : 'access.revoke.end')}
              </Button>
            ) : null}
            {entering.canEnter(g) ? (
              <Button variant="accent" loading={entering.busy === g.id} onClick={() => void entering.enter(g)}>
                <ExternalLink aria-hidden="true" />
                {t('access.enter.action')}
              </Button>
            ) : null}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ScopeLine({ scope }: { scope: string }) {
  const { t, has } = useI18n();
  const known = has(`${scopeKey(scope)}.label`);
  return (
    <li className="flex items-start gap-2.5 text-base">
      {SENSITIVE_SCOPES.has(scope) ? <ShieldAlert className="mt-1 size-4 shrink-0 text-warning-text" aria-hidden="true" /> : <KeyRound className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{known ? t(`${scopeKey(scope)}.label`) : <span className="ltr-value">{scope}</span>}</span>
        {known ? <span className="block text-sm text-muted-foreground">{t(`${scopeKey(scope)}.text`)}</span> : null}
      </span>
    </li>
  );
}
