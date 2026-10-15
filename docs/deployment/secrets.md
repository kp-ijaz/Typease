# Secrets

Nothing secret is in the repository. `scripts/generate-secrets.sh` prints a fresh set and
refuses to write into the repository; CI scans the history with gitleaks
(`infrastructure/security/gitleaks.toml`).

## 1. Inventory

| Secret | Where it is used | Generate | Rotation impact |
| --- | --- | --- | --- |
| `JWT_ACCESS_SECRET` | API + worker | `openssl rand -base64 48` | all access tokens become invalid (max 15 min old); refresh cookies still work, clients silently refresh |
| `HMAC_KEY` | API + worker | `openssl rand -base64 48` | **breaks blind-index lookups and outstanding signed links.** No rotation procedure exists in the application: do not rotate without an application change |
| `DATA_ENCRYPTION_KEY` (+ `DATA_ENCRYPTION_KEY_ID`, `DATA_ENCRYPTION_OLD_KEYS`) | API + worker | `openssl rand -base64 32` (must decode to exactly 32 bytes) | supported without downtime, see section 5 "Rotating `DATA_ENCRYPTION_KEY`". Keep old keys in escrow as long as a backup encrypted with them is retained |
| `INTERNAL_API_TOKEN` | API, Prometheus (`monitoring.env`) | `openssl rand -base64 32` | update both files, restart API and Prometheus |
| database passwords (`typease_app`, `typease_system`) | `DATABASE_URL`, `DATABASE_SYSTEM_URL` | `openssl rand -hex 24` | change the URL, run the **migration job** (it sets the role passwords from the URLs), restart API + worker |
| owner password | `DATABASE_MIGRATION_URL` (`migrate.env`), `postgres.env` | hex | `ALTER ROLE typease_owner PASSWORD ...` as an administrator, update `migrate.env` |
| `REDIS_PASSWORD` | `redis.env`, `REDIS_URL`, `monitoring.env` | hex | restart Redis, API, worker, exporter together (short outage of readiness) |
| S3 access key pair | `typease.env` | provider / `minio-init` | create the new key, switch, delete the old one |
| `MINIO_KMS_SECRET_KEY` | `minio.env` | `name:$(openssl rand -base64 32)` | **never change it** for an existing bucket without MinIO's key-rotation procedure: objects become unreadable |
| `N8N_ENCRYPTION_KEY`, `N8N_WEBHOOK_SECRET` | `n8n.env`, `typease.env` | base64 | the first cannot be changed without re-entering n8n credentials |
| SMTP / SMS / WhatsApp / FCM / Stripe credentials | `typease.env` (platform defaults); per-centre credentials are stored encrypted in the database | provider consoles | provider-specific |
| age private key for backups | **offline**, never on the server | `age-keygen` | `docs/security/BACKUP_AND_RECOVERY.md`, section 5 |
| `CADDY_DNS_API_TOKEN` | `caddy.env` (wildcard option only) | DNS provider, scoped to one zone | reload Caddy |
| deploy SSH key | GitHub environment secret | `ssh-keygen -t ed25519` | replace `authorized_keys` on the host |

The API validates its secrets at start and refuses to run otherwise (`services/api/src/config/env.ts`,
tested in `services/api/test/encryption.spec.ts`):

- in every environment: `DATA_ENCRYPTION_KEY` and every entry of `DATA_ENCRYPTION_OLD_KEYS` decode to exactly
  32 bytes, key ids are well-formed and unique, and the id of the current key is not reused for a different key;
- in production additionally:
  - `JWT_ACCESS_SECRET`, `HMAC_KEY`, `DATA_ENCRYPTION_KEY`, every old data key and `INTERNAL_API_TOKEN` must not
    be one of the published values (`.env.example`, `infrastructure/docker/env/dev`, the CI workflow, the test
    setup - the list is `KNOWN_PLACEHOLDER_SECRETS`);
  - `JWT_ACCESS_SECRET` and `HMAC_KEY`: at least 32 characters, no placeholder wording (`change-me`, `example`,
    `development`, `dev-`, `password`, `0123456789` ...), and random enough (a repeated or patterned value is
    refused; `openssl rand -base64 48` and `openssl rand -hex 32` pass);
  - `DATA_ENCRYPTION_KEY`: not text somebody typed (32 printable characters) and not a repeated byte;
  - `INTERNAL_API_TOKEN`: at least 24 characters;
  - the four values must differ from each other.

  The messages name the variable and the reason, never the value.

`pnpm check:production` (`scripts/production-readiness.mjs`) is a separate pre-deployment check of an env file:
distinct values, no known development keys, no development database passwords. It is not the same code as the
start-up check; when the two disagree, the start-up check decides whether the API runs.

`PASSWORD_MIN_LENGTH` (default 10, cannot be set lower, at most 128) is the minimum length of every password
that is set: customer registration, centre sign-up, password reset and change, invitation acceptance and the
`platform-admin` CLI (which uses the larger of this value and 14). Existing passwords keep working for
sign-in. The web apps read the effective policy from `GET /api/v1/public/tenant-config` (`passwordPolicy`).

## 2. Where the files live (single host)

```
/etc/typease/            root:root 0700
  compose.env            0644  not secret: image prefix, version, profiles, replica counts
  typease.env            0600  API + worker
  migrate.env            0600  schema owner URL - only the migrate job reads it
  postgres.env redis.env minio.env n8n.env caddy.env monitoring.env backup.env    0600
  alertmanager.yml       0600  receivers (webhook URLs, SMTP password)
  prometheus-targets/    0755  public URLs to probe
```

Each container receives only its own file (`env_file` per service in
`docker-compose.prod.yml`): the API and the worker never see the schema owner's password,
the web applications receive no secrets at all.

Limits of env files, stated plainly: the values are readable by root on the host, visible
in `docker inspect` to anyone in the `docker` group, inherited by every process in the
container, and not versioned or audited.

## 3. Better options

* **Docker secrets** (`secrets:` with `file:` in Compose, or Swarm secrets): the value is a
  file under `/run/secrets`, not an environment variable, so it does not show in
  `docker inspect`. The API reads its configuration from environment variables only, so this
  needs a small wrapper entry point that exports the file contents before starting Node - a
  change to make together with the application team (it is not implemented).
* **A secret manager** (HashiCorp Vault, AWS Secrets Manager / SSM Parameter Store, Azure Key
  Vault, Google Secret Manager, Doppler ...): fetch at deploy time into a tmpfs-backed env
  file, or inject at container start. Gives rotation, audit and access control. Recommended
  as soon as more than one person operates the system.
* **SOPS-encrypted env files in a private repository** (age or KMS keys): versioned and
  reviewable; decrypt on the host during deploy.
* On an orchestrator: its native secret objects, ideally backed by one of the managers above.

Whatever the store: the escrow copies of `DATA_ENCRYPTION_KEY`, `HMAC_KEY` and
`MINIO_KMS_SECRET_KEY` must be recoverable **without** the production host.

## 4. After a suspected leak

1. Rotate the affected secret (table above); for database credentials also check
   `pg_stat_activity` for unknown clients.
2. `JWT_ACCESS_SECRET` leak: rotate it (every access token dies; refresh tokens are random
   values stored as hashes and are not affected). Users can end their other sessions
   themselves (`POST /api/v1/auth/sessions/revoke-others`); `docs/api/ENDPOINTS.md` lists no
   endpoint for a platform-wide forced sign-out at the time of writing.
3. `DATA_ENCRYPTION_KEY` leak: rotate it with the procedure in section 5 **including the
   re-encryption run**, so that nothing in the live database or on the local storage volume can be
   read with the leaked key any more. Every retained backup remains decryptable with the leaked key:
   treat it as a personal-data incident and follow the incident procedure.
4. Record the event in the platform's incident register and review access logs.

## 5. Rotating `DATA_ENCRYPTION_KEY`

What the key protects: Emirates ID and passport numbers of customers, identity numbers read by OCR,
authenticator (MFA) secrets, credentials of integrations, the rendered text of queued account-security
messages and - with `STORAGE_DRIVER=local` only - every stored file. (`pnpm --filter @typease/api reencrypt --
--list` prints the list the code knows; a test fails when code encrypts something that is not on it.)

How it works: every ciphertext starts with the **id** of the key that wrote it. `DATA_ENCRYPTION_KEY_ID`
(default `k1`) names the current key; it encrypts everything new. `DATA_ENCRYPTION_OLD_KEYS`
(`id:base64key,id:base64key`) lists keys that may still **decrypt**. A value whose key id is not configured
is not readable and the API says so (`... encrypted with key "k1", which is not configured ...`): nothing is
guessed, nothing is overwritten.

The procedure, with the API running throughout (example: from `k1` to `k2`):

1. **Escrow first.** Generate the new key (`openssl rand -base64 32`), store it in the secret manager and in
   the escrow (see `docs/security/BACKUP_AND_RECOVERY.md`, section 5) under its id. Do not continue before
   two people can recover it.
2. **Switch.** In `typease.env` (API and worker use the same file):

   ```env
   DATA_ENCRYPTION_KEY=<the new key>
   DATA_ENCRYPTION_KEY_ID=k2
   DATA_ENCRYPTION_OLD_KEYS=k1:<the previous key>
   ```

   The new key must get a **new id**; the start-up check refuses the id of the current key with a different
   key. Restart API and worker (rolling restart is fine: instances with the old configuration cannot read
   values the new ones write, so finish the restart before step 3). From now on new data uses `k2`; old data
   is still read with `k1`.
3. **Count** (changes nothing): `pnpm --filter @typease/api reencrypt -- --dry-run`. It prints, per store,
   how many values exist under which key id.
4. **Re-encrypt:** `pnpm --filter @typease/api reencrypt`. It rewrites every value that is not under the
   current key, in batches (`--batch 200` by default). It can run while the system is in use, can be
   interrupted and can be repeated: a value is replaced only if it still is what was read, and values already
   under the current key are skipped. Only the ciphertext changes (not `updatedAt`, not the blind indexes,
   which depend on `HMAC_KEY`). The run is recorded on the platform audit trail
   (`platform.encryption.reencrypted`, counts only). Exit code 1 and a list of row ids means some values
   could not be moved (a key id that is not configured, damaged data): keep the old key and investigate.
   Options: `--only <store,store>`, `--skip-files` (database only), `--list`.
5. **Verify:** run `--dry-run` again: the column "old key" must be 0 everywhere. Open a customer's identity
   numbers and a stored document in the staff app.
6. **Retire the old key from the configuration** - not before **24 hours** after step 4 succeeded (queued
   outbound messages and open upload / download links were sealed with the key that was current when they
   were created): remove the `k1:` entry from `DATA_ENCRYPTION_OLD_KEYS`, restart.
7. **Keep `k1` in escrow** until the last backup taken before step 4 has expired: a restore of such a backup
   contains `k1` ciphertext and needs `DATA_ENCRYPTION_OLD_KEYS=k1:<key>` again (then run step 4 on the
   restored system).

Not covered by this procedure: `HMAC_KEY` (no rotation exists), objects in S3 / MinIO (encrypted by the
object store, see `MINIO_KMS_SECRET_KEY`), database backups (encrypted with the age key).

