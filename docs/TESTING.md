# Testing TypEase

What is tested at which level, how to run each level, and what a run needs. For the scenario-by-scenario
table of the acceptance suite see `tests/README.md`; for the conventions of the API's module tests see
`docs/architecture/BACKEND_CONVENTIONS.md`, section 8.

## 1. The levels

| Level | Where | Runner | What it answers | State |
| --- | --- | --- | --- | --- |
| 1. Package unit tests | `packages/*/src/**/*.test.ts(x)`, `packages/config/security.test.mjs` | Vitest (`node --test` for `packages/config`) | Does a pure function or a UI component of a shared package do what it says? (validation schemas, permission matrix helpers, API client, branding, UI components) No database, no network | Executed |
| 2a. API unit tests | `services/api/src/**/*.unit.spec.ts` (40 files) | Jest | Pure logic of the API: calculators, parsers, renderers, rule tables. No database | Executed |
| 2b. API module tests | `services/api/src/modules/*/*.spec.ts`, `services/api/test/*.spec.ts` (94 spec files together with 2a) | Jest, real application, real PostgreSQL and Redis | Does ONE module keep its rules? Happy path, tenant isolation per resource, permissions, state transitions including the forbidden ones (Backend conventions, section 8) | Executed |
| 3. Acceptance suite | `tests/integration`, `tests/security` (15 files, 86 tests) | Jest of the API package, real application over HTTP, real PostgreSQL and Redis, jobs inline | Do the modules work TOGETHER? The 30 required end-to-end scenarios of section 34 of the specification, from the outside, the way the web and mobile apps use the API - and do the security boundaries hold across every route? | Executed |
| 4. Browser end-to-end | `tests/e2e` | Playwright (`@playwright/test` is a dev dependency of `tests`) | Do the four web apps let a user do it? Screens, forms, navigation, rendering of the white-label theme | **Not written.** No Playwright configuration and no spec exists; `pnpm test:e2e` prints `tests/e2e/README.md` and exits 1. Screens were verified by engineers with the screenshot runner (`packages/ui/scripts/screenshots.mjs` and the `apps/*/scripts/shots*.mjs` scenario files, about 399 scenarios driving real flows), which is manual verification with pictures, not a suite. `tests/e2e/README.md` lists what the scenarios cover and how to turn them into tests |
| 5. Mobile | `apps/customer-mobile/test` (unit, widget), `apps/customer-mobile/integration_test` | `flutter test` | The Flutter customer app | **Written, never executed: the build environment has no Flutter SDK.** See `apps/customer-mobile/README.md` |

How the levels divide the work:

- A **rule of one module** (a discount needs approval; an operator cannot verify) is tested at level 2b, next to
  the code, with every variation. Level 3 does not repeat the variations; it uses the rule once inside a
  scenario.
- A **scenario that crosses modules** (a customer's request from the portal to the downloaded result; a
  webhook that completes a payment, releases the request and sends a receipt; reports that must equal the
  invoices, payments and refunds that produced them) is tested at level 3.
- **Boundaries that must hold everywhere** (tenant isolation, the permission matrix, authentication) are tested
  per resource at level 2b and across the whole route table at level 3 (`tests/security`): every route of the
  running application is called, so a route added later is covered without anybody remembering it.
- **What the user sees** belongs to levels 4 and 5. Level 3 never starts a browser.

Fixtures differ on purpose: level 2b may prepare its starting point directly in the database
(`services/api/src/modules/*/fixtures.ts`); level 3 builds everything through the public API and touches the
database only to prove what no API can show or to move time (`tests/README.md`, "Rules of the suite").

## 2. Commands

All from the repository root.

| Command | Level | Needs | Typical duration |
| --- | --- | --- | --- |
| `pnpm test:unit` | 1 | - | seconds |
| `pnpm --filter @typease/api test:unit` | 2a | - | seconds |
| `pnpm test:api` | 2a + 2b | PostgreSQL, Redis, test database | minutes |
| `pnpm --filter @typease/api exec jest src/modules/finance` | 2b, one module | as above | |
| `pnpm test` | 1, then 2 | as above | |
| `pnpm test:integration` | 3, scenarios 1-23 and 26-30 | as above | about 1.5 minutes |
| `pnpm test:security` | 3, scenarios 24, 25 and the boundaries around them | as above | about 3.5 minutes |
| `pnpm test:integration 02-request-journey` | 3, one file (anything appended is a jest argument; `-t "S12"` selects by test name) | as above | |
| `pnpm --filter @typease/tests test` | 3, both folders in one run | as above | about 5 minutes |
| `pnpm --filter @typease/tests typecheck` | TypeScript check of the acceptance suite | - | 15 seconds |
| `pnpm test:e2e` | 4 | - | **always exits 1**: prints `tests/e2e/README.md` (no suite exists; see above). The screenshot scenario files are run by hand: `node packages/ui/scripts/screenshots.mjs --app <centre\|customer\|corporate\|platform> --scenarios <file> --out <dir>` against a running app and the demo seed |
| `cd apps/customer-mobile && tool/bootstrap.sh` | 5 (`flutter analyze`, `flutter test`) | Flutter SDK | never run |

`pnpm test` does not include level 3: run `pnpm test:integration` and `pnpm test:security` as well before a
release. Related checks that are not tests: `pnpm typecheck`, `pnpm lint`, `pnpm check:infra`,
`pnpm check:production -- --env-file <file>`, `pnpm smoke` (curl against a running deployment).

The acceptance suite has no dependencies of its own. Its scripts (`tests/package.json`) run the API package's
jest with a configuration that lives in `tests/` (`jest.config.js`, `jest.integration.config.js`,
`jest.security.config.js`); the TypeScript sources of the API and of the shared packages are compiled on the
fly by `@swc/jest`, so nothing has to be built first - except the generated Prisma client
(`database/generated`, produced by `pnpm db:generate` or `pnpm build:packages`).

## 3. Required services

Levels 2b and 3 need:

- **PostgreSQL 16** with the role `typease_owner` and an EMPTY database owned by it for the tests. Before every
  jest invocation the global setup (`services/api/test/global-setup.ts`) drops the schema of that database and
  re-applies the real migration files (`database/migrations`), which also create the run-time roles
  `typease_app` (subject to row-level security) and `typease_system` and set their passwords from the URLs.
  **Never point the tests at a database whose content matters.**
- **Redis 7** (a database number of its own).
- A writable directory for the local storage driver.

Create the default test database once (as a PostgreSQL superuser):

```bash
psql -U postgres -v ON_ERROR_STOP=1 -v db=typease_test -v owner=typease_owner -v owner_password=owner_dev_pw \
     -f infrastructure/docker/postgres/bootstrap.sql
```

`docker compose --profile deps up -d` (what `scripts/dev-up.sh --host` starts) provides PostgreSQL and Redis on
the default ports.

Nothing else is needed and nothing else is contacted: no S3, no SMTP relay, no payment gateway, no SMS /
WhatsApp / push provider, no OCR service, no DNS. Where a scenario needs the other side of such a connection,
the test brings it along on localhost (an SMTP server for scenario 27, the hosted test checkout and its signed
webhook for scenarios 18, 21 and 26, a table instead of DNS for scenario 23).

## 4. Environment variables

Read by `services/api/test/env.ts`, which then fixes the complete configuration of the application under test.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEST_PG_HOST` | `127.0.0.1` | PostgreSQL host |
| `TEST_PG_PORT` | `5432` | PostgreSQL port |
| `TEST_PG_DATABASE` | `typease_test` | Database that is REBUILT for the run |
| `TEST_DATABASE_URL` | `postgresql://typease_app:app_dev_pw@<host>:<port>/<db>` | Tenant connection (role `typease_app`) |
| `TEST_DATABASE_SYSTEM_URL` | `postgresql://typease_system:system_dev_pw@...` | System connection (role `typease_system`) |
| `TEST_DATABASE_MIGRATION_URL` | `postgresql://typease_owner:owner_dev_pw@...` | Schema owner, used by the migration runner |
| `TEST_REDIS_URL` | `redis://127.0.0.1:6379/1` | Redis database |
| `TEST_STORAGE_DIR` | `/tmp/typease-test-storage` | Directory of the local storage driver |
| `TEST_SKIP_DB_RESET` | unset | `true`: do not rebuild the database (only for repeating one file against the state the previous run left; expectations about counters and "first" numbers may then fail) |
| `TEST_VERBOSE` | unset | Show the output of the migration runner |
| `TEST_ENV_OVERRIDES` | unset | JSON object merged over the fixed configuration, e.g. `{"LOG_LEVEL":"debug"}` |
| `DEBUG_REFUSALS`, `DEBUG_SWEEP` | unset | Acceptance suite only: print what the API answered to refused calls (`tests/README.md`) |

The run-time roles are shared by all databases of a PostgreSQL server and the migration runner sets their
passwords from the URLs: keep the passwords of the test URLs and of your development URLs the same.

Several people (or CI jobs) on one machine: give each its own database, Redis database and storage directory,
for example

```bash
TEST_PG_DATABASE=typease_test_main TEST_REDIS_URL=redis://127.0.0.1:6379/5 TEST_STORAGE_DIR=/tmp/typease-test-main \
  pnpm test:security
```

Jest runs one file at a time in one process (`--runInBand`); do not start two runs against the same database.
In the build environment of this repository the Prisma schema engine cannot be downloaded:
`PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` is exported before any pnpm command there, and
`NODE_OPTIONS=--max-old-space-size=1536` keeps a run inside the memory of a small machine.

### What the fixed test configuration means for the results

`services/api/test/env.ts` sets, among others:

| Setting | Value in tests | Consequence |
| --- | --- | --- |
| `QUEUE_DRIVER` | `inline` | Background jobs and the event outbox run when a test calls `t.settle()`; the worker process, BullMQ and cron timing are not part of the run (`services/api/src/modules/platform/worker.bullmq.spec.ts` covers the BullMQ driver) |
| `STORAGE_DRIVER` | `local` | Files are stored encrypted on disk and served through the API's own signed URLs; the S3 driver is not exercised |
| `EXPOSE_DEV_TOKENS` | `true` | Verification, invitation and reset tokens are returned in a `dev` field so that tests can follow the link an email would carry. The application refuses to start in production with this switch on |
| `RATE_LIMIT_ENABLED` | `false` | Rate limits are NOT exercised at levels 2b and 3 |
| `MFA_ENFORCEMENT` | `optional` | Privileged roles are not forced to enrol; MFA itself is tested in `services/api/test/foundation.spec.ts` |
| `ONBOARDING_REQUIRE_PHONE_VERIFICATION` | `false` | No SMS provider is needed to finish onboarding |
| `PAYMENT_SANDBOX_ENABLED` | `true` | The test gateway (`sandbox`) exists: a checkout page on the API itself that posts correctly signed webhooks. No money moves; refused in production. The Stripe adapter is never executed against Stripe |
| `OCR_PROVIDER` | `disabled` | The AI document assistant answers `503 INTEGRATION_NOT_CONFIGURED`; OCR is tested in its own module (`services/api/src/modules/ocr/*.spec.ts`) |
| `MALWARE_SCANNER` | `none` | Only the built-in signature check (EICAR test string) runs |
| `PLATFORM_BASE_DOMAIN` | `typease.test` | Centre addresses are `<slug>.typease.test`; DNS lookups for custom domains are replaced by a table |

## 5. Reading a failure of the acceptance suite

- A step that must succeed fails with the request and the API's own words:
  `POST /requests/…/submit as customer-…@example.test -> 422 FORM_INVALID: … (expected 200 or 201)`.
- The walks over the route table collect everything that is wrong and fail once, with one line per route.
- A wrong refusal: run the file with `DEBUG_REFUSALS=1`.
- Files of a folder share one database and run in name order; a file never relies on another file's data, so a
  single file can always be run on its own.
- When the PRODUCT is wrong, the test is not bent: the assertion stays as the specification demands and gets a
  `// PRODUCT DEFECT:` comment with expected and actual behaviour; the defect goes to the backend with route,
  request, expected and actual, and the test must pass unchanged once it is fixed.
- Known sensitivities (midnight in Dubai at 20:00 UTC, the real waiting for link expiry): `tests/README.md`,
  last section.

## 6. Last recorded run of the acceptance suite

13 October 2026, commit `04c2f34`, build environment (2 cores, 8 GB, PostgreSQL 16, Redis 7, Node 22.22.0,
pnpm 10.28.0), from the repository root with a dedicated test database (`typease_test_b2`), while another
engineer's builds ran on the same machine. Full record with commands, logs and summary lines:
[verification/acceptance-run.md](verification/acceptance-run.md).

| Command | Suites | Tests | Failed | Duration (jest / wall clock) |
| --- | --- | --- | --- | --- |
| `pnpm test:integration` | 9 passed | 54 passed | 0 | 122 s / 133 s |
| `pnpm test:security` | 6 passed | 32 passed | 0 | 237 s / 241 s |
| `pnpm --filter @typease/tests typecheck` | - | - | 0 errors | 19 s |

Nothing was re-run; no test was skipped. The previous recorded run (9 October 2026) had the same counts
(91 s, 213 s, 12 s on an idle machine). No product defect is open against the suite. Level 4 has no suite
(`pnpm test:e2e` exits 1 by design) and level 5 has never been executed.
