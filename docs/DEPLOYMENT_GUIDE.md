# TypEase deployment guide

How to run, deploy, observe, back up and verify TypEase: locally, and as a single-host
production installation with a path to managed services.

**Read this first - what is verified and what is not.** This guide and the files it
describes were written on a machine that had a Docker CLI but **no Docker daemon and no
network access**. No image was built, no container was started, no workflow has run.

| Verified by running it in that workspace | Written, statically checked, **not executed** |
| --- | --- |
| `scripts/production-readiness.mjs` against a real PostgreSQL 16 and Redis (section 12) | every Dockerfile and image build |
| `scripts/smoke-test.sh` against a running API, direct mode (section 13) | both Compose stacks as running systems (`docker compose config` passes) |
| `scripts/db-backup.sh` -> encrypted file -> `scripts/db-restore.sh` drill, plus tamper and guard tests | both Caddyfiles (`caddy validate` is wired into CI) |
| `scripts/storage-backup.sh --local`, `wait-for.sh`, `generate-secrets.sh` | Prometheus / Alertmanager / Loki / Alloy / Grafana configuration (YAML and JSON parse) |
| `.env.example` loaded through the API's own `loadEnv()`; every variable of `env.ts` covered (94 at the time of writing; `services/api/test/env-drift.spec.ts` keeps the two in step) | the three GitHub workflows |
| the migration runner compiled exactly as the API image compiles it, run with `--status` | `scripts/deploy.sh` and `scripts/dev-up.sh` (control flow exercised with `--dry-run` only) |
| PostgreSQL init SQL generation (read-only dry run) | off-site backup upload, S3 bucket mirroring, MinIO bucket job |
| `bash -n` / `sh -n` on every shell script; `scripts/validate-infra.sh`: 25 PASS, 0 FAIL, 5 SKIP | `shellcheck`, `hadolint`, `actionlint`, `promtool` (not installed; run in CI) |

Each detail page repeats this distinction for its own area. Treat the first build and the
first `docker compose up` as tests, and expect small corrections (image tags, a hardening
flag, a health-check path).

Detail pages:

| Topic | Page |
| --- | --- |
| Images, Compose stacks, pinned tags, known build risks | `docs/deployment/docker.md` |
| Reverse proxy, TLS, custom domains, DNS | `docs/deployment/reverse-proxy-and-tls.md` |
| Object storage | `docs/deployment/object-storage.md` |
| Secrets, rotation | `docs/deployment/secrets.md` |
| Scaling, PgBouncer | `docs/deployment/scaling.md` |
| Upgrades, rollbacks, migrations | `docs/deployment/upgrades-and-rollbacks.md` |
| Monitoring, alerts, logs, PII | `docs/deployment/monitoring.md` |
| CI/CD | `docs/deployment/ci-cd.md` |
| Backup, restore, drill | `docs/security/BACKUP_AND_RECOVERY.md` |
| Every environment variable | `.env.example` (repository root) |

---

## 1. Components

| Component | Technology | Port | Image / command |
| --- | --- | --- | --- |
| API | NestJS, Node 22 | 4000 | `api.Dockerfile`, `node dist/main.js` |
| Worker | BullMQ consumer, outbox dispatcher, schedulers (same code base as the API) | health 4100 | `worker.Dockerfile`, `node dist/main.js` in `services/worker` |
| Staff console `centre-web` | Next.js 15 | 3001 | `web.Dockerfile` (`APP=centre-web`) |
| Customer portal `customer-web` | Next.js 15 | 3002 | `web.Dockerfile` |
| Corporate portal `corporate-portal` | Next.js 15 | 3003 | `web.Dockerfile` |
| Platform console `platform-admin` | Next.js 15 | 3004 | `web.Dockerfile` |
| Customer mobile app | Flutter | - | built separately (section 3.5) |
| PostgreSQL 16 | three roles, row-level security | 5432 | bundled or managed |
| Redis 7 | rate limits, caches, job queue | 6379 | bundled or managed |
| Object storage | S3-compatible, two buckets | - | MinIO bundled, or managed |
| ClamAV | malware scanning of uploads | 3310 | optional profile |
| n8n | automation | 5678 | optional profile |
| Caddy | single entry point, automatic HTTPS | 80 / 443 | `caddy` |
| Monitoring | Prometheus, Alertmanager, Grafana, Loki, Alloy, exporters | - | optional profile |

Database roles (details in `.env.example` and `docs/security/BACKUP_AND_RECOVERY.md`):
`typease_owner` owns the schema and runs migrations; `typease_app` serves tenant requests
under row-level security and must never be a superuser, `BYPASSRLS` or a table owner;
`typease_system` serves cross-tenant code. The API refuses to start in production when its
tenant connection bypasses RLS.

## 2. Prerequisites

| For | You need |
| --- | --- |
| Local development on the host | Node.js >= 22.12, pnpm 10.28 (`corepack enable` or `npm i -g pnpm@10.28.0`), PostgreSQL 16 and Redis 7 (local or the `deps` containers), `psql` |
| Local development in containers | Docker Engine 24+ with the Compose plugin v2.20+ (`depends_on.required` is used), ~8 GB RAM free (ClamAV alone needs 2-3 GB) |
| Operations scripts | bash, curl, `psql` / `pg_dump` / `pg_restore` 16, `age` (or openssl), optional `jq`, `aws` CLI or `mc` for off-site copies |
| Production host | Linux x86-64, Docker Engine + Compose plugin, 4 vCPU / 8 GB as a floor for the bundled stack with ClamAV, ports 80 and 443 open, DNS control over the base domain |
| Mobile builds | Flutter SDK (stable), Android SDK and / or Xcode |

## 3. Local development

### 3.1 Everything in containers (one command)

```bash
docker compose --profile full up -d --build      # or: scripts/dev-up.sh   (waits, seeds, prints URLs)
```

| URL | What |
| --- | --- |
| `http://app.typease.localhost` | staff console |
| `http://portal.typease.localhost`, `http://<slug>.typease.localhost` | customer portal |
| `http://corporate.typease.localhost` | corporate portal |
| `http://admin.typease.localhost` | platform console |
| `http://api.typease.localhost/api/docs` | Swagger UI (development only) |
| `http://localhost:8025` | Mailpit: every email the stack sends |
| `http://localhost:9001` | MinIO console (credentials in `infrastructure/docker/env/dev/minio.env`) |
| `http://localhost:5678` | n8n |

Browsers resolve `*.localhost` to `127.0.0.1` by themselves. Development values (database
passwords, keys, MinIO users) are in `infrastructure/docker/env/dev/` and are valid for
nothing else. Port 80 busy? `HTTP_PORT=8080 docker compose ...` and append `:8080` to the URL
values in `dev/api.env` (see the comment there).

Demo data: `scripts/dev-up.sh` loads it; by hand `docker compose --profile seed run --rm seed`.
The seed refuses a database that already has centres. Demo logins use one shared, public
password - see `docs/DEMO_ENVIRONMENT.md`.

Stop: `scripts/dev-down.sh` (add `--purge` to delete the volumes).

### 3.2 Dependencies in containers, applications on the host

```bash
cp .env.example .env                              # development values; git-ignored
docker compose --profile deps up -d               # postgres, redis, minio, clamav, mailpit, n8n on 127.0.0.1
scripts/dev-up.sh --host                          # does everything below and starts the processes
```

The same, step by step:

```bash
set -a; . ./.env; set +a                          # the API reads the process environment, not .env files
pnpm install --frozen-lockfile
pnpm db:generate                                  # prisma generate (or: pnpm build:packages, which also compiles the packages)
pnpm build:packages
pnpm db:migrate                                   # applies database/migrations as typease_owner and sets the
                                                  # passwords of typease_app / typease_system from the two URLs
pnpm db:seed                                      # demo data (development only)
pnpm dev:api                                      # http://localhost:4000  (Swagger: /api/docs)
pnpm dev:worker                                   # only with QUEUE_DRIVER=bullmq; .env.example uses single-process mode
pnpm dev:centre                                   # http://localhost:3001
pnpm dev:customer                                 # http://localhost:3002
pnpm dev:corporate                                # http://localhost:3003
pnpm dev:admin                                    # http://localhost:3004
```

`.env.example` runs the API in **single-process mode** (`QUEUE_DRIVER=inline`,
`QUEUE_INLINE_AUTORUN=true`, local file storage, log-only email): only PostgreSQL and Redis
are needed. To use the other containers switch the commented lines in `.env`
(`STORAGE_DRIVER=s3` + `S3_ENDPOINT=http://localhost:9000`, `MAIL_DRIVER=smtp` +
`SMTP_HOST=localhost` / `SMTP_PORT=1025`, `MALWARE_SCANNER=clamav`).

Frontend variables (`NEXT_PUBLIC_API_URL` ...) belong to the web apps: see
`apps/<app>/.env.example` and `packages/config/next.mjs`.

### 3.3 Without Docker at all

Install PostgreSQL 16 and Redis 7 natively, then create the owner role and the database once
(as a PostgreSQL superuser):

```bash
psql -U postgres -v ON_ERROR_STOP=1 -v db=typease -v owner=typease_owner -v owner_password=owner_dev_pw \
     -f infrastructure/docker/postgres/bootstrap.sql
```

and continue with the step-by-step commands of 3.2 (`scripts/dev-up.sh --host --no-docker-deps`).
The owner needs `CREATEROLE` (the first migration creates the two runtime roles) but must
not be a superuser.

### 3.4 Production-like run of the API from a build

```bash
pnpm build:packages && pnpm build:api
set -a; . ./.env; set +a
node services/api/dist/main.js                    # API
node services/worker/dist/main.js                 # worker (QUEUE_DRIVER=bullmq)
pnpm build:web && pnpm --filter @typease/centre-web start      # each web app: next start -p <port>
# what the web image runs instead (standalone output):
#   PORT=3001 HOSTNAME=0.0.0.0 node apps/centre-web/.next/standalone/apps/centre-web/server.js
```

### 3.5 Mobile app (Flutter)

`apps/customer-mobile` is not part of the pnpm workspace and **has never been compiled**
(its `pubspec.yaml` says so; the CI job `mobile` is the first place where `flutter analyze`
and `flutter test` run, and it is allowed to fail). The authoritative instructions -
bootstrap of the platform folders, package resolution, the `--dart-define` values for the
API URL and the tenant - belong in `apps/customer-mobile/README.md`, which did not exist
when this guide was written. The standard commands it will build on:

```bash
cd apps/customer-mobile
flutter pub get
flutter analyze && flutter test
flutter build apk --release          # Android APK
flutter build appbundle --release    # Play Store bundle
flutter build ipa --release          # iOS (macOS + Xcode, signing configured)
```

## 4. Environment

* `.env.example` documents **every** variable of `services/api/src/config/env.ts` (checked
  by `scripts/validate-infra.sh`), marks what production requires and how to generate each
  secret.
* `scripts/generate-secrets.sh` prints a fresh set (never into the repository).
* Production templates, one file per consumer: `infrastructure/deployment/env/*.env.example`
  -> `/etc/typease/*.env` (`chmod 600`). Layout and alternatives: `docs/deployment/secrets.md`.

The three database URLs differ on purpose: `DATABASE_URL` (`typease_app`, RLS enforced),
`DATABASE_SYSTEM_URL` (`typease_system`, cross-tenant code), `DATABASE_MIGRATION_URL`
(`typease_owner`, migration job only - the API and worker containers do not receive it).

Production safety rules enforced by the API at start (`NODE_ENV=production`): no sandbox
payments, no development tokens, secure cookies, MFA required, internal token changed, S3
credentials present, no placeholder JWT / HMAC secrets. `pnpm check:production` checks the
same rules and many more **before** you deploy (section 12).

## 5. First production deployment, step by step

Assumes one Linux host and `docker-compose.prod.yml`. Recommended for real production:
managed PostgreSQL (with point-in-time recovery), managed Redis and a managed object store -
then skip the "bundled" parts and put the provider's URLs into the env files.

**5.1 DNS** (`reverse-proxy-and-tls.md`, section 4). `api`, `app`, `admin`, `corporate`,
`portal` and `*` under your base domain -> the host; `s3` too when you use the bundled
MinIO. Wait until they resolve before starting Caddy (certificates are requested at start).

**5.2 Host.** Install Docker Engine and the Compose plugin. Open 80/tcp, 443/tcp, 443/udp.
Check out this repository at the release tag into `/opt/typease`. `docker login ghcr.io`
with a read-only package token if the images are private.

**5.3 Images.** Push a version tag; `release.yml` builds and pushes the six images
(`ci-cd.md`). The web images are built with the production API URL compiled in
(GitHub environment variables `NEXT_PUBLIC_API_URL=https://api.<base>`,
`NEXT_PUBLIC_STORAGE_ORIGINS=<object-store origin>`).

**5.4 Secrets and configuration.**

```bash
sudo install -d -m 700 /etc/typease /etc/typease/prometheus-targets
for f in infrastructure/deployment/env/*.env.example; do
  sudo install -m 600 "$f" "/etc/typease/$(basename "${f%.example}")"; done
sudo chmod 644 /etc/typease/compose.env
scripts/generate-secrets.sh          # paste the values into the files; store them in your secret manager too
```

Edit every `<...>` placeholder. The same password must appear where the templates say so
(owner password in `postgres.env` and `migrate.env`; Redis password in `redis.env`,
`REDIS_URL` and `monitoring.env`; `INTERNAL_API_TOKEN` in `typease.env` and
`monitoring.env`). Escrow `DATA_ENCRYPTION_KEY`, `HMAC_KEY` and `MINIO_KMS_SECRET_KEY`
off the host now (`BACKUP_AND_RECOVERY.md`, section 5).

**5.5 Check the configuration before anything runs.**

```bash
dc="docker compose --env-file /etc/typease/compose.env -f docker-compose.prod.yml"
$dc config --quiet && echo "compose file renders"
$dc pull
```

**5.6 Database roles.** Bundled PostgreSQL: `$dc up -d postgres` - the init script creates
the owner role, the database and the optional backup / monitoring roles on the first start.
Managed PostgreSQL: run `infrastructure/docker/postgres/bootstrap.sql` once as the
provider's admin user. In both cases **do not** create `typease_app` / `typease_system`
yourself: the first migration creates them as the owner.

**5.7 Migrations.**

```bash
$dc run --rm migrate                  # prints each applied file, then "Database is up to date."
$dc run --rm migrate migrate-status
```

The runner also sets the two runtime roles' passwords from `DATABASE_URL` /
`DATABASE_SYSTEM_URL` and refuses to finish if `typease_app` is a superuser or `BYPASSRLS`.

**5.8 Object storage.** Bundled MinIO: copy `sites/minio.caddy.example` to
`sites/minio.caddy`; `$dc up -d minio minio-init` and read the job's log
(`$dc logs minio-init`) - it must end with "Object storage is ready". Managed: create the
buckets as in `object-storage.md`.

**5.9 Start.**

```bash
$dc up -d                             # migrate (again, no-op) -> api -> worker, web apps, caddy, profiles
$dc ps                                # everything "healthy"; migrate and minio-init "exited (0)"
$dc logs -f caddy                     # certificates being obtained
```

On its first start the API creates the reference data (permissions, document types, default
subscription plans). It creates **no users**.

**5.10 The first platform super admin.** The API package ships a command that creates
platform staff through the application's own code (`services/api/src/cli/platform-admin.ts`,
compiled into the image as `dist/cli/platform-admin.js`): password policy (at least 14
characters with upper case, lower case and a digit, or `PASSWORD_MIN_LENGTH` if higher),
email verified, audit entry on the platform trail, nothing secret printed. The password is
read from an environment variable, never from an argument, so it does not reach the shell
history or the process list. On the host, with the API's environment loaded:

```bash
PLATFORM_ADMIN_PASSWORD='choose-a-long-password' \
  pnpm --filter @typease/api platform-admin -- --email ops@example.ae --name "First Admin"
```

In the Compose stack the same command runs inside the API image:

```bash
$dc run --rm --no-deps -e PLATFORM_ADMIN_PASSWORD -w /app/services/api api \
  node dist/cli/platform-admin.js --email ops@example.ae --name "First Admin"
```

(`--role SUPPORT_AGENT` creates a support agent; running it again for an existing platform
account sets a new password, re-enables the account and ends its sessions; an address that
belongs to a centre's account is refused). The Compose wrapping was not executed in the build
environment; the command itself was run on the host against the development database.

Then sign in at `https://admin.<base>`. With `MFA_ENFORCEMENT=required` the account is
forced to enrol in two-step verification before it can do anything else; do that
immediately, store the recovery codes, and invite further staff from the console
(**Staff**, **Invite staff**; see `docs/user-guides/PLATFORM_ADMIN_GUIDE.md`).

**5.11 Verify** - sections 12 and 13: `check:production` without FAIL, smoke test green.

**5.12 Backups and monitoring** - sections 9 and 10. Do a restore drill **before** real
customer data arrives.

## 6. TLS and custom domains

Summary (full text: `reverse-proxy-and-tls.md`):

* Caddy obtains and renews certificates automatically. Platform hosts at start-up; tenant
  sub-domains and custom domains **on demand**, and only after the API confirmed the host
  name through `GET /api/v1/internal/tls/ask` - nobody can make the server request
  certificates for names the platform has not verified.
* A centre adds a custom domain in the console and creates two DNS records:
  `TXT _typease-verify.<domain>` = `typease-verify=<token>` (ownership) and
  `CNAME <domain>` -> `CUSTOM_DOMAIN_CNAME_TARGET` (`portal.<base>`).
* A wildcard certificate for tenant sub-domains needs the DNS-01 challenge (a Caddy build
  with your DNS provider's module); on-demand certificates per host need nothing extra but
  count against the CA's weekly limit per registered domain.
* `/api/v1/internal/*` is refused on every public host; the smoke test proves it from outside.
* Custom domains are routed to the customer portal only; the API accepts a domain for
  `app: "customer"` and nothing else, so the corporate portal and the staff application stay on
  their shared hosts. An unverified claim is released after 72 hours and removed after 14
  days; a verified domain of a centre whose plan no longer includes custom domains stops
  resolving (`SUSPENDED_BY_PLAN`) until the plan includes it again; the operator can release
  any claim with `DELETE /api/v1/platform/domains/:id` (`docs/WHITE_LABEL_GUIDE.md`, section 7).

## 7. External services

### 7.1 Object storage
`object-storage.md`. Two buckets; the documents bucket private, SSE on, `incoming/` expiring
after one day, versioning, CORS for the portal origins; least-privilege application key.
`NEXT_PUBLIC_STORAGE_ORIGINS` (web images) must contain the store's origin or the browser's
Content-Security-Policy blocks uploads.

### 7.2 ClamAV
Profile `clamav`; `MALWARE_SCANNER=clamav`, `CLAMAV_HOST=clamav`, and for production
`REQUIRE_CLEAN_SCAN=true` (files are downloadable only after a CLEAN result). clamd holds
its signatures in memory: plan 2-3 GB. The first start downloads the database (minutes;
needs outbound internet, as do the regular updates). While the scanner is unreachable scan
jobs retry and uploads stay in `PENDING_SCAN`; `pnpm check:production` pings clamd.
Test with the EICAR file: the document must become `QUARANTINED`. Never combine
`REQUIRE_CLEAN_SCAN=true` with `MALWARE_SCANNER=none`.

### 7.3 Email, SMS, WhatsApp, push
Platform defaults in `typease.env`; each centre can configure its own providers in the
console (stored encrypted). Details and what was tested by their authors:
`docs/api/modules/notifications.md`.

| Channel | Variables | Notes |
| --- | --- | --- |
| Email | `MAIL_DRIVER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` | set up SPF, DKIM and DMARC for the sender domain. With `MAIL_DRIVER=log` nobody receives verification or password-reset emails |
| SMS | `SMS_DRIVER=twilio` (`TWILIO_*`) or `http` (`SMS_HTTP_URL`, `SMS_HTTP_TOKEN`) | required when `ONBOARDING_REQUIRE_PHONE_VERIFICATION=true`; UAE sender-ID registration is your provider's process. Adapters were tested against fakes only |
| WhatsApp | `WHATSAPP_DRIVER=meta`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | message templates must be approved by Meta |
| Push | `PUSH_DRIVER=fcm`, `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` (one line) | mobile app |

Tenant-configured HTTP endpoints may only call hosts in `OUTBOUND_WEBHOOK_ALLOWED_HOSTS`
(SSRF protection).

### 7.4 Payment gateway and webhook URLs
`docs/api/modules/finance.md`, `subscriptions.md`. `PAYMENT_SANDBOX_ENABLED` must be `false`
in production (the API refuses to start otherwise).

| Purpose | Credentials | Webhook URL to register at the gateway |
| --- | --- | --- |
| Subscription invoices (platform account) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `https://api.<base>/api/v1/public/webhooks/subscriptions/stripe` |
| Customer payments (each centre's own account, configured in the console) | per centre, stored encrypted | `https://api.<base>/api/v1/public/webhooks/payments/stripe` |

Events for the Stripe endpoints: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`. Nothing is marked paid before a signed webhook arrives; events
older than `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` are rejected, so the host clock must be
synchronised (NTP). The Stripe adapter was written against the public API and **not verified
against live Stripe** by its authors: run a real test-mode payment end to end before go-live.
The webhook paths are public and pass through the proxy unchanged (raw body, 16 MB limit).

### 7.5 n8n
Profile `n8n`. The API reaches it inside the network: `N8N_WEBHOOK_BASE_URL=http://n8n:5678/webhook`,
`N8N_WEBHOOK_SECRET` (shared secret), and `n8n` in `OUTBOUND_WEBHOOK_ALLOWED_HOSTS`.
The editor is not published; use an SSH tunnel or `sites/n8n.caddy.example`. n8n stores
workflows in its volume (SQLite) and encrypts credentials with `N8N_ENCRYPTION_KEY` - back
up both; for heavier use point n8n at PostgreSQL (n8n's `DB_TYPE=postgresdb` settings, a
separate database). Calls from the API to n8n are signed (HMAC-SHA256 over
`<timestamp>.<body>` in `X-TypEase-Signature`, key `N8N_WEBHOOK_SECRET`; see
`services/api/src/modules/automation/webhook.ts`) - verify the signature in the n8n workflow.

## 8. Scaling, upgrades, rollbacks

* `scaling.md`: API, worker and web apps are stateless with `QUEUE_DRIVER=bullmq` and
  `STORAGE_DRIVER=s3`; database connections = processes x 2 x `DATABASE_POOL_MAX`;
  **PgBouncer** is safe in session mode and - by analysis of the code, not by test - in
  transaction mode under four stated conditions (never force a server-side user, ignore the
  `options` startup parameter, transaction-local settings only, migrations and backups
  bypass the pooler).
* `upgrades-and-rollbacks.md`: `scripts/deploy.sh <version>` = backup -> pull -> migrate ->
  api (rolling) -> worker -> web (rolling) -> checks. Migrations are forward-only; rollback
  is `scripts/deploy.sh <previous> --skip-migrate`, which is safe only if each migration is
  backward compatible with the previous release (expand / contract).

## 9. Backup and restore

`docs/security/BACKUP_AND_RECOVERY.md`. In short: daily encrypted `pg_dump` with a role that
can read every row (not the application role), off-site copy, bucket versioning and
replication, key escrow, and a quarterly restore drill with a checklist. Schedule:

```cron
15 21 * * *  root  /opt/typease/scripts/db-backup.sh --env-file /etc/typease/backup.env >> /var/log/typease-backup.log 2>&1
```

## 10. Monitoring and alerting

`monitoring.md`. `COMPOSE_PROFILES=...,monitoring`; fill `monitoring.env`; copy the
Alertmanager file to `/etc/typease/alertmanager.yml` and **add a receiver** (as shipped,
alerts go nowhere); list your public URLs in `/etc/typease/prometheus-targets/public-prod.yml`.
Add one external uptime check: monitoring on the same host cannot report that the host is down.

## 11. Logs, personal data, incidents

**Logs.** Containers log to stdout; Docker rotates (20 MB x 5); Alloy ships to Loki (30
days). The proxy access log is JSON and redacts credentials and URL tokens; it contains IP
addresses. The API logs NestJS text lines. Logs are personal data: restrict access, set the
retention deliberately, keep `LOG_LEVEL=info`. More in `monitoring.md`, section 5.

**Incident basics.**

1. *Detect*: an alert, a failed smoke test, or a report. Check `$dc ps`,
   `curl https://api.<base>/health/ready`, Grafana.
2. *Stabilise before diagnosing*: roll back the last deploy if it correlates
   (`scripts/deploy.sh <previous> --skip-migrate`); scale the API; if data is being damaged,
   stop writes (`$dc stop api worker`) - the portals then show errors, which is better than
   corrupt data.
3. *Common causes*: `/health/ready` 503 -> the failing check names PostgreSQL or Redis;
   uploads stuck in `PENDING_SCAN` -> ClamAV down or out of memory; notifications not sent
   -> worker down, queue stalled or provider credentials; certificate errors on one custom
   domain -> its DNS no longer points here or its `CAA` record forbids the CA; `401` on the
   metrics scrape -> token mismatch; database "too many connections" -> `scaling.md`.
4. *Security or personal-data incident* (leaked credential, cross-tenant exposure, lost
   backup medium): rotate the affected secrets (`secrets.md`, section 4), preserve logs and
   the audit trail (they are append-only in the database), record the incident in the
   platform console's privacy incident register, and involve the person responsible for
   data protection - notification duties and deadlines under UAE law are a legal question,
   not a technical one.
5. *Afterwards*: a short written review - timeline, cause, what detected it, what would
   have detected it sooner - and the follow-up actions with owners.

## 12. Production-readiness check

```bash
# on a machine with the repository and its dependencies installed
pnpm check:production -- --env-file /etc/typease/typease.env --env-file /etc/typease/migrate.env \
                         --backup-marker /var/backups/typease/last-success.json
# or inside the stack (no Node on the host needed)
$dc run --rm -v /var/backups/typease:/var/backups/typease:ro migrate \
    check --backup-marker /var/backups/typease/last-success.json
```

It validates the environment with the rules of `env.ts` plus go-live rules, then inspects
the real database (read-only transactions): migrations applied with matching checksums; the
app role is not superuser / `BYPASSRLS` / member of a privileged role and owns no table;
row-level security enabled on every table with a `tenantId` column, each with a tenant
policy and none with an open policy; every trigger declared by the migration files exists
and is enabled; no demo accounts or demo centres; a platform super admin with MFA exists;
and - with the **real** application credentials - no tenant row is visible without a tenant
context. Then Redis (reachable, `noeviction`, AOF), ClamAV, and backup evidence.

Exit code `0` = no FAIL, `1` = at least one FAIL (`--strict`: WARN counts too), `2` = the
script could not run. It never prints secret values. Backup evidence is either the marker
file written by `scripts/db-backup.sh` (fresh, encrypted, off-site, drill record next to it)
or `BACKUP_PROVIDER_MANAGED=true`, which is only a declaration and is therefore reported as
WARN, never PASS.

### Example of a failing run (real output)

Run in the authoring workspace against the local development environment
(`.env.dev-local`, database `typease_dev`). This is what "not ready" looks like - the
structural database checks pass, everything that makes it a development environment fails:

```
$ node scripts/production-readiness.mjs --env-file .env.dev-local
TypEase production readiness - 2026-10-08T23:40:18.049Z
Target: .env.dev-local

Environment
  FAIL  NODE_ENV is production                                    NODE_ENV is "development" - the API only applies its production safety checks when
                                                                  it is "production"
  FAIL  JWT_ACCESS_SECRET is not a placeholder                    looks like a placeholder / development value (matches the placeholder pattern)
  FAIL  HMAC_KEY is not a placeholder                             looks like a placeholder / development value (matches the placeholder pattern)
  PASS  DATA_ENCRYPTION_KEY is set and not a placeholder          44 characters
  FAIL  INTERNAL_API_TOKEN is set                                 not set: the built-in development default would be used
  FAIL  DATA_ENCRYPTION_KEY is random                             the key is a known development key or is not random bytes (printable text / low
                                                                  variety)
  PASS  Secrets are distinct                                      3 secrets, all different
  FAIL  PAYMENT_SANDBOX_ENABLED is off                            the sandbox payment adapter is enabled: payments could be "completed" without money
  FAIL  EXPOSE_DEV_TOKENS is off                                  OTP / verification tokens would be returned in API responses
  FAIL  COOKIE_SECURE is on                                       refresh cookies would be sent over plain HTTP
  FAIL  MFA_ENFORCEMENT is required                               "optional" - privileged roles could sign in without a second factor
  FAIL  RATE_LIMIT_ENABLED is on                                  rate limiting is disabled (login, signup and OTP endpoints are unprotected)
  FAIL  API_PUBLIC_URL is HTTPS                                   not set: the development default http://localhost:4000 would be used
  FAIL  CENTRE_WEB_URL is HTTPS                                   not set: the development default http://localhost:3001 would be used
  FAIL  CUSTOMER_WEB_URL is HTTPS                                 not set: the development default http://localhost:3002 would be used
  FAIL  CORPORATE_WEB_URL is HTTPS                                not set: the development default http://localhost:3003 would be used
  FAIL  PLATFORM_ADMIN_URL is HTTPS                               not set: the development default http://localhost:3004 would be used
  PASS  CORS_ORIGINS are HTTPS origins                            none (the four app URLs and verified tenant domains are always allowed)
  FAIL  PLATFORM_BASE_DOMAIN is a real domain                     "typease.localhost" is not a public host name
  FAIL  CUSTOM_DOMAIN_CNAME_TARGET is a real domain               not set: the development default portal.typease.localhost would be used
  FAIL  DATABASE_URL password is strong                           password is 10 characters and/or a known development / placeholder value
  FAIL  DATABASE_SYSTEM_URL password is strong                    password is 13 characters and/or a known development / placeholder value
  FAIL  DATABASE_MIGRATION_URL password is strong                 password is 12 characters and/or a known development / placeholder value
  PASS  Database roles have different passwords                   3 roles
  PASS  REDIS_URL is set                                          redis://127.0.0.1:6379/0
  WARN  QUEUE_DRIVER is bullmq                                    inline with QUEUE_INLINE_AUTORUN (single-process mode): jobs live in the API's
                                                                  memory and are lost on restart; cron schedules need the worker
  FAIL  STORAGE_DRIVER is s3                                      "local": files would live on the API container's disk (not shared between replicas,
                                                                  lost with the container unless a volume is mounted and backed up)
  WARN  Malware scanning is enabled                               MALWARE_SCANNER=none: uploads are marked SKIPPED and are never scanned
  WARN  Email delivery is configured                              MAIL_DRIVER=log: verification, invitation and password-reset emails are only written
                                                                  to the log
  WARN  MAIL_FROM_ADDRESS is a real address                       "no-reply@typease.localhost" will be rejected by mail servers
  WARN  SMS delivery is configured                                SMS_DRIVER=log: OTP login and SMS notifications are only written to the log
  WARN  Platform payment gateway is configured                    no STRIPE_SECRET_KEY: subscription invoices can only be settled offline by a
                                                                  platform admin
Database
  PASS  Database is reachable                                     typease_dev as typease_owner, PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
  PASS  All migrations are applied                                3 file(s), checksums match
  PASS  typease_app is not SUPERUSER / BYPASSRLS                  no elevated attributes
  PASS  typease_app can log in                                    LOGIN
  PASS  typease_system is not SUPERUSER                           no elevated attributes
  PASS  typease_app is not a member of a privileged role          no memberships
  PASS  Runtime roles own no tables                               108 tables owned by typease_owner
  PASS  RLS is enabled on every table with a tenantId column      101 tenant tables
  PASS  Every tenant table has a tenant policy                    95 with an app_tenant_id() policy, 6 not accessible to typease_app at all
  PASS  No tenant table has an open policy for typease_app        none
  PASS  Tenant context functions exist                            app_tenant_id, app_user_id, assert_same_tenant
  PASS  Append-only / immutability triggers exist                 14 audit and financial integrity triggers
  PASS  Every trigger from the migration files exists             75 triggers (incl. cross-tenant reference guards)
  PASS  No trigger is disabled                                    75 triggers enabled
  FAIL  No demo / test accounts exist                             9 user(s) with a .test / .example / .localhost email address (0 of them platform
                                                                  staff) - demo logins use publicly documented passwords
  FAIL  No demo tenants exist                                     demo / test centres present: alnoor-demo, gulf-demo, mobile-fixture, smoke-test
  FAIL  A platform super admin with MFA exists                    there is no active platform super admin: nobody can operate the platform console
  PASS  Outbox is healthy                                         no failed or stuck events
  PASS  DATABASE_URL credentials work                             logged in as typease_app
  PASS  Application sessions run in UTC                           UTC
  PASS  Without a tenant context typease_app sees no tenant rows  probed 95 tables with the real application credentials: 0 rows visible
Services
  PASS  Redis is reachable                                        redis 7.0.15 at redis://127.0.0.1:6379/0
Backups
  FAIL  A recent database backup exists                           no evidence: pass --backup-marker <file written by scripts/db-backup.sh> (or
                                                                  BACKUP_MARKER_FILE), or set BACKUP_PROVIDER_MANAGED=true for provider-managed
                                                                  backups

Summary: 24 PASS, 6 WARN, 25 FAIL, 0 SKIP  ->  NOT READY FOR PRODUCTION
exit code: 1
```

## 13. Smoke test

```bash
scripts/smoke-test.sh --api https://api.example.ae --slug <a centre> \
  --allowed-origin https://app.example.ae --web https://app.example.ae --web https://admin.example.ae
SMOKE_EMAIL=... SMOKE_PASSWORD=... scripts/smoke-test.sh --api https://api.example.ae      # adds login + an authenticated call
```

Through the public host name it also proves that `/api/v1/internal/*` never reaches the API,
that HTTP redirects to HTTPS and that the security headers are present. `--direct` skips
those proxy-only checks. Use a dedicated low-privilege account for the login check (an
account with two-step verification is reported as "password accepted" and the
authenticated call is skipped).

Real output, against the API that was running in the authoring workspace on
`http://localhost:4000` (no proxy, hence `--direct`):

```
$ SMOKE_EMAIL=owner@alnoor-demo.test SMOKE_PASSWORD=*** scripts/smoke-test.sh \
    --api http://localhost:4000 --direct --slug alnoor-demo --allowed-origin http://localhost:3001
TypEase smoke test - 2026-10-08T23:40:25Z
Target: http://localhost:4000  (direct: proxy-only checks are skipped)

PASS  GET /health                                    200 status=ok
PASS  GET /health/ready                              200 {"status":"ready","checks":{"database":true,"systemDatabase":true,"redis":true}}
PASS  GET /api/v1/public/plans                       200, 4 plan(s)
PASS  GET /api/v1/public/tenant-config?slug=alnoor-demo 200 name="Al Noor Typing Centre"
PASS  POST /api/v1/auth/login                        200 status=OK (access token received, not shown)
PASS  GET /api/v1/auth/me (authenticated)            200
PASS  GET /api/v1/auth/me (no token)                 401 as expected
PASS  CORS preflight from http://localhost:3001      204 allow-origin echoed, credentials allowed
PASS  CORS preflight from a disallowed origin        HTTP 404, no access-control-allow-origin header
SKIP  /api/v1/internal/metrics is not public         --direct: only meaningful through the public host name
SKIP  /api/v1/internal/tls/ask is not public         --direct
SKIP  HTTP redirects to HTTPS                        --direct
SKIP  Security headers from the proxy                --direct

Summary: 9 PASS, 0 FAIL, 4 SKIP
exit code: 0
```

Run without `--direct` against the same unproxied API, the three internal-path checks fail
("the request REACHED the API") - which is the point of the check.

## 14. Go-live checklist

**Configuration and build**
- [ ] CI is green on the release tag (including `scripts/validate-infra.sh --strict`, image builds and Trivy).
- [ ] Third-party image tags reviewed, bumped and pinned by digest; GitHub Actions pinned by SHA.
- [ ] `pnpm check:production` against the production env files and database: **0 FAIL**, every WARN read and accepted in writing.
- [ ] `NODE_ENV=production`, `MFA_ENFORCEMENT=required`, `COOKIE_SECURE=true`, `PAYMENT_SANDBOX_ENABLED=false`, `EXPOSE_DEV_TOKENS=false`, `RATE_LIMIT_ENABLED=true`, `REQUIRE_CLEAN_SCAN=true`.
- [ ] No demo data: the seed was never run against this database (the readiness check looks for `.test` accounts and demo centres).
- [ ] Web images were built with the production `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_STORAGE_ORIGINS`.

**Data protection of the installation**
- [ ] Database: managed with PITR, or daily `db-backup.sh` with off-site copy; `TypeaseBackupTooOld` alert tested.
- [ ] **Restore drill performed** from the off-site copy on a separate instance; duration recorded as the RTO input; `last-restore-drill.json` in place.
- [ ] Object storage: documents bucket private (verified with an anonymous request), SSE, versioning, `incoming/` lifecycle, replication or mirror.
- [ ] `DATA_ENCRYPTION_KEY`, `HMAC_KEY`, backup private key (and `MINIO_KMS_SECRET_KEY`, `N8N_ENCRYPTION_KEY`) escrowed off the host with two named key holders.
- [ ] Env files `0600` root, or secrets served from a secret manager.

**Edge**
- [ ] DNS records, certificates for all platform hosts; a test custom domain verified end to end (TXT, CNAME, on-demand certificate).
- [ ] `scripts/smoke-test.sh` through the public URL: 0 FAIL, including "internal endpoints are not public".
- [ ] Firewall: only 80 / 443 reachable from the internet; SSH restricted.

**Functional, with real providers**
- [ ] Email delivered (verification, invitation, password reset) with SPF / DKIM / DMARC passing.
- [ ] SMS OTP delivered, if phone verification is on.
- [ ] One document uploaded, scanned CLEAN, downloaded; the EICAR file quarantined.
- [ ] One test-mode payment end to end, webhook received and verified; then live keys.
- [ ] First platform super admin created, MFA enrolled, recovery codes stored; a second admin exists.
- [ ] A new centre can sign up, complete onboarding, create a request and issue an invoice.

**Operations**
- [ ] Monitoring profile running; Alertmanager has a real receiver; a test alert reached a person; external uptime check configured.
- [ ] On-call contact, escalation path and the incident procedure are written down.
- [ ] Rollback rehearsed once on staging (`scripts/deploy.sh <previous> --skip-migrate`).
- [ ] Log retention decided and configured; access to Grafana / logs restricted.

**Security review**
- [ ] Review of this deployment against `docs/` security documentation (tenant isolation, security checklist) by someone who did not build it.
- [ ] Tenant-isolation and security test suites green against a production-like database (through the pooler, if one is used).
- [ ] Dependency audit and image scan findings triaged; no known critical vulnerability open.
- [ ] External penetration test, or a documented decision to go live without one and a date for it.
- [ ] Secrets rotated from any value that was ever used in development, shared in chat or committed.

**Legal and compliance** (decisions for qualified advisers - technical controls do not establish compliance)
- [ ] UAE personal-data protection review (federal PDPL and any free-zone regime that applies): lawful bases, privacy notice, retention periods including backups and logs, data-subject request process.
- [ ] Data residency and cross-border transfers: hosting region, each sub-processor (hosting, email, SMS, WhatsApp, payment gateway, error / log tooling) recorded in the processor register with agreements in place.
- [ ] Terms of service, privacy policy and customer consent texts approved and published in English and Arabic.
- [ ] Payment processing: gateway contract, PCI DSS scope confirmed (card data must never touch TypEase), VAT / tax-invoice requirements of the invoices checked by an accountant.
- [ ] Use of government-service data and branding checked against the integration policy of the product specification.
- [ ] Incident notification duties and contacts documented.
