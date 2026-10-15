# TypEase

TypEase is a multi-tenant, white-label management system for UAE typing centres.
Each centre (tenant) gets a staff application for requests, customers, documents, quotations, invoices,
payments, appointments, a walk-in queue, reminders, automations and reports.
Its customers and corporate clients use web portals, and a Flutter mobile app exists as source code.
A platform console is used by the operator to manage centres, plans, subscriptions and support access.
TypEase prepares and tracks work; it does not connect to or automate any government portal.

## Status

> **Read this before relying on anything.** This repository is a development build. It has not been
> independently reviewed, and several parts have never been executed. What was tested, and with what result,
> is recorded in [docs/TEST_REPORT.md](docs/TEST_REPORT.md). What is missing or unverified is listed in
> [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

| Area | State |
| --- | --- |
| API and background jobs (`services/api`, `services/worker`) | Run in the build environment on Node 22 against PostgreSQL 16 and Redis 7. Automated tests exist for every module; see the test report for results |
| Database (`database/`) | 107 tables with row-level security, applied from hand-reviewed SQL migrations. Tenant isolation is tested at database level |
| Staff application (`apps/centre-web`) | All screens built |
| Customer portal (`apps/customer-web`), corporate portal (`apps/corporate-portal`), platform console (`apps/platform-admin`) | All screens built. The corporate portal was completed last and has had the least checking |
| Tests | Package unit tests, the API suite and the 30-scenario acceptance suite (`tests/integration`, `tests/security`) ran in the build environment; ESLint is configured for every package. **No browser end-to-end suite exists** (`tests/e2e` is empty). Results: [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |
| Mobile app (`apps/customer-mobile`) | Flutter source only. **Never compiled or run** |
| Docker images, Compose stacks, reverse proxy, monitoring stack | Written and validated statically. **Never built or started** |
| CI workflows (`.github/workflows`) | Written. **Never run** |
| External providers (Stripe, Twilio, Meta WhatsApp, FCM, S3, ClamAV, SMTP relay, external OCR, n8n) | Adapters exist and are exercised against local fakes or log drivers only. **None was verified against the real service.** Without credentials they report "not configured" |
| Government services | **No integration with any government portal or API.** Staff record references and statuses by hand; such statuses are always labelled with their source and never presented as official |
| Security | No independent security review or penetration test. See [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md) |
| Legal | No legal or tax review. See [docs/UAE_COMPLIANCE_REVIEW.md](docs/UAE_COMPLIANCE_REVIEW.md) |
| Languages | User interfaces in English and Arabic. API messages in English only. PDFs in English (Latin-1 characters) only |

## Contents

- [Repository map](#repository-map)
- [Prerequisites](#prerequisites)
- [Quick start without Docker](#quick-start-without-docker)
- [Quick start with Docker Compose](#quick-start-with-docker-compose)
- [Demo logins](#demo-logins)
- [Tests, type-checks and builds](#tests-type-checks-and-builds)
- [Documentation index](#documentation-index)
- [Licence](#licence)

## Repository map

A pnpm workspace (`pnpm-workspace.yaml`). The Flutter app is outside the workspace.

| Path | What it is |
| --- | --- |
| `services/api` | NestJS REST API: 26 modules under `src/modules`, shared code under `src/common`, command-line tools under `src/cli` (demo seed, OpenAPI generator, platform administrator) |
| `services/worker` | Launcher of the background worker (BullMQ consumer, schedulers, outbox dispatcher). The job handlers live in the API package |
| `database` | Prisma schema (used as ORM client only), hand-reviewed SQL migrations in `migrations/`, the migration runner in `scripts/migrate.ts`, the seed launcher |
| `apps/centre-web` | Staff application (Next.js), port 3001 |
| `apps/customer-web` | Customer portal (Next.js), port 3002 |
| `apps/corporate-portal` | Corporate portal (Next.js), port 3003 |
| `apps/platform-admin` | Platform console (Next.js), port 3004 |
| `apps/customer-mobile` | Customer mobile app (Flutter source) |
| `packages/types` | Shared types, the request state machine, event names |
| `packages/validation` | Zod schemas shared by API and web apps |
| `packages/permissions` | Permission keys and built-in roles |
| `packages/api-client` | Typed client for the API (hand-written) |
| `packages/ui` | Shared React components, providers, translations infrastructure |
| `packages/branding` | Brand tokens, logo, white-label colour maths |
| `packages/config` | Shared Next.js, TypeScript and security-header configuration |
| `infrastructure` | Dockerfiles, Caddy configuration, environment templates, monitoring configuration, gitleaks rules |
| `scripts` | Development, deployment, backup, readiness and smoke-test scripts |
| `tests` | The acceptance suite: `integration` (9 files) and `security` (6 files) drive the 30 required scenarios over HTTP ([tests/README.md](tests/README.md)). **The `e2e` folder is empty: there is no browser test suite** |
| `docs` | Documentation (index below) |

## Prerequisites

| For | You need |
| --- | --- |
| Running on the host | Node.js 22.12 or newer; pnpm 10.28 (`corepack enable`, or `npm i -g pnpm@10.28.0`); PostgreSQL 16; Redis 7; `psql` |
| Running in containers | Docker Engine with the Compose plugin |
| The mobile app | Flutter SDK; see [apps/customer-mobile/README.md](apps/customer-mobile/README.md) |

Versions last used to develop and run the project (2026-10-15, macOS). If a newer version fails, install these:

| Tool | Version | Check with |
| --- | --- | --- |
| Node.js | 25.6.1 (`package.json` requires 22.12 or newer) | `node -v` |
| pnpm | 10.28.0 (pinned in `package.json` `packageManager`) | `pnpm -v` |
| PostgreSQL | 16.14 | `psql --version` |
| Redis | 8.10.1 | `redis-server --version` |
| Docker | 29.8.1 | `docker --version` |
| Flutter | 3.41.6 (stable) | `flutter --version` |

## Quick start without Docker

This is the path that was used while the software was built. It needs PostgreSQL and Redis on `127.0.0.1`.

**1. Create the database owner and the database** (once, as a PostgreSQL superuser):

```bash
psql -U postgres -v ON_ERROR_STOP=1 -v db=typease -v owner=typease_owner -v owner_password=owner_dev_pw \
     -f infrastructure/docker/postgres/bootstrap.sql
```

The owner role needs `CREATEROLE` and must not be a superuser. The first migration creates the two run-time
roles, `typease_app` (restricted by row-level security) and `typease_system`.

**2. Environment.** `.env.example` holds development values for every variable the API validates.

```bash
cp .env.example .env
set -a; . ./.env; set +a
```

The API, the worker and the migration runner read the process environment. They do not read `.env` files
themselves, so the second line is needed in every new shell. The values in `.env.example` are development
values and are rejected by the production checks.

**3. Install, build the shared packages, migrate.**

```bash
pnpm install
pnpm build:packages
pnpm db:migrate
```

`pnpm build:packages` generates the Prisma client and compiles the shared packages; the API imports their
build output, so run it again after changing a package. `pnpm db:migrate` applies `database/migrations/*.sql`
as the owner and sets the passwords of the two run-time roles from `DATABASE_URL` and `DATABASE_SYSTEM_URL`.

Only on a machine that cannot download Prisma's engine binaries: export
`PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` before `pnpm install`. Migrations do not use that engine.

**4. Demo data** (optional; development only; the database must have no centres, and the API and worker
must be stopped):

```bash
pnpm db:seed --env-file=.env
```

It drives the real API and takes a few minutes. See [docs/DEMO_ENVIRONMENT.md](docs/DEMO_ENVIRONMENT.md).

**5. Start the processes**, each in its own shell with the environment loaded:

```bash
pnpm dev:api          # http://localhost:4000   API; Swagger UI at /api/docs outside production
pnpm dev:centre       # http://localhost:3001   staff application
pnpm dev:customer     # http://localhost:3002   customer portal (add ?tenant=<slug>)
pnpm dev:corporate    # http://localhost:3003   corporate portal (add ?tenant=<slug>)
pnpm dev:admin        # http://localhost:3004   platform console
```

`.env.example` runs the API in single-process mode (`QUEUE_DRIVER=inline`, `QUEUE_INLINE_AUTORUN=true`):
the API runs queued jobs and interval schedules itself, files are stored on the local disk, and email, SMS,
WhatsApp and push are written to the log instead of being sent. A separate worker is needed only with
`QUEUE_DRIVER=bullmq`:

```bash
pnpm dev:worker
```

Jobs with a cron schedule (for example the daily reminder scan) run only in the worker.

The web apps call `http://localhost:4000` by default; `apps/<app>/.env.example` shows the variables to
override.

Check that the API is up:

```bash
curl http://localhost:4000/health
```

One script does steps 2 to 5 (without creating the database role):
`scripts/dev-up.sh --host --no-docker-deps`. It was written for this purpose; run `scripts/dev-up.sh --help`
for its options and stop what it started with `scripts/dev-down.sh`.

**Small helper scripts used during the build** (all in `scripts/`, documented at the top of each file):
`dev-api.sh` starts the API from its production build with the settings in a local `.env.dev-local` file
(copy `.env.example`; the file is git-ignored); `dev-web-supervised.sh <app> <port>` runs one Next.js dev
server and restarts it when it grows beyond a memory limit (useful on small machines);
`start-web-standalone.sh <app> <port>` serves the standalone production build of one web app;
`dev-stop.sh` stops what those started; `ci-api-tests.sh` runs the whole API test suite detached and writes
its summary next to the log; `seed-verify.mjs` checks a seeded database read-only.

**Creating the first platform administrator** without the demo seed:

```bash
PLATFORM_ADMIN_PASSWORD='choose-a-long-password' \
  pnpm --filter @typease/api platform-admin -- --email ops@example.com --name "Operations Lead"
```

## Quick start with Docker Compose

> **Not executed in the build environment.** `docker-compose.yml`, the Dockerfiles and the Caddy
> configuration were validated statically (`pnpm check:infra`) but no image was built and no container was
> started. Expect to fix things on the first run.

```bash
docker compose --profile full up -d --build      # database, Redis, object store, API, worker, web apps, proxy
docker compose --profile seed run --rm seed      # optional demo data
```

or, in one step including the demo data: `scripts/dev-up.sh` (stop with `scripts/dev-down.sh`).

Intended addresses (browsers resolve `*.localhost` to `127.0.0.1`): staff application
`http://app.typease.localhost`, customer portal `http://<slug>.typease.localhost`, corporate portal
`http://corporate.typease.localhost`, platform console `http://admin.typease.localhost`, API
`http://api.typease.localhost`.

To run only the dependencies in containers and the applications on the host:
`docker compose --profile deps up -d`, then `scripts/dev-up.sh --host`.

Production deployment is described in [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md). It uses
`docker-compose.prod.yml`, which has not been executed either.

## Demo logins

After `pnpm db:seed` there are three fictional centres (`al-noor`, `gulf-star`, `desert-rose`) with staff,
customers, companies and requests in every status. All accounts use the same public demo password. The
accounts, the password and what each centre demonstrates are listed in
[docs/DEMO_ENVIRONMENT.md](docs/DEMO_ENVIRONMENT.md), section 2. All people, companies and numbers in the
seed are invented. Never run the seed against a production database.

## Tests, type-checks and builds

| Command | What it does | Needs |
| --- | --- | --- |
| `pnpm typecheck` | TypeScript check of every workspace package, one after the other | `pnpm build:packages` first |
| `pnpm lint` | ESLint 9 for every workspace package, one at a time ([docs/architecture/LINTING.md](docs/architecture/LINTING.md)) | same |
| `pnpm test:unit` | Unit tests of the shared packages (Vitest; `node --test` for `packages/config`) | - |
| `pnpm test:api` | API unit and integration tests (Jest, one file at a time) | PostgreSQL and Redis; see below |
| `pnpm --filter @typease/api test:unit` | Only the API tests that need no database (`*.unit.spec.ts`) | - |
| `pnpm test` | `pnpm test:unit`, then `pnpm test:api` | as above |
| `pnpm test:integration`, `pnpm test:security` | The acceptance suite in `tests/` (30 scenarios over HTTP; [docs/TESTING.md](docs/TESTING.md)) | PostgreSQL and Redis; see below |
| `pnpm test:e2e` | Defined, but `tests/e2e` is empty and its Playwright configuration does not exist: **the command cannot run** | - |
| `pnpm lint:root` | ESLint for the root `scripts/` folder only | - |
| `pnpm build` | Shared packages, API, worker and the four web apps | - |
| `pnpm build:packages`, `pnpm build:api`, `pnpm build:web` | The three parts of `pnpm build` | - |
| `pnpm openapi` | Regenerates `docs/api/openapi.json` and `docs/api/ENDPOINTS.md` from the API | `pnpm build:packages` |
| `pnpm check:infra` | Static validation of the infrastructure files | - |
| `pnpm check:production -- --env-file <file>` | Read-only readiness check of an environment and its database | A database to inspect |
| `pnpm smoke` | Post-deployment smoke test with curl (`scripts/smoke-test.sh --help`) | A running API |

**Database for the API tests.** The tests rebuild a dedicated database from the real migration files before
they run, so they exercise row-level security as it is in production. By default they use
`typease_test` on `127.0.0.1:5432`, owned by `typease_owner` with the password of `.env.example`, and Redis
database 1. Create the database once:

```bash
psql -U postgres -v ON_ERROR_STOP=1 -v db=typease_test -v owner=typease_owner -v owner_password=owner_dev_pw \
     -f infrastructure/docker/postgres/bootstrap.sql
```

Other locations can be set with `TEST_PG_HOST`, `TEST_PG_PORT`, `TEST_PG_DATABASE`, `TEST_DATABASE_URL`,
`TEST_DATABASE_SYSTEM_URL`, `TEST_DATABASE_MIGRATION_URL` and `TEST_REDIS_URL`
(`services/api/test/env.ts`). The run-time roles are shared by all databases of a PostgreSQL server, and
the migration runner sets their passwords from the URLs: keep the test URLs and your development URLs on
the same passwords.

`pnpm test:integration` and `pnpm test:security` run the acceptance suite in `tests/` (the 30 scenarios of
the specification and the security boundaries; see [docs/TESTING.md](docs/TESTING.md) and
[tests/README.md](tests/README.md)). `pnpm test:e2e` exists but `tests/e2e` is empty: there is no browser
test suite. Tenant isolation is also tested inside the API test suite
([docs/TENANT_ISOLATION.md](docs/TENANT_ISOLATION.md), section 8). The Flutter tests have never been run.

Results of test runs are recorded in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Documentation index

**Start here**

| Document | Content |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, request flow, modules, events and jobs, design decisions |
| [docs/DEMO_ENVIRONMENT.md](docs/DEMO_ENVIRONMENT.md) | The demo seed: centres, logins, scenarios |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | What was tested and the results |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | What is missing, partial or unverified |

**Reference**

| Document | Content |
| --- | --- |
| [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) | Conventions, authentication, errors, rate limits, worked examples |
| [docs/api/ENDPOINTS.md](docs/api/ENDPOINTS.md), [docs/api/openapi.json](docs/api/openapi.json) | Generated endpoint list and OpenAPI document |
| [docs/api/modules/](docs/api/modules/) | One reference per API module: [appointments](docs/api/modules/appointments.md), [audit](docs/api/modules/audit.md), [automation](docs/api/modules/automation.md), [catalogue](docs/api/modules/catalogue.md), [corporate](docs/api/modules/corporate.md), [customers](docs/api/modules/customers.md), [dashboard](docs/api/modules/dashboard.md), [documents](docs/api/modules/documents.md), [finance](docs/api/modules/finance.md), [integrations](docs/api/modules/integrations.md), [notifications](docs/api/modules/notifications.md), [ocr](docs/api/modules/ocr.md), [platform](docs/api/modules/platform.md), [privacy](docs/api/modules/privacy.md), [queue](docs/api/modules/queue.md), [reminders](docs/api/modules/reminders.md), [reports](docs/api/modules/reports.md), [requests](docs/api/modules/requests.md), [subscriptions](docs/api/modules/subscriptions.md), [support](docs/api/modules/support.md), [tasks](docs/api/modules/tasks.md), [workflows](docs/api/modules/workflows.md) |
| [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Tables, enums, integrity rules, migration procedure |
| [docs/WORKFLOW_DOCUMENTATION.md](docs/WORKFLOW_DOCUMENTATION.md) | Request statuses, workflow builder, forms, documents, money, appointments, reminders, automations, submission channels |
| [docs/workflows/REQUEST_LIFECYCLE.md](docs/workflows/REQUEST_LIFECYCLE.md) | Generated transition table, guards and the workflow engine |
| [docs/ROLE_PERMISSION_MATRIX.md](docs/ROLE_PERMISSION_MATRIX.md) | Roles and permissions |
| [docs/WHITE_LABEL_GUIDE.md](docs/WHITE_LABEL_GUIDE.md) | Branding, custom domains, mobile white label |

**Security and compliance**

| Document | Content |
| --- | --- |
| [docs/TENANT_ISOLATION.md](docs/TENANT_ISOLATION.md) | How centres are kept apart and how to verify it |
| [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md) | Each control: status, place in the code, test; pre-go-live checklist |
| [docs/UAE_COMPLIANCE_REVIEW.md](docs/UAE_COMPLIANCE_REVIEW.md) | Engineering self-assessment for review by UAE advisers. Not legal advice |
| [docs/security/BACKUP_AND_RECOVERY.md](docs/security/BACKUP_AND_RECOVERY.md) | Backup, restore, recovery |

**Operations**

| Document | Content |
| --- | --- |
| [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md) | Environments, first production deployment, readiness check, smoke test |
| [docs/deployment/docker.md](docs/deployment/docker.md) | Images and Compose stacks |
| [docs/deployment/reverse-proxy-and-tls.md](docs/deployment/reverse-proxy-and-tls.md) | Caddy, certificates, custom domains |
| [docs/deployment/secrets.md](docs/deployment/secrets.md) | Secrets and their handling |
| [docs/deployment/object-storage.md](docs/deployment/object-storage.md) | S3-compatible storage |
| [docs/deployment/scaling.md](docs/deployment/scaling.md) | Running several instances |
| [docs/deployment/upgrades-and-rollbacks.md](docs/deployment/upgrades-and-rollbacks.md) | Upgrade and rollback procedure |
| [docs/deployment/monitoring.md](docs/deployment/monitoring.md), [infrastructure/monitoring/README.md](infrastructure/monitoring/README.md) | Metrics, alerts, logs |
| [docs/deployment/ci-cd.md](docs/deployment/ci-cd.md) | CI and release workflows |
| [infrastructure/docker/env/README.md](infrastructure/docker/env/README.md) | Environment files of the Compose stacks |

**User guides**

| Document | For |
| --- | --- |
| [docs/user-guides/CUSTOMER_USER_GUIDE.md](docs/user-guides/CUSTOMER_USER_GUIDE.md) | Customers and company users of a centre |
| [docs/user-guides/STAFF_USER_GUIDE.md](docs/user-guides/STAFF_USER_GUIDE.md) | Receptionists, operators, reviewers, accountants |
| [docs/user-guides/OWNER_USER_GUIDE.md](docs/user-guides/OWNER_USER_GUIDE.md) | Centre owners and managers |
| [docs/user-guides/PLATFORM_ADMIN_GUIDE.md](docs/user-guides/PLATFORM_ADMIN_GUIDE.md) | The operator's administrators and support agents |

**For developers**

| Document | Content |
| --- | --- |
| [docs/architecture/BACKEND_CONVENTIONS.md](docs/architecture/BACKEND_CONVENTIONS.md) | Rules for API modules |
| [docs/architecture/FRONTEND_CONVENTIONS.md](docs/architecture/FRONTEND_CONVENTIONS.md) | Rules for the web apps |
| [docs/architecture/WORKER.md](docs/architecture/WORKER.md) | The background worker |
| [docs/TESTING.md](docs/TESTING.md), [tests/README.md](tests/README.md) | Test levels, how to run them, scenario traceability of the acceptance suite |
| [docs/architecture/LINTING.md](docs/architecture/LINTING.md) | ESLint set-up and warning budgets |
| [docs/architecture/APP_BUILDER_RULES.md](docs/architecture/APP_BUILDER_RULES.md), [PAGE_BUILDER_RULES.md](docs/architecture/PAGE_BUILDER_RULES.md), [WORKSTREAM_RULES.md](docs/architecture/WORKSTREAM_RULES.md) | Working rules used while the software was built; they describe the build environment, not the product |
| [apps/customer-mobile/README.md](apps/customer-mobile/README.md), [ARCHITECTURE.md](apps/customer-mobile/ARCHITECTURE.md), [SCREEN_ENDPOINT_MAP.md](apps/customer-mobile/SCREEN_ENDPOINT_MAP.md), [WHITE_LABEL_MOBILE.md](apps/customer-mobile/WHITE_LABEL_MOBILE.md) | The Flutter app |
| [docs/brand/MASTER_PROMPT.md](docs/brand/MASTER_PROMPT.md) | The product specification. It states what was asked for, not what was built |

## Licence

Proprietary - all rights reserved by the product owner.
