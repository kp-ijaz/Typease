# Background worker

The worker is the process that runs everything TypEase does outside a request: sending notifications,
scanning uploaded files, document OCR, dispatching domain events from the outbox, and every recurring
housekeeping job.

| | |
| --- | --- |
| Code | `services/api/src/worker.ts` (`startWorker`) - part of the API code base, because it runs the job handlers the API modules register |
| Launcher package | `services/worker` (`@typease/worker`): `src/main.ts` loads `services/api/dist/worker.js` from the built API |
| Queue | BullMQ, queue name `typease` (`QUEUE_NAME` in `common/jobs/job-queue.ts`), on the Redis of `REDIS_URL` |
| Tests | `services/api/src/modules/platform/worker.bullmq.spec.ts` (real Redis, real BullMQ, a real child process for SIGTERM) |

## What the worker does

It boots the same Nest application as the API with `NestFactory.createApplicationContext(AppModule)`: every
module is loaded, so every job handler, schedule and event subscriber registers itself exactly as it does in
the API, but **no API HTTP listener is opened**. Then it:

1. runs the idempotent platform bootstrap (`ProvisioningService.bootstrapPlatform()`: permissions, plans,
   templates), so a worker that starts before the API finds what it needs;
2. **consumes the queue**: each job goes through `JobQueue.execute(name, payload, meta)`, which binds the
   tenant of the job (`payload.tenantId`) for row-level security, or the system context when the job has no
   tenant;
3. **synchronises the schedulers**: every `jobs.schedule(...)` declared by a module becomes a BullMQ job
   scheduler with the id `schedule:<job name>`; schedulers whose schedule no longer exists in the code are
   removed (a renamed or deleted job does not keep firing after a deployment);
4. runs the **outbox dispatcher on an interval** (`WORKER_OUTBOX_INTERVAL_MS`). Events are normally dispatched
   by the `outbox.dispatch` job that is enqueued the moment an event is emitted; the interval is the safety
   net that delivers events whose job was lost and retries that became due. Runs never overlap in one worker
   and are safe across workers (`FOR UPDATE SKIP LOCKED`);
5. answers a small **health endpoint**;
6. **shuts down gracefully** on `SIGTERM` / `SIGINT`.

The worker refuses to start when `QUEUE_DRIVER` is not `bullmq`, and exits with a non-zero code on any
configuration or start-up error.

## How to run

### Worker and API as separate processes (production, Docker)

`QUEUE_DRIVER=bullmq` in the environment of **both** processes. The API only enqueues; the worker executes.

```bash
pnpm --filter @typease/api build        # services/api/dist/worker.js
pnpm --filter @typease/worker build     # services/worker/dist/main.js
pnpm --filter @typease/worker start     # node dist/main.js
```

`node services/api/dist/worker.js` starts the same worker without the launcher package. The container image
(`infrastructure/docker/worker.Dockerfile`, role `worker` of `entrypoint.sh`) uses the launcher.

Development, with reload on change and no build step:

```bash
pnpm --filter @typease/worker dev
```

### Single-process mode (small installs, demos, tests)

```
QUEUE_DRIVER=inline
QUEUE_INLINE_AUTORUN=true
```

No worker is started (and it would refuse to start). The API keeps jobs in memory and runs them itself a few
milliseconds after they are enqueued, with the same retry counts. Schedules run on timers inside the API
process (`JobQueue.startInlineSchedules()`); **cron schedules run once an hour in this mode** instead of at
their exact time, which is harmless because every handler only acts on what is due. Limits of this mode:
jobs that are waiting are lost when the process stops (the maintenance and sweep jobs below re-queue the
important ones, and the outbox is in PostgreSQL), there is no failed set in Redis, and it must not be used
with more than one API replica.

With `QUEUE_DRIVER=inline` and `QUEUE_INLINE_AUTORUN=false` (the test default) nothing runs on its own:
tests call `jobs.drain()` and `jobs.runScheduled(name)`.

## Configuration

The worker reads the **same environment as the API** (`services/api/src/config/env.ts`: database, Redis,
storage, encryption keys, mail ...), because it executes the same code. In addition:

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `QUEUE_DRIVER` | `bullmq` | must be `bullmq` | With `inline` the API runs the jobs itself |
| `WORKER_CONCURRENCY` | `5` | 1 - 200 | Jobs processed in parallel by this process |
| `WORKER_HEALTH_PORT` | `4100` | 1 - 65535 | Port of the health endpoint |
| `WORKER_OUTBOX_INTERVAL_MS` | `10000` | 100 - 600000 | Interval of the outbox safety net |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `30000` | 1000 - 3600000 | How long running jobs may finish after SIGTERM |

The four `WORKER_*` variables are declared with their defaults in `config/env.ts` (so `.env.example` and the
production template document them, and `WORKER_HEARTBEAT_INTERVAL_SECONDS` sits next to them), and `worker.ts`
reads them from the environment again with the range checks above. A value that is not a whole number in the
range stops the worker at start-up with a message that names the variable.

## Jobs and schedules

Collected from every `jobs.register` and `jobs.schedule` in `services/api/src`. Cron patterns are evaluated
in **UTC** (Gulf Standard Time is UTC+4). "Per centre" means the handler walks all active centres with
`TenantDirectory.forEachTenant`, one tenant-scoped transaction each; a failure in one centre is logged and
does not stop the others.

### Recurring jobs

| Job | Schedule | Module | What it does |
| --- | --- | --- | --- |
| `platform.access_grants_expiry` | every 60 s | platform | Marks support access grants whose time is over as `EXPIRED`, ends their sessions, lapses unanswered requests |
| `workflows.scan` | every 5 min | requests | Per centre: escalates workflow steps past their time limit, flags requests past their target date, returns requests with a lapsed quotation for a revised offer |
| `automation.sweep` | every 5 min | automation | Per centre: re-queues automation executions whose job was lost or whose retry is due |
| `notifications.maintenance` | every 10 min | notifications | Per centre: re-queues notifications whose delivery job was lost, purges sent account-message payloads |
| `support.sla` | every 10 min | support | Per centre: escalates tickets that breached their SLA, closes resolved tickets after the reopen window |
| `appointments.reminders` | every 15 min | appointments | Per centre: emits appointment reminders (24 h and 2 h before by default) |
| `appointments.no_shows` | every 15 min | appointments | Per centre: marks appointments nobody checked in for as no-shows |
| `reports.scheduled` | every 15 min | reports | Per centre: generates scheduled reports that are due and notifies their recipients |
| `finance.quotations.expire` | `*/15 * * * *` | finance | Per centre: marks sent quotations past their validity date as `EXPIRED` |
| `tasks.overdue_scan` | every 30 min | tasks | Per centre: records tasks that passed their due date in the activity trail |
| `subscriptions.lifecycle` | `0 * * * *` (hourly) | subscriptions | SaaS subscriptions: trial end, renewal invoices, failed payments, grace period, suspension, cancellation |
| `integrations.authorisation_expiry` | `20 1 * * *` (05:20 GST) | integrations | Per centre: switches off partner / government authorisation records whose validity date has passed |
| `platform.offboarding` | `40 2 * * *` (06:40 GST) | platform | Permanently deletes centres whose offboarding date has passed (files first, then all rows in one transaction) |
| `reminders.scan` | `0 4 * * *` (08:00 GST) | reminders | Per centre: sends document expiry reminders that are due today |
| `documents.purge` | `30 22 * * *` (02:30 GST) | documents | Per centre: applies document retention policies and removes the files of deleted documents |

Every recurring job is registered with `attempts: 1`: a run that fails is not retried, the next tick runs it
again. All of them only act on what is due at the time they run, so a missed or repeated tick is harmless.

### Jobs enqueued on demand

| Job | Enqueued when | Attempts | First backoff | Module |
| --- | --- | --- | --- | --- |
| `outbox.dispatch` | a domain event is emitted (after commit) | 1 | - | common / events |
| `notifications.deliver` | a notification is created, retried by an administrator, or re-queued by maintenance | 5 | 30 s | notifications |
| `notifications.send_direct` | an account message without a centre (sign-up, password reset ...) is sent; the payload is encrypted | 5 | 15 s | notifications |
| `documents.scan` | a document version is uploaded (malware scan) | 5 | 15 s | documents |
| `ocr.extract` | OCR is requested for a document | 3 | 20 s | ocr |
| `workflows.advance` | a payment or refund event touches a request | 5 | 5 s | requests |
| `automation.execute` | an automation rule matched an event (retries are scheduled by the automation engine itself, with its own delay) | 1 | - | automation |

Backoff is exponential: the delay doubles with every attempt (`backoffMs x 2^(attempt-1)`). A job that is
enqueued without options uses the defaults of `JobQueue.enqueue`: 5 attempts, 5 s first backoff. Jobs
enqueued with a `jobId` are idempotent: a second enqueue with the same id is ignored while the first job
still exists.

## Failure handling

| What fails | What happens |
| --- | --- |
| A job handler throws, attempts left | BullMQ moves the job to the delayed set and retries it after the backoff. The worker logs a warning (`... failed on attempt 2 of 5, it will be retried`) and counts it in `jobs.retried` |
| A job handler throws, no attempts left | The job stays in the **failed set**. The worker logs an error and counts it in `jobs.failed` |
| A job has no registered handler | `JobQueue.execute` throws ("No handler registered for job ..."), so the job fails like any other. This happens when a worker runs older code than the API: deploy the worker and the API from the same build |
| An event subscriber throws | The outbox event goes back to `PENDING` with a backoff of `5 s x 2^attempts` (at most 1 hour). After 8 attempts it becomes `FAILED` and keeps the error text in `outbox_events.error`. An event stuck in `PROCESSING` for 5 minutes (a worker died mid-run) is claimed again |
| The outbox safety-net run throws | Logged, kept in `outbox.lastError` of the health response, tried again at the next interval |
| The worker process dies while a job runs | BullMQ detects the stalled job (lock expiry, about 30 s) and another worker, or the restarted one, runs it again. **Handlers must therefore be idempotent**; this is a rule of `BACKEND_CONVENTIONS.md` |
| Redis is unreachable | The worker keeps running and reconnects; `/health` answers `503` meanwhile. Nothing is lost that was already enqueued. Events emitted in the API meanwhile are safe in PostgreSQL (the outbox) and are delivered by the interval once the worker is back |
| PostgreSQL is unreachable | Jobs fail and are retried by their own policy; `/health` answers `503` |

### Dead letters

The dead letters of the queue are BullMQ's **failed set** of the queue `typease`. A job lands there when its
last attempt failed. Failed jobs are kept for **14 days** (`removeOnFail: { age: 14 days }`), completed jobs
for one hour (at most 1000, and 200 per scheduler).

- Count: the `systemHealth` part of `GET /api/v1/platform/dashboard` (platform console) and the Prometheus
  metric `typease_queue_jobs{state="failed"}` from `GET /api/v1/internal/metrics`; alert
  `TypeaseQueueFailedJobs`.
- Inspect and retry: with any BullMQ tool pointed at the queue `typease`, or from a Node shell:

  ```js
  const { Queue } = require('bullmq');
  const q = new Queue('typease', { connection: { url: process.env.REDIS_URL } });
  const failed = await q.getFailed(0, 50);   // name, data, failedReason, attemptsMade
  await failed[0].retry();                   // back to waiting
  ```

  Payloads contain ids only (`tenantId`, `notificationId`, `versionId` ...); the one payload with content,
  `notifications.send_direct`, is encrypted.
- Most failed jobs do not need a manual retry: `notifications.maintenance`, `automation.sweep` and
  `workflows.scan` re-queue work whose job was lost, and an administrator can retry a failed notification
  from the console.

The dead letters of the **outbox** are the rows of `outbox_events` with `status = 'FAILED'` (metric
`typease_outbox_failed`, alert `TypeaseOutboxFailedEvents`). To deliver one again after fixing the cause, the
schema owner sets it back: `UPDATE outbox_events SET status = 'PENDING', attempts = 0, "availableAt" = now()
WHERE id = '...'`.

In single-process mode the dead letters are only an in-memory list (`JobQueue.deadLetters`) and a log line.

## Health endpoint

Plain HTTP on `WORKER_HEALTH_PORT`, no authentication, no secrets and no tenant data in the response. Do not
publish the port outside the internal network.

| Path | Answers |
| --- | --- |
| `GET /health`, `GET /health/ready` | `200` when the worker can do its work: Redis answers, PostgreSQL answers, the queue can be read and the consumer is running. Otherwise `503` with the same body |
| `GET /health/live` | `200` as long as the process answers |

```json
{ "status": "ok", "service": "typease-worker", "redis": true, "database": true, "running": true,
  "concurrency": 5, "schedulers": 15, "uptimeSeconds": 8123,
  "jobs": { "processed": 4211, "failed": 0, "retried": 3, "active": 1, "lastStartedAt": "...",
            "lastCompletedAt": "...", "lastFailedAt": null, "lastFailedJob": null },
  "queue": { "waiting": 0, "active": 1, "delayed": 2, "failed": 0 },
  "outbox": { "lastRunAt": "...", "lastDelivered": 0, "lastError": null } }
```

`status` is `ok`, `degraded` or `stopping` (after a shutdown signal; `503`). `jobs.*` counts are those of
this process since it started; `queue.*` are the totals in Redis. The Docker health check and the Prometheus
blackbox probe (`http://worker:4100/health`, alert `TypeaseWorkerDown`) use `/health`.

## Graceful shutdown

On `SIGTERM` or `SIGINT` (once; a second signal is ignored while the first is handled):

1. the outbox interval stops and the consumer stops taking jobs;
2. jobs that are running may finish, for at most `WORKER_SHUTDOWN_TIMEOUT_MS`. Jobs that are still running
   after that are abandoned: BullMQ returns them to the queue as stalled jobs and they run again elsewhere;
3. an outbox run that is in flight completes;
4. the health server, the queue, the Redis connections and the application (database pools) are closed;
5. the process exits with code `0` (or `1` when the shutdown itself failed).

Give the container a stop grace period **longer** than `WORKER_SHUTDOWN_TIMEOUT_MS` (for the default: 40 s
or more), otherwise the orchestrator kills the process before the jobs finished.

## Scaling

- **More replicas.** Any number of workers may consume the same queue. BullMQ hands each job to exactly one
  of them, scheduler ticks are produced once per schedule however many workers run (schedulers are upserted
  by id), and the outbox dispatcher claims rows with `SKIP LOCKED`.
- **More concurrency.** `WORKER_CONCURRENCY` jobs run in parallel in one process. Most jobs wait on the
  database, a mail server or object storage, so values of 5 - 20 are reasonable; OCR and file scans read whole
  files into memory, so raise it together with the memory limit.
- **Database connections.** Each worker opens the same two pools as an API process (up to
  `2 x DATABASE_POOL_MAX` connections). Count the workers in when sizing `max_connections`.
- **Redis connections.** Up to four per worker for the queue (scheduler queue, consumer, the consumer's
  blocking connection, and the producer that handlers use to enqueue follow-up jobs) plus the application's
  own.
- **Signals to scale on:** `typease_queue_jobs{state="waiting"}` growing while `active` equals the total
  concurrency (alert `TypeaseQueueBacklog`), and `typease_outbox_pending` growing.
- Per-centre recurring jobs walk the centres one after another inside a single job. With very many centres
  the daily jobs take longer but do not block other jobs beyond one concurrency slot.
- Deploy workers and API from the **same build**: the worker must know every job name the API enqueues.

## Adding a job

In the owning module's `onModuleInit` (see `BACKEND_CONVENTIONS.md`):

```ts
this.jobs.register<{ tenantId: string; thingId: string }>('things.process', (payload, meta) => this.process(payload.thingId, meta), { attempts: 5, backoffMs: 10_000 });
this.jobs.schedule({ name: 'things.sweep', everySeconds: 600, description: 'Re-queue things whose job was lost' });
```

Nothing has to be changed in the worker: it picks up handlers and schedules from the application at start,
and removes the scheduler again when the `schedule` call disappears. Put `tenantId` in the payload of a
tenant job (the worker binds row-level security from it), keep payloads to ids, make the handler idempotent,
and add the job to the tables above.
