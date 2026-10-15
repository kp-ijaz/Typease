'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, cn, focusRing, useI18n, type Tone } from '@typease/ui';
import type { SystemHealth } from '@/lib/types';

export type HealthProblemId = 'database' | 'redis' | 'queue' | 'storage' | 'workerStale' | 'workerMissing' | 'workerUnknown' | 'failedJobs' | 'failedEvents' | 'staleEvents';
export interface HealthProblem {
  id: HealthProblemId;
  count: number;
}

/**
 * What is wrong, derived from the structured answer with the API's own thresholds
 * (the sentences in `problems` are English only): a dependency that does not answer,
 * unreachable storage, a stale or missing worker, failed background jobs, undelivered
 * events, events waiting for more than 10 minutes.
 */
export function healthProblems(health: SystemHealth): HealthProblem[] {
  const out: HealthProblem[] = [];
  if (!health.database || !health.systemDatabase) out.push({ id: 'database', count: 1 });
  if (!health.redis) out.push({ id: 'redis', count: 1 });
  if (!health.queue.reachable) out.push({ id: 'queue', count: 1 });
  if (health.storage && !health.storage.reachable) out.push({ id: 'storage', count: 1 });
  if (health.worker === null) out.push({ id: 'workerUnknown', count: 1 });
  else if (health.worker.status === 'STALE') out.push({ id: 'workerStale', count: health.worker.ageSeconds ?? 0 });
  else if (health.worker.status === 'NOT_SEEN') out.push({ id: 'workerMissing', count: 1 });
  const failedJobs = health.queue.driver === 'bullmq' ? health.queue.failed : health.queue.deadLetters;
  if (failedJobs > 0) out.push({ id: 'failedJobs', count: failedJobs });
  if (health.outbox && health.outbox.failed > 0) out.push({ id: 'failedEvents', count: health.outbox.failed });
  if (health.outbox && health.outbox.oldestPendingSeconds > 600) out.push({ id: 'staleEvents', count: Math.round(health.outbox.oldestPendingSeconds / 60) });
  return out;
}

export const healthTone = (status: SystemHealth['status']): Tone => (status === 'ok' ? 'success' : status === 'down' ? 'danger' : 'warning');

/** The overall state as a pill that leads to the system health page. */
export function HealthPill({ health }: { health: SystemHealth }) {
  const { t } = useI18n();
  return (
    <Link href="/system-health" className={cn('rounded-full', focusRing)}>
      <Badge tone={healthTone(health.status)} dot>
        {t(`health.status.${health.status}`)}
      </Badge>
    </Link>
  );
}
