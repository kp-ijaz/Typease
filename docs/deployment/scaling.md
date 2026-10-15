# Scaling and connection pooling

Everything here is reasoning from the code and the configuration. **None of it was load
tested**, and PgBouncer was not run against the application; treat the numbers as starting
points and the PgBouncer section as an analysis to confirm in staging.

## 1. What is stateless and what is not

| Component | State | Scale by |
| --- | --- | --- |
| API | none in the process when `QUEUE_DRIVER=bullmq` and `STORAGE_DRIVER=s3`. Sessions are rows in PostgreSQL, access tokens are JWTs, rate-limit counters, the worker heartbeat and the job queue are in Redis; the tenant-host cache is per process (below) | more replicas (`API_REPLICAS`); Caddy balances over all replicas it finds in DNS |
| Worker | none; jobs are in Redis (BullMQ), domain events in the `outbox_events` table | more replicas (`WORKER_REPLICAS`) and / or per-process concurrency |
| Web apps | none (Next.js standalone servers) | more replicas (`WEB_REPLICAS`) |
| Caddy | certificates in the `caddy-data` volume | one instance per host. Several proxy hosts need shared certificate storage (a Caddy storage module) and a load balancer in front - not provided here |
| PostgreSQL, Redis, object store | all the state | vertically, or managed services |

Things that break statelessness - do not use them with more than one API replica:

* `QUEUE_DRIVER=inline`: jobs live in the memory of the process that queued them.
* `STORAGE_DRIVER=local`: files live on one host's disk (the Compose stacks share a volume
  between API and worker, which works on a single host only).
* The tenant-host cache of the API is per process and expires after 30 seconds: a newly
  verified custom domain can take up to 30 s to be recognised by every replica.

Server-sent events (`/api/v1/public/queue/display/stream`) are long-lived responses: each
open display holds one connection to one replica. They survive scaling; a rolling restart
closes them and the client has to reconnect.

## 2. Worker

* Run at least one worker in production. Without it nothing asynchronous happens:
  notifications, document malware scans, OCR, reminders, outbox dispatch, cron schedules.
* Handlers are required to be idempotent (a job may run more than once), so several worker
  replicas are safe by design. According to `services/api/src/common/jobs/job-queue.ts` the
  worker turns recurring schedules into BullMQ job schedulers (`upsertJobScheduler` keyed by
  schedule id in `services/api/src/worker.ts`), so replicas update the same scheduler instead
  of multiplying it. `services/api/src/modules/platform/worker.bullmq.spec.ts` checks the
  scheduler ids and repeat options with one worker; more than one worker replica has never
  been run.
* `WORKER_CONCURRENCY` (default 5) is the number of jobs one worker process runs in
  parallel; `WORKER_REPLICAS` multiplies it. Total parallelism is bounded by the database
  connections available (section 3: more concurrent jobs than `DATABASE_POOL_MAX` just queue
  for a connection) and by the memory of OCR / PDF jobs (the tesseract worker and PDF
  rendering are memory-hungry; the Compose limit is 1.5 GB per replica). Prefer more
  replicas over a very high concurrency.
* On SIGTERM the worker lets running jobs finish for `WORKER_SHUTDOWN_TIMEOUT_MS` (60 s in
  `docker-compose.prod.yml`, below the 90 s `stop_grace_period`); interrupted jobs are retried.
* `WORKER_OUTBOX_INTERVAL_MS` (default 10 s) is the safety-net interval of the outbox
  dispatcher.
* Redis must use `maxmemory-policy noeviction` and should have AOF persistence
  (`pnpm check:production` checks both).

Signals to scale on (all exported, see `monitoring.md`): `typease:queue_waiting` staying
high, `typease:outbox_oldest_pending_seconds` above a few seconds, worker CPU saturation.

## 3. Database connections

Each API or worker **process** opens two pools - one as `typease_app`, one as
`typease_system` - of up to `DATABASE_POOL_MAX` connections each.

```
connections needed  =  (API replicas + worker replicas) x 2 x DATABASE_POOL_MAX
                       + migration job (1) + monitoring (1-2) + backup (1) + admin headroom (5)
```

With the defaults (2 API + 1 worker, pool 10): 3 x 2 x 10 = 60, plus ~10 = 70 of the
bundled `max_connections=150`. Before adding replicas either raise `max_connections`
(memory!), lower `DATABASE_POOL_MAX`, or add a pooler. The alert
`TypeasePostgresConnectionsHigh` fires at 80 %.

The pools are not symmetric in practice: tenant requests use the app pool, sign-in and
schedulers the system pool. Watch `pg_stat_activity` by `usename` before tuning.

## 4. PgBouncer

### How the application uses a connection (read from the code)

* **Tenant binding is transaction-local.** `TenantDb.tx()` opens a transaction and its first
  statement is `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`.
  The third argument `true` means "for this transaction only" (`SET LOCAL`). The RLS policies
  read `current_setting('app.tenant_id', true)`. Nothing tenant-specific outlives the
  transaction. (`services/api/src/common/db/prisma.service.ts`, migration 0002.)
* **Advisory locks are transaction-level**: only `pg_advisory_xact_lock` is used.
* No `LISTEN` / `NOTIFY`, no temporary tables, no session-level `SET`, no `WITH HOLD` cursors
  were found in `services/api/src`.
* **Statements are unnamed.** The Prisma `pg` driver adapter only names a prepared statement
  when a `statementNameGenerator` is configured; the API does not configure one.
* **One session setting:** every connection is opened with the startup option
  `-c timezone=UTC`. Independently, the migration runner executes
  `ALTER ROLE typease_app SET timezone = 'UTC'` (and the same for `typease_system`).
* **The database role is the security boundary.** `typease_app` must reach PostgreSQL as
  `typease_app`.

### Session pooling - safe

`pool_mode = session` gives each client connection its own server connection for its whole
life. It behaves like a direct connection, so everything above works unchanged. It also
gives you little: the number of server connections still equals the sum of the application
pools. Its value is operational (online restarts, connection limits per database / user,
a single place to pause traffic during a failover).

### Transaction pooling - safe by the analysis above, with four conditions

`pool_mode = transaction` hands the server connection back after every transaction, so many
client connections share few server connections. Because tenant context, locks and
statements are all transaction-scoped, the application's use of PostgreSQL is compatible
with it. The conditions:

1. **Never force a server-side user.** In `[databases]` do not write `user=...`, and do not
   use `auth_user` in a way that makes every client log in as the same PostgreSQL role.
   PgBouncer keeps one pool per (database, user): `typease_app` clients must get server
   connections authenticated as `typease_app`. A forced user would either break the
   application (wrong grants) or - if that user owns the tables or has `BYPASSRLS` -
   **silently disable tenant isolation**. `pnpm check:production` connects through
   `DATABASE_URL` and fails if the session user is not `typease_app` or bypasses RLS: run it
   through the pooler.
2. **`ignore_startup_parameters = options`** (plus `extra_float_digits` if your client sends
   it). PgBouncer versions that do not understand the `options` startup parameter reject the
   connection ("unsupported startup parameter") unless it is ignored; setting this is
   harmless on versions that do. Assume the `-c timezone=UTC` it carries is dropped; the session time zone comes from the
   role default set by the migration runner. Verify once: `SHOW timezone;` through the
   pooler as `typease_app` must answer `UTC` (the readiness script checks this as
   "Application sessions run in UTC"). If it does not, timestamps written by the application
   and by `now()` can disagree.
3. **Only `SET LOCAL` / `set_config(..., true)` in future code.** A session-level `SET`, a
   session advisory lock (`pg_advisory_lock`), `LISTEN`, a temporary table or a named
   prepared statement would leak to, or be lost for, whichever client gets the server
   connection next. For the tenant variables that would be a cross-tenant data leak. This is
   a coding rule that reviewers must enforce; PgBouncer's `server_reset_query` is not run in
   transaction mode by default.
4. **Migrations and backups bypass the pooler.** Point `DATABASE_MIGRATION_URL` and
   `BACKUP_DATABASE_URL` at PostgreSQL directly: `pg_dump` and long DDL transactions need a
   real session.

Also: PgBouncer authenticates clients itself. The migration runner changes the role
passwords in PostgreSQL from the URLs; with a static `userlist.txt` you must update it too.
`auth_type = scram-sha-256` with `auth_query` avoids the second copy of the passwords.

Sizing sketch for transaction mode: `default_pool_size` 20 per (database, user) gives at
most 40 server connections for any number of API and worker replicas; keep
`DATABASE_POOL_MAX` at 10 per process (client side) and set `max_client_conn` above
`processes x 2 x DATABASE_POOL_MAX`.

Managed poolers (RDS Proxy, Supabase pooler, Cloud SQL connectors, PgCat ...) each have
their own rules for session state; the four conditions above are the checklist to apply to
them. RDS Proxy "pins" a connection when it sees session state - with this application it
should not need to, but check its pinning metric.

**What "safe" means here:** an analysis of the current code, not a test result. Before
enabling transaction pooling in production, run the API integration suite and the
tenant-isolation tests (`pnpm test:api`, `pnpm test:security`) against a database reached
through the pooler.

## 5. Redis

One Redis is used for rate limiting, caches and the job queue. `noeviction` means writes
fail when `maxmemory` is reached, so size it with headroom and alert on it
(`TypeaseRedisMemoryHigh`). For higher availability use a managed Redis with a replica;
Redis Cluster is not something the application was written for (BullMQ needs hash tags for
cluster mode) - use a primary / replica setup.

## 6. Single host limits

`docker-compose.prod.yml` is a single-host reference: the host is a single point of failure
whatever the replica counts are. Replicas there buy rolling restarts and use of several
cores, not availability. For availability across hosts you need an orchestrator (or two
hosts behind a load balancer), managed data services and shared certificate storage for the
proxies; the images and environment files carry over unchanged.
