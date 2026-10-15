# Upgrades and rollbacks

`scripts/deploy.sh <version>` performs an upgrade on a single host; `.github/workflows/deploy.yml`
calls it over SSH. Neither has been executed against a real host yet (the script's control
flow was exercised with `--dry-run`).

## 1. Release order

```
0  pre-deploy database backup            scripts/db-backup.sh (skipped with a managed DB + --skip-backup)
1  pull images of the new version
2  migrate                               run-once job, schema owner; forward-only
3  api          rolling                  new replicas next to old, wait for /health/ready, stop old
4  worker       recreate                 90 s grace for running jobs
5  web apps     rolling
6  caddy / optional services             only when their definition changed
7  readiness check, smoke test, version recorded in compose.env + deploy-history.log
```

Why this order: the database is migrated first, so for a short time the **old** API and
worker run against the **new** schema (section 2 explains what that requires of a
migration). The API goes before the worker and the worker follows immediately, which keeps
the window in which an old worker could receive a job type introduced by the new API to the
seconds between steps 3 and 4; such a job fails with "no handler registered" and is retried
with backoff by the new worker. Web apps go last: they depend only on the API contract.

"Zero-downtime-ish", precisely: API and web replicas overlap, and Caddy retries a request on
another replica when one refuses connections. Requests in flight on a replica being stopped
get the stop grace period (30 s API, 20 s web). Open server-sent-event streams are cut and
reconnect. With `API_REPLICAS=1` the rolling step still starts the new container before
stopping the old one. There is a brief window in which both versions serve requests.

## 2. Writing migrations so that this is safe (expand / contract)

Migrations are plain SQL files in `database/migrations`, applied in order, each in one
transaction, recorded with a checksum in `schema_migrations`. The runner refuses to continue
when an applied file was edited. **There are no down migrations.**

Because old code runs against the new schema during every deploy - and for as long as you
want to be able to roll the code back - each release's migrations must be backward
compatible with the previous release:

| Change | Do it as |
| --- | --- |
| add a column | nullable or with a default; release N adds it, release N+1 may require it |
| remove a column / table | release N stops using it; release N+1 drops it |
| rename | add new + copy / dual-write in N; switch reads in N+1; drop old in N+2 |
| add `NOT NULL` / tighter constraint | backfill first; add the constraint in a later release (`NOT VALID` + `VALIDATE` for large tables) |
| new index on a large table | `CREATE INDEX CONCURRENTLY` cannot run inside the runner's transaction: do it as an operational step, then add an `IF NOT EXISTS` migration |
| new table with a `tenantId` column | must enable row-level security and add the tenant policy in the same migration (`pnpm check:production` fails otherwise) |

Long-running migrations block the deploy and hold locks: test them on a restored copy of
production (the restore drill database is ideal) and note the duration.

## 3. Rollback

### Code only (the normal case)

```bash
scripts/deploy.sh <previous version> --skip-migrate
```
or the Deploy workflow with the previous version and "Skip migrations" ticked. Images are
immutable and tagged by version, so this restores exactly the previous code. The schema
stays at the new version - which the previous code tolerates **if** section 2 was followed.

`/etc/typease/deploy-history.log` lists successful deployments; its last line is the version
to go back to after a failed deploy.

### When the migration itself is the problem

There is no automatic reverse. Options, in order of preference:

1. **Roll forward**: write a new migration that repairs the problem and deploy it. This
   keeps the data written since the deploy.
2. **Manual reverse** of an additive change (drop the new column / table / constraint) by a
   DBA as the owner role, then delete the row from `schema_migrations` and the file from the
   release, so the runner's view matches. Only for changes that lost no data.
3. **Restore the pre-deploy backup** (`scripts/db-restore.sh`, into a new database, then
   repoint the stack). Everything written after the backup is lost; this is a disaster-level
   decision with customer communication, not a routine rollback.

If the migration job fails midway nothing is half-applied: each file is one transaction and
the API does not start (`depends_on: migrate: service_completed_successfully`). The old
containers keep running.

### What a rollback cannot undo

Emails, SMS and webhooks that were sent, payments that were captured, jobs already executed,
objects written to storage, and data migrations that transformed data in place.

## 4. Upgrading the platform components

| Component | Notes |
| --- | --- |
| Node.js base image | `NODE_VERSION` build arg in the three Dockerfiles and `ci.yml`; rebuild and release. Native modules (`@node-rs/argon2`) ship prebuilt binaries per platform / libc - stay on Debian (glibc) images |
| PostgreSQL minor (16.x) | change the pinned tag, `docker compose up -d postgres`: short outage; take a backup first |
| PostgreSQL major | not an in-place tag change: dump / restore (`db-backup.sh` + `db-restore.sh` onto the new version) or `pg_upgrade`; rehearse on a drill copy |
| Redis | AOF is compatible within 7.x; restart = queue paused for seconds |
| Caddy | validate the Caddyfiles with the new version (`scripts/validate-infra.sh`) before switching the tag |
| MinIO, ClamAV, n8n, monitoring images | pinned tags in the two Compose files (`x-images`); bump deliberately, read the release notes, pin by digest for production |
| Secrets rotation | `docs/deployment/secrets.md` |

## 5. Before and after every production deploy

Before: CI green on the tag, `pnpm check:production -- --env-file ...` without FAIL, the
migration rehearsed on a recent restore, a named person watching.

After: `scripts/smoke-test.sh` green, `/health/ready` on every replica, no new alerts for 30
minutes, outbox and queue metrics flat, one manual end-to-end check (sign in, open a request,
download a document).
