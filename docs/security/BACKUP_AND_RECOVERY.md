# Backup and recovery

How TypEase data is backed up, how it is restored, how the restore is tested, and what is
**not** covered. Scripts: `scripts/db-backup.sh`, `scripts/db-restore.sh`,
`scripts/storage-backup.sh` (shared helpers in `scripts/lib/backup-common.sh`).
Configuration template: `infrastructure/deployment/env/backup.env.example`.

> **Status of this document.** Section 9 lists exactly what was executed while these scripts
> were written (a real encrypted backup of a development database and a real restore drill)
> and what was only written and syntax-checked (off-site upload, parallel restore, role
> re-synchronisation, object-store mirroring).

## 1. What has to be backed up

| Data | Where it lives | How it is protected | Without it |
| --- | --- | --- | --- |
| Business data (centres, customers, requests, invoices, audit trail ...) | PostgreSQL database | `db-backup.sh` (logical dump), or the provider's backups + PITR | everything is lost |
| Documents (passport copies, generated PDFs, uploads) | Object store bucket `S3_BUCKET` (or `STORAGE_LOCAL_DIR` with the local driver) | bucket versioning + replication, or `storage-backup.sh` | the database only holds keys and metadata: files are gone |
| Logos, favicons | Bucket `S3_PUBLIC_ASSETS_BUCKET` | same as documents (small, re-uploadable) | cosmetic |
| `DATA_ENCRYPTION_KEY` (+ `DATA_ENCRYPTION_OLD_KEYS`) | secret store | **key escrow** (section 5) | identity numbers, MFA secrets, integration credentials and local-driver files in every backup are unreadable **forever** |
| `HMAC_KEY` | secret store | key escrow | blind-index lookups stop matching; outstanding signed links die |
| `MINIO_KMS_SECRET_KEY` (bundled MinIO only) | secret store | key escrow | no object can be decrypted |
| `N8N_ENCRYPTION_KEY` + n8n volume (if n8n is used) | secret store / volume | key escrow + volume snapshot | automations and their credentials must be rebuilt |
| TLS certificates (`caddy-data` volume) | Docker volume | none needed | Caddy obtains new certificates; mind the CA rate limits when many custom domains come back at once |
| Redis | Docker volume / provider | AOF persistence only | queued and delayed jobs are lost (see section 8) |
| Env files, Compose files, Caddy sites | `/etc/typease`, repository | secret manager / git | the stack cannot be started |

A database backup that cannot be decrypted, or whose encrypted columns cannot be decrypted,
is not a backup. The three things that must survive a disaster **together** are: the dump,
the key that decrypts the dump, and `DATA_ENCRYPTION_KEY`.

## 2. Why the application role cannot take the backup

TypEase uses three database roles (see `database/scripts/migrate.ts`):

| Role | Used by | Row-level security |
| --- | --- | --- |
| `typease_app` | every tenant request | **enforced**: sees only the rows of the tenant bound to the current transaction |
| `typease_system` | cross-tenant code (sign-in, billing, schedulers) | policy `USING (true)`, still a normal role |
| `typease_owner` | migrations | owns the tables, therefore not subject to RLS |

A backup must contain every tenant's rows. Neither runtime role can produce one:

* `typease_app` sees no tenant rows at all without a tenant context, and has no privilege on
  several tables. Observed in the development workspace: `pg_dump` as `typease_app` (and as
  `typease_system`) stops immediately with
  `ERROR: permission denied for table schema_migrations`.
* Even with more grants, `pg_dump` runs with `row_security = off`: PostgreSQL then raises an
  error for a role that a policy would filter, instead of silently writing a partial dump.
  That is the behaviour you want - a silently incomplete backup is the worst outcome.

Use one of:

1. **`typease_backup`** (recommended): a login role with `BYPASSRLS` and membership of
   `pg_read_all_data`. Read-only, cannot change schema or data. Created by the bundled
   database's init script when `TYPEASE_DB_BACKUP_PASSWORD` is set; SQL for managed databases
   is at the end of `infrastructure/docker/postgres/bootstrap.sql`. (Some managed services
   only let their administrator role create `BYPASSRLS` roles.)
2. **`typease_owner`** (`DATABASE_MIGRATION_URL`): works everywhere, but hands the backup job
   a role that can alter the schema.

`db-backup.sh` refuses `typease_app` and `typease_system`, and checks before dumping that
the role is a superuser, has `BYPASSRLS`, or owns every RLS-protected table.

## 3. Database backup

```bash
# one-off
scripts/db-backup.sh --env-file /etc/typease/backup.env
# verify immediately (needs the decryption key on this machine; normally done in the drill instead)
scripts/db-backup.sh --env-file /etc/typease/backup.env --verify
```

What the script does:

1. `pg_dump --format=custom --compress=6` (compressed; restorable selectively and in parallel).
2. The dump is **piped straight into the cipher**; no plaintext file ever exists.
   * `BACKUP_AGE_RECIPIENTS` - [age](https://github.com/FiloSottile/age) with **public**
     keys. The server can only encrypt; the private key is not on it. Authenticated
     encryption: a modified or truncated file fails to decrypt (tested, section 9).
   * `BACKUP_PASSPHRASE` - fallback: `openssl enc -aes-256-cbc -pbkdf2 -iter 600000`.
     The passphrase lives on the server, and CBC is not authenticated; integrity relies on the
     `.sha256` file. Use it only where age cannot be installed.
   * Neither set: the script aborts. Unencrypted backups are refused.
3. Writes `<name>.dump.age|enc`, `<name>.dump.*.sha256` and `<name>.manifest.json`
   (not secret: server version, applied migrations, number of tables / tenants / users - used
   to sanity-check a restore).
4. Optional off-site copy: `BACKUP_S3_URI` (aws CLI, or `mc`).
5. Retention: deletes local backups older than `BACKUP_RETENTION_DAYS` (default 14), only
   after the new backup succeeded.
6. Writes `last-success.json` (read by `pnpm check:production -- --backup-marker ...`) and the
   Prometheus metric file `metrics/typease_backup.prom` (alerts `TypeaseBackupTooOld`,
   `TypeaseBackupNotOffsite`, `TypeaseBackupShrunk`).

Credentials are passed to the PostgreSQL tools through `PG*` environment variables, never on
the command line (a connection URL in the argument list is visible in `ps`).

**Bundled database** (`docker-compose.prod.yml`, profile `bundled-postgres`): the database
is on an internal network and not reachable from the host. Set

```
BACKUP_EXEC_PREFIX=docker compose --env-file /etc/typease/compose.env -f /opt/typease/docker-compose.prod.yml exec -T postgres
```

and `pg_dump` runs inside the container over its local socket; the encryption still happens
on the host.

**Managed database:** keep the provider's automated backups and point-in-time recovery
switched on - that is your primary recovery mechanism (lowest RPO). Still run
`db-backup.sh` daily to a different account or provider: it protects against losing the
provider account, and it is the only backup you can restore somewhere else.

### Schedule

| Job | When | Notes |
| --- | --- | --- |
| `db-backup.sh` | daily 01:15 UAE time, and before every deployment (`scripts/deploy.sh` does this) | cron or systemd timer; alert if older than 26 h |
| Provider PITR / WAL archiving | continuous | managed database, or pgBackRest / WAL-G on your own host (not provided here) |
| `storage-backup.sh` or bucket replication | continuous (replication) or nightly (mirror) | section 4 |
| Off-site retention | 35 daily + 12 monthly | lifecycle rule on the backup bucket; object lock if available |
| Restore drill | quarterly, and after any change to the backup tooling or a major PostgreSQL upgrade | section 7 |

```cron
15 21 * * *  root  /opt/typease/scripts/db-backup.sh --env-file /etc/typease/backup.env >> /var/log/typease-backup.log 2>&1
```
(21:15 UTC = 01:15 Asia/Dubai.)

## 4. Object storage

The preferred protection is provided by the object store itself, not by a script:

1. **Versioning** on the documents bucket. Protects against overwrite and delete, including
   by a compromised application key (the application's identity cannot remove versions if it
   lacks `s3:DeleteObjectVersion`). The bundled MinIO enables it when `S3_VERSIONING=true`
   (default in `docker-compose.prod.yml`).
2. With versioning, the lifecycle rule for `incoming/` creates delete markers; add
   `NoncurrentVersionExpiration` (for example 30 days for the whole bucket) or old versions
   accumulate for ever. See `docs/deployment/object-storage.md`.
3. **Replication** to a bucket in another region / account / provider.
4. Optional: object lock (WORM) on the replica for ransomware resistance.

Where replication is not available, `scripts/storage-backup.sh` mirrors the bucket
(`aws s3 sync` or `mc mirror`), skipping the `incoming/` staging prefix. By default it does
**not** propagate deletions: a mirror that follows deletions is not a backup.

Local storage driver (`STORAGE_DRIVER=local`, single host only):
`scripts/storage-backup.sh --local <STORAGE_LOCAL_DIR>` writes an encrypted tar archive.
Take it together with the database backup - a document row without its file, or the reverse,
is an inconsistency.

Consistency between the two backups: the database references object keys. Restore the object
store to a point in time **at or after** the database backup; extra objects are harmless
(unreferenced), missing objects show up as documents that cannot be downloaded.

## 5. Encryption key custody

| Key | Who holds it | Where it must never be |
| --- | --- | --- |
| age **private** key for backups | two named people (primary + deputy), offline: hardware token or printed / sealed copy in a safe, plus the company password manager's restricted vault | on the application host, in the repository, in CI |
| age **public** key | `backup.env` on the host | - (it is public) |
| `DATA_ENCRYPTION_KEY`, `HMAC_KEY`, `MINIO_KMS_SECRET_KEY`, `N8N_ENCRYPTION_KEY` | secret manager; an escrow copy with the same two people, **stored separately from the backups** | in a database backup, in the bucket that holds the backups |

Rules:

* The backup decryption key and the backups are never stored in the same place.
* Rotating the age key: add the new public key to `BACKUP_AGE_RECIPIENTS`; keep the old
  private key until the last backup encrypted for it has expired.
* Rotating `DATA_ENCRYPTION_KEY` (full procedure: `docs/deployment/secrets.md`, section 5):
  1. put the **new** key into escrow under a new id (for example `k2`) before it is used;
  2. set `DATA_ENCRYPTION_KEY=<new>`, `DATA_ENCRYPTION_KEY_ID=k2` and
     `DATA_ENCRYPTION_OLD_KEYS=k1:<previous key>`, restart API and worker;
  3. run `pnpm --filter @typease/api reencrypt` (first with `-- --dry-run`) until it reports
     nothing left under an old key;
  4. after 24 hours remove the old key from `DATA_ENCRYPTION_OLD_KEYS`.

  The escrow is a **list of keys by id**, not one key. Every ciphertext names the id of its key;
  a backup taken before step 3 finished contains values under the old id, and restoring it
  needs that key again in `DATA_ENCRYPTION_OLD_KEYS`. Never delete an old data key from escrow
  while a backup that depends on it is retained. Record for each key id: created, replaced
  (date of step 3), last backup that needs it expires on.
* Restoring a backup from before a rotation: start the API with the **current** key and id plus
  the old key in `DATA_ENCRYPTION_OLD_KEYS`, then run the re-encryption once on the restored
  system. If the id of a ciphertext is not configured, the API refuses to read that value with
  an error that names the missing id - it never guesses.
* Every use of a private key (drill or real restore) is recorded: who, when, why.

## 6. RPO and RTO

These are targets to decide and then **measure**, not properties the scripts guarantee.

| Setup | RPO (data you can lose) | RTO (time to be back) |
| --- | --- | --- |
| Managed PostgreSQL with PITR | minutes (provider dependent) | provider restore time + redeploy; typically under 1 h for a small database |
| Daily `db-backup.sh` only (single host) | **up to 24 h** | time to provision a host + restore + DNS; hours |
| Daily dump + pre-deploy dump | up to 24 h, but a bad deployment loses nothing | as above |

* The restore script prints the measured duration at the end of each run; the drill record
  keeps it. Use the number from your own drill, with your own data volume, as the RTO input.
  (The drill in section 9 restored a 0.7 MB development dump in 2 seconds, which says nothing
  about a production-sized database.)
* If a 24-hour RPO is not acceptable - for a system of record with payments it usually is
  not - use a managed database with PITR, or add WAL archiving. This repository does not
  ship a WAL archiving setup.
* Object storage RPO equals the replication lag (replication) or the mirror interval.

## 7. Restore

### 7.1 Disaster recovery (real restore)

1. Declare the incident; stop writes if the old system is still reachable (scale `api` and
   `worker` to 0) so nothing is lost after the backup you are about to restore.
2. Provision PostgreSQL 16. Create the owner role and nothing else
   (`infrastructure/docker/postgres/bootstrap.sql`, or the bundled container's init script).
3. Fetch the backup, its `.sha256` and `.manifest.json`. Bring the age private key to the
   machine that performs the restore (not to the application host if you can avoid it).
4. Restore into a **new** database and re-create role passwords:

   ```bash
   scripts/db-restore.sh --env-file /etc/typease/backup.env \
     --file /var/backups/typease/typease-typease-<stamp>.dump.age \
     --target-db typease --sync-roles \
     --migrate-cmd "docker compose --env-file /etc/typease/compose.env -f docker-compose.prod.yml run --rm migrate"
   ```

   `--sync-roles` runs the migration runner afterwards: it applies migrations that are newer
   than the backup and sets the passwords of `typease_app` / `typease_system` from
   `DATABASE_URL` / `DATABASE_SYSTEM_URL`. The script never overwrites an existing database.
5. Restore / re-point the object store.
6. Start the stack with the **same** `DATA_ENCRYPTION_KEY` and `HMAC_KEY` as the system that
   produced the backup.
7. Verify: `pnpm check:production -- --env-file ...`, `scripts/smoke-test.sh`, then sign in
   and open a document, an invoice and the audit log of one centre.
8. Tell centres what time the data was restored to (everything after it must be re-entered).
   A restore that loses or exposes personal data is a privacy incident: follow the incident
   procedure (platform console: privacy incidents).

How the restore works, and why:

* The runtime roles are created **by the owner role** before the archive is replayed, because
  the archive contains `GRANT ... TO typease_app` and `CREATE POLICY ... TO typease_app`, and
  because in PostgreSQL 16 a `CREATEROLE` role can only set passwords of roles it created.
  If your provider forces you to create them as the administrator, run
  `GRANT typease_app, typease_system TO typease_owner WITH ADMIN OPTION;`.
* `pg_restore --no-owner --single-transaction --exit-on-error`: all objects end up owned by
  the restoring owner role whatever it was called on the source; a failed restore leaves
  nothing behind (the script also drops a database it created itself).
* Sanity checks afterwards: tables, RLS enabled on every table with a `tenantId` column,
  policies, triggers (append-only ones enabled), grants for `typease_app`, table ownership,
  and tenant / user / migration counts against the manifest.

### 7.2 Restore drill (quarterly)

A drill restores the latest production backup into a throw-away database and proves that
(a) the backup decrypts, (b) it restores, (c) tenant isolation and integrity controls are
intact in the restored copy, (d) the people and keys needed are available, (e) how long it takes.

**Run the drill on a separate PostgreSQL instance** (a temporary container or a staging
server), never on the production cluster: database roles and their passwords are
cluster-wide, and a production backup contains personal data that must not sit in a shared
database. The drill machine is handled like production for the duration.

Checklist (copy into the drill ticket):

- [ ] Latest backup and its `.sha256` / `.manifest.json` downloaded from the **off-site** copy (not from the host's local directory).
- [ ] Age private key retrieved by an authorised key holder; retrieval logged.
- [ ] `scripts/db-restore.sh --env-file drill.env --file <backup> --target-db typease_drill --drill`
      finishes with "all sanity checks passed". Duration noted: ______
- [ ] Deeper check against the restored copy before it is dropped (use `--keep`):
      `node scripts/production-readiness.mjs --env-file drill-db.env --skip-network`
      - "RLS is enabled on every table with a tenantId column": PASS
      - "Without a tenant context typease_app sees no tenant rows": PASS
      - "Append-only / immutability triggers exist": PASS
- [ ] Spot check of three records chosen by the business (a request, an invoice, an audit entry) against production.
- [ ] One encrypted field decrypts with the escrowed `DATA_ENCRYPTION_KEY` (start an API against the drill database, open a customer with an identity number).
- [ ] One document downloads from the object-store replica.
- [ ] Drill database dropped; decrypted material and the private key removed from the drill machine.
- [ ] `last-restore-drill.json` copied next to the backup marker on the production host (`pnpm check:production` warns when it is older than 100 days).
- [ ] Result, duration, problems and follow-up actions recorded; RTO in section 6 updated.

A drill that fails is an incident for the backup system: fix it and repeat, do not wait for
the next quarter.

## 8. What is NOT covered

* **Point-in-time recovery.** `db-backup.sh` is a daily logical dump. Changes after the last
  dump are lost in a disaster unless the database provider's PITR (or your own WAL archiving)
  is in place.
* **Redis.** Not backed up. With AOF enabled a restart keeps queued jobs; if the Redis data
  is lost, jobs that were queued or delayed in BullMQ at that moment are gone. Domain events
  waiting in the `outbox_events` table live in PostgreSQL, not in Redis, and are not affected;
  check the outbox and queue metrics after such an event. Rate-limit counters and caches
  rebuild by themselves.
* **Database roles and their passwords** are not in the dump (they are cluster-level).
  The restore script re-creates the two runtime roles; passwords come from the env files.
* **Secrets and env files.** Not in any backup made by these scripts. Keep them in a secret
  manager with its own backup. See section 5.
* **Consistency between database and object store** is not transactional (section 4).
* **Monitoring data** (Prometheus, Loki, Grafana volumes) and **n8n workflows**: not backed
  up by these scripts. Export n8n workflows to git if they matter; back up the `n8n-data`
  volume together with `N8N_ENCRYPTION_KEY`.
* **The mobile app's local data** and anything on user devices.
* **Tested scale.** The scripts were exercised on a development database of 108 tables and a
  few hundred rows. Timing, memory and `--jobs` behaviour on a production-sized database
  have not been measured.
* **Legal retention and erasure.** Backups contain personal data for as long as they are
  retained. A deletion request honoured in the live database is still present in older
  backups until they expire; the retention period above must be reflected in the privacy
  notice and reviewed by a qualified UAE adviser. After restoring an old backup, erasure and
  correction requests completed since that backup must be re-applied (the privacy module's
  request log is the source for that list - but it is restored to the old state too, so keep
  an export of completed data-subject requests outside the database).

## 9. Verified in the authoring workspace vs. written only

Executed for real (PostgreSQL 16.15, development database `typease_dev`, 108 tables):

| What | Result |
| --- | --- |
| `db-backup.sh` with age, `--verify` | 718 606-byte encrypted file; archive decrypts completely and lists 1 334 objects; `.sha256`, manifest, marker and metric file written |
| `db-backup.sh` with `BACKUP_PASSPHRASE` (openssl), `--verify` | encrypted file written and verified |
| Refusals | `typease_app` as dump role: refused. No encryption configured: refused |
| `pg_dump` run directly as `typease_app` and as `typease_system` | fails: `permission denied for table schema_migrations` |
| Tamper test: 4 bytes changed in a copy of the age file | `age` refuses: "failed to decrypt and authenticate payload chunk"; `db-restore.sh` refuses on the checksum |
| `db-restore.sh --existing-empty-db --drill` into a scratch database | restored in 2 s; all 12 sanity checks passed; counts equal to the manifest; drill record written |
| `production-readiness.mjs` against the restored copy | all structural checks PASS, including the isolation probe with the real `typease_app` credentials (95 tables, 0 rows visible without a tenant) |
| Restore guards | non-empty target refused; existing database name refused; owner without `CREATEDB` gets a clear error and nothing is left behind |
| `storage-backup.sh --local` | encrypted tar of the workspace's `storage-data` (8 files), decrypted and listed again |
| `production-readiness.mjs --backup-marker` | PASS (recent, encrypted), WARN (not off-site), PASS (drill record) |

The scratch database for the drill was created and dropped with the local PostgreSQL
superuser; the production path where the script itself runs `CREATE DATABASE`
(`RESTORE_ADMIN_URL`) was therefore **not** executed.

Written and syntax-checked (`bash -n`) but **not executed**:

* off-site upload (`aws s3 cp`, `mc cp`) - neither CLI is installed in the workspace;
* `storage-backup.sh` in S3 mode (`aws s3 sync`, `mc mirror`);
* `db-restore.sh --sync-roles` (it changes cluster-wide role passwords; not run on the shared server) and `--jobs N`;
* `BACKUP_EXEC_PREFIX` (needs the bundled database container);
* retention pruning of files older than the retention period (no old files existed; the code path ran and removed 0 files);
* `shellcheck` was not available; CI runs it.
