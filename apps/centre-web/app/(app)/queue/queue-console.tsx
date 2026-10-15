'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing, CheckCheck, Megaphone, Play, Ticket, UserX, Users, X } from 'lucide-react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Input, Select, Skeleton, StatCard, cn, useApi, useI18n, useSession } from '@typease/ui';
import { Field, Loadable, OpsStatusBadge, Panel, useDuration, useRun } from '@/components/ops/common';
import type { QueueBoard, QueueCounters, QueueToken, ServiceCategory } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const COUNTER_KEY = 'te_queue_counter';
const ANY = '__any__';
type TokenAction = 'recall' | 'start' | 'complete' | 'no-show' | 'cancel';

/**
 * The operator console. The board refreshes by itself every few seconds, so several counters
 * can work the same queue; "Call next" always gives each counter a different token.
 */
export function QueueConsole({ branchId, onIssue }: { branchId: string; onIssue: () => void }) {
  const { t, pick, formatNumber, formatTime } = useI18n();
  const api = useApi();
  const session = useSession();
  const duration = useDuration();
  const { run, busy } = useRun();
  const [counter, setCounter] = React.useState('');
  const [category, setCategory] = React.useState(ANY);
  const [message, setMessage] = React.useState<{ tone: 'info' | 'success'; text: string } | null>(null);
  const [confirming, setConfirming] = React.useState<{ token: QueueToken; action: 'no-show' | 'cancel' } | null>(null);

  React.useEffect(() => {
    try {
      setCounter(window.localStorage.getItem(COUNTER_KEY) ?? '');
    } catch {
      /* private mode: the counter is simply not remembered */
    }
  }, []);
  const rememberCounter = (value: string) => {
    setCounter(value);
    try {
      window.localStorage.setItem(COUNTER_KEY, value);
    } catch {
      /* ignore */
    }
  };

  const board = useQuery({ queryKey: opsKeys.queue.tokens(branchId), queryFn: () => api.client.get<QueueBoard>('/queue/tokens', { query: { branchId } }), refetchInterval: 8_000 });
  const counters = useQuery({ queryKey: opsKeys.queue.counters(branchId), queryFn: () => api.client.get<QueueCounters>('/queue/counters', { query: { branchId } }), refetchInterval: 8_000 });
  const categories = useQuery({
    queryKey: opsKeys.categories.list(false),
    queryFn: () => api.client.get<ServiceCategory[]>('/service-categories'),
    enabled: session.hasPermission('service.read'),
    staleTime: 5 * 60_000,
  });
  const invalidate = [opsKeys.queue.all, opsKeys.appointments.all];

  const callNext = () =>
    run('call-next', () => api.client.post<{ token: QueueToken | null; message: string }>('/queue/call-next', { branchId, counter: counter.trim(), categoryId: category === ANY ? undefined : category }), { invalidate }).then((result) => {
      if (!result) return;
      setMessage(result.token ? { tone: 'success', text: t('ops.queue.called', { token: result.token.tokenNo, counter: result.token.counter ?? counter }) } : { tone: 'info', text: t('ops.queue.nobodyWaiting') });
    });

  const act = (token: QueueToken, action: TokenAction, rethrow = false) =>
    run(`${action}-${token.id}`, () => api.client.post<QueueToken>(`/queue/tokens/${token.id}/${action}`, action === 'recall' && counter.trim() ? { counter: counter.trim() } : undefined), {
      success: t(`ops.queue.done.${action}`, { token: token.tokenNo }),
      invalidate,
      rethrow,
    });

  const tokens = board.data?.tokens ?? [];
  const waiting = tokens.filter((x) => x.status === 'WAITING');
  const atCounters = tokens.filter((x) => x.status === 'CALLED' || x.status === 'SERVING');
  const finished = tokens.filter((x) => x.status === 'COMPLETED' || x.status === 'NO_SHOW' || x.status === 'CANCELLED');
  const mine = counter.trim() ? atCounters.filter((x) => x.counter === counter.trim()) : [];
  const summary = board.data?.summary;
  const number = (n: number | undefined) => (n === undefined ? '–' : formatNumber(n));

  const actions = (token: QueueToken) => (
    <span className="flex flex-wrap items-center gap-1.5">
      {token.status === 'CALLED' ? (
        <>
          <Button size="sm" loading={busy === `start-${token.id}`} onClick={() => void act(token, 'start')}>
            <Play aria-hidden="true" />
            {t('ops.queue.actions.start')}
          </Button>
          <Button size="sm" variant="outline" loading={busy === `complete-${token.id}`} onClick={() => void act(token, 'complete')}>
            <CheckCheck aria-hidden="true" />
            {t('ops.queue.actions.complete')}
          </Button>
          <Button size="sm" variant="outline" loading={busy === `recall-${token.id}`} onClick={() => void act(token, 'recall')}>
            <Megaphone aria-hidden="true" />
            {t('ops.queue.actions.recall')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming({ token, action: 'no-show' })}>
            <UserX aria-hidden="true" />
            {t('ops.queue.actions.no-show')}
          </Button>
        </>
      ) : null}
      {token.status === 'SERVING' ? (
        <Button size="sm" loading={busy === `complete-${token.id}`} onClick={() => void act(token, 'complete')}>
          <CheckCheck aria-hidden="true" />
          {t('ops.queue.actions.complete')}
        </Button>
      ) : null}
      {token.status === 'WAITING' ? (
        <Button size="sm" variant="ghost" onClick={() => setConfirming({ token, action: 'cancel' })}>
          <X aria-hidden="true" />
          {t('ops.queue.actions.cancel')}
        </Button>
      ) : null}
    </span>
  );

  const line = (token: QueueToken) => (
    <li key={token.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="ltr-value tabular w-20 shrink-0 text-lg font-bold text-foreground">{token.tokenNo}</span>
      <span className="min-w-0 flex-1 basis-40">
        <span className="block truncate">{token.customerName ?? t('ops.queue.walkIn')}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {[token.categoryName, token.status === 'WAITING' ? t('ops.queue.since', { time: formatTime(token.issuedAt) }) : token.servedByName].filter(Boolean).join(' · ')}
        </span>
      </span>
      {token.status === 'WAITING' ? null : (
        <span className="flex items-center gap-1.5">
          <OpsStatusBadge kind="queue" status={token.status} />
          {token.counter ? <Badge tone="outline">{t('ops.queue.counterNo', { counter: token.counter })}</Badge> : null}
        </span>
      )}
      {actions(token)}
    </li>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard label={t('ops.status.queue.WAITING')} value={number(summary?.waiting)} icon={<Users />} tone="info" loading={board.isPending} />
        <StatCard label={t('ops.status.queue.CALLED')} value={number(summary?.called)} icon={<BellRing />} tone="warning" loading={board.isPending} />
        <StatCard label={t('ops.status.queue.SERVING')} value={number(summary?.serving)} icon={<Play />} tone="warning" loading={board.isPending} />
        <StatCard label={t('ops.status.queue.COMPLETED')} value={number(summary?.completed)} icon={<CheckCheck />} tone="success" loading={board.isPending} />
        <StatCard label={t('ops.status.queue.NO_SHOW')} value={number(summary?.noShow)} icon={<UserX />} tone={summary && summary.noShow > 0 ? 'danger' : 'neutral'} loading={board.isPending} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Panel title={t('ops.queue.myCounter')} description={t('ops.queue.myCounterText')}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('ops.queue.counter')} required>
                  {(p) => <Input {...p} value={counter} onChange={(e) => rememberCounter(e.target.value)} maxLength={20} dir="ltr" className="tabular text-center text-lg font-semibold" placeholder="1" autoComplete="off" />}
                </Field>
                {(categories.data?.length ?? 0) > 0 ? (
                  <Field label={t('ops.queue.category')}>
                    {(p) => <Select {...p} value={category} onValueChange={setCategory} options={[{ value: ANY, label: t('ops.queue.categoryAny') }, ...(categories.data ?? []).map((c) => ({ value: c.id, label: pick(c.name, c.nameAr) }))]} />}
                  </Field>
                ) : null}
              </div>
              <Button size="lg" className="w-full" disabled={!counter.trim()} loading={busy === 'call-next'} loadingText={t('common.loading')} onClick={() => void callNext()}>
                <Megaphone aria-hidden="true" />
                {t('ops.queue.callNext')}
              </Button>
              {!counter.trim() ? <p className="text-sm text-muted-foreground">{t('ops.queue.counterFirst')}</p> : null}
              {message ? (
                <Alert tone={message.tone} live>
                  {message.text}
                </Alert>
              ) : null}
              {mine.length ? (
                <ul className="space-y-3">
                  {mine.map((token) => (
                    <li key={token.id} className="rounded-lg border border-secondary bg-secondary-soft/40 p-4 text-center">
                      <p className="text-sm text-muted-foreground">{t(token.status === 'SERVING' ? 'ops.queue.servingNow' : 'ops.queue.callingNow')}</p>
                      <p className="ltr-value tabular mt-1 text-4xl font-bold text-foreground">{token.tokenNo}</p>
                      <p className="mt-1 truncate text-sm text-muted-foreground">{[token.customerName, token.categoryName].filter(Boolean).join(' · ')}</p>
                      <div className="mt-3 flex justify-center">{actions(token)}</div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Panel>

          <Panel title={t('ops.queue.counters')} bodyClassName="px-0 pb-0 pt-3">
            <Loadable query={counters} skeleton={<Skeleton className="mx-5 mb-5 h-20" />}>
              {(data) =>
                data.counters.length === 0 ? (
                  <p className="px-5 pb-5 text-sm text-muted-foreground">{t('ops.queue.countersEmpty')}</p>
                ) : (
                  <ul className="divide-y border-t">
                    {data.counters.map((c) => (
                      <li key={c.counter} className="flex items-center justify-between gap-3 px-5 py-2.5">
                        <span>
                          <span className="font-medium">{t('ops.queue.counterNo', { counter: c.counter })}</span>
                          <span className="block text-sm text-muted-foreground">{t('ops.queue.counterStats', { served: formatNumber(c.servedToday), noShows: formatNumber(c.noShowsToday) })}</span>
                        </span>
                        {c.current ? (
                          <span className="text-end">
                            <span className="ltr-value tabular block text-lg font-bold">{c.current.tokenNo}</span>
                            <OpsStatusBadge kind="queue" status={c.current.status} />
                          </span>
                        ) : (
                          <Badge tone="neutral">{t('ops.queue.counterFree')}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )
              }
            </Loadable>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Loadable query={board} skeleton={<Skeleton className="h-72 w-full" />}>
            {() => (
              <>
                <Card className="overflow-hidden">
                  <h2 className="border-b px-4 py-3 text-md font-semibold">{t('ops.queue.atCounters', { count: formatNumber(atCounters.length) })}</h2>
                  {atCounters.length ? <ul className="divide-y">{atCounters.map(line)}</ul> : <p className="px-4 py-4 text-sm text-muted-foreground">{t('ops.queue.atCountersEmpty')}</p>}
                </Card>
                <Card className="overflow-hidden">
                  <h2 className="border-b px-4 py-3 text-md font-semibold">{t('ops.queue.waitingList', { count: formatNumber(waiting.length) })}</h2>
                  {waiting.length ? (
                    <ol className="divide-y">{waiting.map(line)}</ol>
                  ) : (
                    <EmptyState
                      icon={<Ticket />}
                      title={t('ops.queue.waitingEmpty')}
                      description={t('ops.queue.waitingEmptyText')}
                      action={
                        <Button variant="outline" onClick={onIssue}>
                          {t('ops.queue.issue')}
                        </Button>
                      }
                    />
                  )}
                </Card>
                {finished.length ? (
                  <details className="rounded-lg border bg-card shadow-xs">
                    <summary className={cn('cursor-pointer rounded-lg px-4 py-3 text-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring')}>{t('ops.queue.finished', { count: formatNumber(finished.length) })}</summary>
                    <ul className="divide-y border-t">
                      {finished.map((token) => (
                        <li key={token.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                          <span className="ltr-value tabular w-20 shrink-0 font-semibold">{token.tokenNo}</span>
                          <span className="min-w-0 flex-1 basis-40 truncate text-sm text-muted-foreground">{[token.customerName, token.categoryName, token.servedByName].filter(Boolean).join(' · ')}</span>
                          {token.status === 'COMPLETED' && token.waitSeconds !== null ? <span className="text-sm text-muted-foreground">{t('ops.queue.waited', { time: duration(token.waitSeconds) })}</span> : null}
                          <OpsStatusBadge kind="queue" status={token.status} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
          </Loadable>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? t(confirming.action === 'cancel' ? 'ops.queue.cancelTitle' : 'ops.queue.noShowTitle', { token: confirming.token.tokenNo }) : ''}
        description={t(confirming?.action === 'cancel' ? 'ops.queue.cancelText' : 'ops.queue.noShowText')}
        confirmLabel={t(confirming?.action === 'cancel' ? 'ops.queue.actions.cancel' : 'ops.queue.actions.no-show')}
        onConfirm={async () => {
          await act(confirming!.token, confirming!.action, true);
        }}
      />
    </div>
  );
}
