'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, CheckCircle2, Cpu, Database, HardDrive, ListChecks, MailWarning, RefreshCw, Send, Server, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Card, ChoiceLabel, PageHeader, RequirePermission, Skeleton, Switch, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, cn, useI18n, type Tone } from '@typease/ui';
import { healthProblems, healthTone } from '@/components/health-bits';
import { LoadError, Section } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformDashboard, SystemHealth } from '@/lib/types';

const INTERVAL_MS = 15_000;

export function SystemHealthPage() {
  return (
    <RequirePermission anyOf={['platform.metrics.read']}>
      <Health />
    </RequirePermission>
  );
}

/**
 * Health of what the platform runs on (GET /platform/system/health): both database
 * connections, Redis, object storage, the job queue with its per-queue counts, the worker
 * heartbeat and the event outbox. Refreshes by itself. The delivery figures of the month
 * come from the dashboard and are read once per visit.
 */
function Health() {
  const { t, tn, formatTime } = useI18n();
  const api = usePlatformApi();
  const [auto, setAuto] = React.useState(true);
  const query = useQuery({ queryKey: keys.health.all, queryFn: ({ signal }) => api.system.health(signal), refetchInterval: auto ? INTERVAL_MS : false, refetchIntervalInBackground: false, retry: 0, staleTime: 0 });
  const dashboard = useQuery({ queryKey: keys.dashboard.summary, queryFn: ({ signal }) => api.dashboard(signal), staleTime: 60_000, retry: 0 });
  const health = query.data;
  // When the last attempt failed, the figures on screen are old: say so instead of showing them as current.
  const stale = query.isError && !!health;

  return (
    <>
      <PageHeader
        title={t('nav.health')}
        description={t('health.description')}
        secondary={
          <Button variant="outline" onClick={() => void query.refetch()} loading={query.isFetching} loadingText={t('health.checking')}>
            <RefreshCw aria-hidden="true" />
            {t('health.checkNow')}
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3" role="status">
          {health && !stale ? (
            <Badge tone={healthTone(health.status)} dot className="px-3 py-1 text-sm">
              {t(`health.status.${health.status}`)}
            </Badge>
          ) : query.isError ? (
            <Badge tone="danger" dot className="px-3 py-1 text-sm">
              {t('health.unknown')}
            </Badge>
          ) : (
            <Skeleton className="h-7 w-40 rounded-full" />
          )}
          {query.dataUpdatedAt ? <span className="tabular text-sm text-muted-foreground">{t('health.checkedAt', { time: formatTime(query.dataUpdatedAt) })}</span> : null}
        </div>
        <ChoiceLabel htmlFor="health-auto" control={<Switch id="health-auto" checked={auto} onCheckedChange={setAuto} />} label={t('health.auto')} description={tn('health.autoEvery', INTERVAL_MS / 1000)} />
      </div>

      {query.isError ? <LoadError className="mb-5" lead={health ? t('health.staleLead', { time: formatTime(query.dataUpdatedAt) }) : t('health.apiDown')} error={query.error} onRetry={() => void query.refetch()} /> : null}

      {query.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : health ? (
        <div className={cn('space-y-6', stale && 'opacity-60')}>
          <Problems health={health} />
          <Components health={health} />
          <Queues health={health} />
          {dashboard.data ? <Deliveries usage={dashboard.data.usage} /> : null}
          <p className="text-sm text-muted-foreground">{t('health.scope')}</p>
        </div>
      ) : null}
    </>
  );
}

function Problems({ health }: { health: SystemHealth }) {
  const { t, tn } = useI18n();
  const problems = healthProblems(health);
  if (!problems.length) {
    return (
      <Alert tone="success" title={t('health.noProblems')}>
        {t('health.noProblemsText')}
      </Alert>
    );
  }
  return (
    <Alert tone={health.status === 'down' ? 'danger' : 'warning'} live title={tn('health.problems', problems.length)}>
      <ul className="mt-1 list-disc space-y-1 ps-5">
        {problems.map((problem) => (
          <li key={problem.id}>{tn(`health.problem.${problem.id}`, problem.count)}</li>
        ))}
      </ul>
    </Alert>
  );
}

function StateLine({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return ok ? (
    <p className="flex items-center gap-2 text-base font-medium text-success-text">
      <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" />
      {okText}
    </p>
  ) : (
    <p className="flex items-center gap-2 text-base font-medium text-destructive-text">
      <XCircle className="size-5 shrink-0" aria-hidden="true" />
      {badText}
    </p>
  );
}

function ComponentCard({ icon, title, text, tone, children }: { icon: React.ReactNode; title: string; text: string; tone: Tone; children: React.ReactNode }) {
  const tones: Record<Tone, string> = { success: 'bg-success-soft text-success-text', warning: 'bg-warning-soft text-warning-text', danger: 'bg-destructive-soft text-destructive-text', info: 'bg-info-soft text-info-text', neutral: 'bg-muted text-muted-foreground' };
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5', tones[tone])}>
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-md font-semibold leading-6 text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{text}</p>
        </div>
      </div>
      {children}
    </Card>
  );
}

function Counts({ items }: { items: Array<{ label: string; value: number; alarm?: boolean }> }) {
  const { formatNumber } = useI18n();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="truncate text-sm text-muted-foreground">{item.label}</dt>
          <dd className={cn('tabular text-xl font-semibold', item.alarm ? 'text-destructive-text' : 'text-foreground')}>{formatNumber(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Components({ health }: { health: SystemHealth }) {
  const { t, tn, formatTime } = useI18n();
  const queue = health.queue;
  const outbox = health.outbox;
  const storage = health.storage;
  const failedJobs = queue.driver === 'bullmq' ? queue.failed : queue.deadLetters;
  const outboxStale = !!outbox && outbox.oldestPendingSeconds > 600;
  const age = (seconds: number) => (seconds >= 120 ? tn('health.minutes', Math.round(seconds / 60)) : tn('health.seconds', seconds));
  return (
    <section aria-label={t('health.components')} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <ComponentCard icon={<Server />} title={t('health.api.title')} text={t('health.api.text')} tone="success">
        <StateLine ok okText={t('health.answering')} badText={t('health.notAnswering')} />
      </ComponentCard>
      <ComponentCard icon={<Database />} title={t('health.database.title')} text={t('health.database.text')} tone={health.database ? 'success' : 'danger'}>
        <StateLine ok={health.database} okText={t('health.answering')} badText={t('health.notAnswering')} />
      </ComponentCard>
      <ComponentCard icon={<Database />} title={t('health.systemDatabase.title')} text={t('health.systemDatabase.text')} tone={health.systemDatabase ? 'success' : 'danger'}>
        <StateLine ok={health.systemDatabase} okText={t('health.answering')} badText={t('health.notAnswering')} />
      </ComponentCard>
      <ComponentCard icon={<HardDrive />} title={t('health.redis.title')} text={t('health.redis.text')} tone={health.redis ? 'success' : 'danger'}>
        <StateLine ok={health.redis} okText={t('health.answering')} badText={t('health.notAnswering')} />
      </ComponentCard>
      <ComponentCard icon={<Archive />} title={t('health.storage.title')} text={t(`health.storage.driver.${storage.driver}`)} tone={storage.reachable ? 'success' : 'warning'}>
        <StateLine ok={storage.reachable} okText={t('health.storage.reachable')} badText={t('health.storage.unreachable')} />
        <dl className="space-y-1 border-t pt-3 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{t('health.storage.target')}</dt>
            <dd className="ltr-value min-w-0 break-all text-foreground">{storage.target}</dd>
          </div>
          {storage.error ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{t('health.storage.error')}</dt>
              <dd className="ltr-value text-destructive-text">{storage.error}</dd>
            </div>
          ) : null}
          <div className="text-muted-foreground">{t('health.storage.checkedAt', { time: formatTime(storage.checkedAt) })}</div>
        </dl>
      </ComponentCard>
      <WorkerCard worker={health.worker} />
      <ComponentCard icon={<ListChecks />} title={t('health.queue.title')} text={t(`health.queue.driver.${queue.driver}`)} tone={!queue.reachable ? 'danger' : failedJobs > 0 ? 'warning' : 'success'}>
        <StateLine ok={queue.reachable} okText={t('health.answering')} badText={t('health.notAnswering')} />
        {queue.driver === 'bullmq' ? (
          <Counts
            items={[
              { label: t('health.queue.waiting'), value: queue.waiting },
              { label: t('health.queue.active'), value: queue.active },
              { label: t('health.queue.delayed'), value: queue.delayed },
              { label: t('health.queue.failed'), value: queue.failed, alarm: queue.failed > 0 },
            ]}
          />
        ) : (
          <Counts
            items={[
              { label: t('health.queue.waiting'), value: queue.pending },
              { label: t('health.queue.failed'), value: queue.deadLetters, alarm: queue.deadLetters > 0 },
            ]}
          />
        )}
      </ComponentCard>
      <ComponentCard icon={<Send />} title={t('health.outbox.title')} text={t('health.outbox.text')} tone={!outbox ? 'danger' : outbox.failed > 0 || outboxStale ? 'warning' : 'success'}>
        {outbox ? (
          <>
            <StateLine ok={!outboxStale} okText={outbox.pending > 0 ? t('health.outbox.oldest', { age: age(outbox.oldestPendingSeconds) }) : t('health.outbox.empty')} badText={t('health.outbox.stale', { age: age(outbox.oldestPendingSeconds) })} />
            <Counts
              items={[
                { label: t('health.outbox.pending'), value: outbox.pending },
                { label: t('health.outbox.processing'), value: outbox.processing },
                { label: t('health.outbox.failed'), value: outbox.failed, alarm: outbox.failed > 0 },
              ]}
            />
          </>
        ) : (
          <StateLine ok={false} okText="" badText={t('health.outbox.unreadable')} />
        )}
      </ComponentCard>
    </section>
  );
}

/** The process that runs the jobs, from its heartbeat in Redis: mode, freshness and every instance seen in 24 hours. */
function WorkerCard({ worker }: { worker: SystemHealth['worker'] }) {
  const { t, tn, formatDateTime } = useI18n();
  const age = (seconds: number) => (seconds >= 120 ? tn('health.minutes', Math.round(seconds / 60)) : tn('health.seconds', seconds));
  if (!worker) {
    return (
      <ComponentCard icon={<Cpu />} title={t('health.worker.title')} text="" tone="danger">
        <StateLine ok={false} okText="" badText={t('health.worker.unreadable')} />
      </ComponentCard>
    );
  }
  const tone: Tone = worker.status === 'OK' ? 'success' : worker.status === 'DISABLED' ? 'neutral' : 'danger';
  return (
    <ComponentCard icon={<Cpu />} title={t('health.worker.title')} text={t(`health.worker.mode.${worker.mode}`)} tone={tone}>
      {worker.status === 'DISABLED' ? (
        <p className="text-sm text-muted-foreground">{t('health.worker.disabledText')}</p>
      ) : (
        <>
          <StateLine ok={worker.status === 'OK'} okText={t('health.worker.status.OK')} badText={t(`health.worker.status.${worker.status}`)} />
          {worker.ageSeconds !== null ? <p className="text-sm text-muted-foreground">{t('health.worker.lastSeen', { age: age(worker.ageSeconds), interval: tn('health.seconds', worker.intervalSeconds) })}</p> : null}
        </>
      )}
      {worker.instances.length ? (
        <ul className="space-y-1.5 border-t pt-3 text-sm" aria-label={tn('health.worker.instances', worker.instances.length)}>
          {worker.instances.map((instance) => (
            <li key={instance.instanceId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <span className="ltr-value min-w-0 truncate font-mono text-xs text-foreground" title={instance.instanceId}>
                {instance.instanceId}
              </span>
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className="tabular">{t('health.worker.startedAt')} {formatDateTime(instance.startedAt)}</span>
                <Badge tone={instance.stale ? 'danger' : 'success'}>{instance.stale ? t('health.worker.stale') : t('health.worker.fresh')}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </ComponentCard>
  );
}

/** One row per queue: waiting, running, scheduled and failed jobs. */
function Queues({ health }: { health: SystemHealth }) {
  const { t, formatNumber } = useI18n();
  if (!health.queues?.length) return null;
  return (
    <Section title={t('health.queue.perQueue')} flush>
      <Table>
        <TableCaption className="sr-only">{t('health.queue.perQueue')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('health.queue.name')}</TableHead>
            <TableHead className="text-end">{t('health.queue.waiting')}</TableHead>
            <TableHead className="text-end">{t('health.queue.active')}</TableHead>
            <TableHead className="text-end">{t('health.queue.delayed')}</TableHead>
            <TableHead className="text-end">{t('health.queue.failed')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {health.queues.map((queue) => (
            <TableRow key={queue.name}>
              <TableCell className="ltr-value font-mono text-sm">{queue.name}</TableCell>
              <TableCell className="tabular text-end">{formatNumber(queue.waiting)}</TableCell>
              <TableCell className="tabular text-end">{formatNumber(queue.active)}</TableCell>
              <TableCell className="tabular text-end">{formatNumber(queue.delayed)}</TableCell>
              <TableCell className={cn('tabular text-end', queue.failed > 0 && 'font-semibold text-destructive-text')}>{formatNumber(queue.failed)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

/** Delivery attempts of this month per channel, from the same answer: where failed sends show up first. */
function Deliveries({ usage }: { usage: PlatformDashboard['usage'] }) {
  const { t, has, formatNumber } = useI18n();
  const channels = Object.entries(usage.notifications.deliveriesByChannel);
  return (
    <Section title={t('health.deliveries.title')} description={t('health.deliveries.text')} flush>
      {channels.length ? (
        <ul className="divide-y">
          {channels.map(([channel, counts]) => {
            const total = counts.sent + counts.failed;
            const share = total > 0 ? (counts.failed / total) * 100 : 0;
            return (
              <li key={channel} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3">
                <span className="flex items-center gap-2.5 font-medium text-foreground">
                  {counts.failed > 0 ? <MailWarning className="size-4 text-warning-text" aria-hidden="true" /> : <Send className="rtl-mirror size-4 text-muted-foreground" aria-hidden="true" />}
                  {has(`dash.usage.channels.${channel}`) ? t(`dash.usage.channels.${channel}`) : channel}
                </span>
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="tabular">{t('dash.usage.sent', { count: formatNumber(counts.sent) })}</span>
                  {counts.failed > 0 ? (
                    <Badge tone={share >= 10 ? 'danger' : 'warning'}>
                      {t('dash.usage.failed', { count: formatNumber(counts.failed) })} · {formatNumber(share, { maximumFractionDigits: 1 })}%
                    </Badge>
                  ) : (
                    <span>{t('health.deliveries.noneFailed')}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">{t('health.deliveries.empty')}</p>
      )}
    </Section>
  );
}
