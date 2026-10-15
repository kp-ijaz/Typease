# Test report

What was executed against this build of TypEase, with what result, and what the results do and do not
prove. The companion document, [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), lists what is missing or
unverified. How each test level works and how to run it is in [TESTING.md](TESTING.md); the scenario-by-
scenario traceability of the acceptance suite is in [../tests/README.md](../tests/README.md).

The "Final run" figures are the final figures as of 13 October 2026: they come from the final verification
run on the packaged source (commit `04c2f34`), executed one command at a time from the repository root by the
release engineer; the per-command record (exact command, exit code, summary lines, wall time, log path) is in
[verification/final-run.md](verification/final-run.md). Figures given as "last recorded run" were taken from
the runs recorded while this document was written and are kept for comparison; where they differ, the final
run figures are the ones that describe this build. Where a figure could not be produced by that run, the cell
says "not run" with the reason - no figure in this document is estimated.

## Contents

1. [Scope and environment](#1-scope-and-environment)
2. [Commands executed and results](#2-commands-executed-and-results)
   - [2.1 Lint](#21-lint)
   - [2.2 Type-check](#22-type-check)
   - [2.3 Package unit tests](#23-package-unit-tests)
   - [2.4 API test suite](#24-api-test-suite)
   - [2.5 Acceptance suite: integration](#25-acceptance-suite-integration)
   - [2.6 Acceptance suite: security](#26-acceptance-suite-security)
   - [2.7 Browser verification (not automated)](#27-browser-verification-not-automated)
   - [2.8 Flutter tests (not executed)](#28-flutter-tests-not-executed)
   - [2.9 Production builds](#29-production-builds)
   - [2.10 Infrastructure validation (static)](#210-infrastructure-validation-static)
   - [2.11 Demo seed and verification](#211-demo-seed-and-verification)
3. [What the tests prove and what they do not](#3-what-the-tests-prove-and-what-they-do-not)
4. [Known failing, skipped and flaky tests](#4-known-failing-skipped-and-flaky-tests)
5. [Answers to section 39 of the specification](#5-answers-to-section-39-of-the-specification)

## 1. Scope and environment

| Item | Value |
| --- | --- |
| Machine | Isolated Linux container, 2 CPU cores, 8 GB RAM. Network access to package registries only |
| Runtimes present | Node.js 22, pnpm 10.28, PostgreSQL 16, Redis 7, a Chromium build for the Playwright library (`PLAYWRIGHT_BROWSERS_PATH`), Tesseract with the English model |
| Runtimes absent | Flutter SDK, Docker daemon, Caddy binary, `shellcheck`, `hadolint`, `actionlint`, `promtool` |
| External access | None: no payment gateway, mail relay, SMS / WhatsApp / push provider, object store, ClamAV daemon, OCR vendor, n8n, DNS or certificate authority was reachable |
| Memory settings used | `NODE_OPTIONS=--max-old-space-size=1536` for jest runs, `2048` for lint; `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` because Prisma's engine could not be downloaded (migrations do not use it) |
| Test database | `typease_test`, dropped and rebuilt from `database/migrations/*.sql` before every jest invocation, so row-level security, triggers and grants are the production ones (`services/api/test/global-setup.ts`) |

**Could run here:** lint, type-check, package unit tests, the API test suite and the acceptance suite
(all against real PostgreSQL and Redis), production builds of packages, API, worker and the four web apps,
static validation of the infrastructure files, the demo seed through the HTTP API, the screenshot runner
against the running web apps.

**Could not run here:** anything in the Flutter app; any Docker image or Compose stack; the reverse proxy;
the CI workflows; the monitoring stack; any external provider; a browser end-to-end suite (none was written;
section 2.7).

## 2. Commands executed and results

All commands from the repository root. "Last recorded run" figures are as of 9 to 13 October 2026; "Final run" figures are from the final verification run of 13 October 2026 (`PRISMA_SCHEMA_ENGINE_BINARY=/bin/true`; `NODE_OPTIONS=--max-old-space-size=2048` for lint and type-checks, `3072` for the Next.js builds; raw logs under `/tmp/final-verify/`).

### 2.1 Lint

ESLint 9 flat configuration, `eslint.config.mjs`, non-type-aware rules ([architecture/LINTING.md](architecture/LINTING.md)).
Every workspace `lint` script is `eslint . --max-warnings=<budget>`.

| Package | Command | Budget | Last recorded result | Final run |
| --- | --- | --- | --- | --- |
| root scripts | `pnpm lint:root` | 0 | 0 errors, 0 warnings | 0 errors, 0 warnings, exit 0 (`pnpm lint:root`) |
| `packages/types`, `validation`, `permissions`, `api-client`, `ui`, `branding`, `config` | `pnpm --filter @typease/<name> lint` | 0 | 0 errors, 0 warnings each | 0 errors, 0 warnings each, exit 0 for all seven (`pnpm --filter @typease/<name> lint`, one at a time) |
| `apps/centre-web` | `pnpm --filter @typease/centre-web lint` | 1 warning | 0 errors, 1 warning (`react-hooks/exhaustive-deps`, `components/fin/line-editor.tsx`) | 0 errors, 1 warning (the same `react-hooks/exhaustive-deps` at `components/fin/line-editor.tsx:65`), exit 0 - exactly at budget |
| `apps/customer-web`, `corporate-portal`, `platform-admin` | `pnpm --filter @typease/<name> lint` | 0 | 0 errors, 0 warnings each | 0 errors, 0 warnings each, exit 0 |
| `database` | `pnpm --filter @typease/database lint` | 8 warnings | 0 errors, 8 warnings (`no-explicit-any` in `scripts/prisma-to-sql.ts`) | 0 errors, 8 warnings (all `no-explicit-any`), exit 0 - exactly at budget |
| `services/worker` | `pnpm --filter @typease/worker lint` | 0 | 0 errors, 0 warnings | 0 errors, 0 warnings, exit 0 |
| `services/api` | `pnpm --filter @typease/api lint` | 366 warnings | **42 errors, 367 warnings** at the lint engineer's read-only count of 13 October 2026 (28 `no-require-imports`, 6 `no-unused-vars`, 3 `prefer-const`, 2 `no-irregular-whitespace`, 2 `no-control-regex`, 1 `no-var`; 366 `no-explicit-any` warnings). **Being cleaned at the time of writing** | **0 errors, 366 warnings** (all `@typescript-eslint/no-explicit-any`), exit 0; the `lint` script now sets `--max-warnings=366`, so the package is exactly at budget (`pnpm --filter @typease/api lint`) |
| `tests` | `pnpm --filter @typease/tests lint` | 0 | 2 errors (`no-require-imports` in `tests/support/jobs.ts`), 0 warnings | 0 errors, 0 warnings, exit 0 |

Not installed and therefore not applied: `@next/eslint-plugin-next`, `eslint-plugin-react`,
`eslint-plugin-jsx-a11y`, `eslint-plugin-import`. The Flutter app is outside ESLint and `dart analyze` has
never run.

### 2.2 Type-check

`pnpm typecheck` runs `tsc --noEmit` in every workspace package one after the other (needs
`pnpm build:packages` first because the API imports the packages' build output).

| Package | Last recorded result | Final run |
| --- | --- | --- |
| every workspace package (`packages/*`, `database`, `services/api`, `services/worker`, four web apps) | 0 errors; the production builds of section 2.9 would not have completed otherwise | 0 errors in every package, exit 0 for all 15 targets, run one package at a time with `pnpm --filter <pkg> typecheck` after `pnpm build:packages` (API 50 s, `ui` 16 s, the rest 1-9 s). `packages/config` is plain JavaScript and its `typecheck` script is a deliberate no-op (`node -e ""`) |
| `tests` (acceptance suite) | 0 errors, 12 s (`pnpm --filter @typease/tests typecheck`, 9 October 2026) | 0 errors, 18 s, exit 0 |

### 2.3 Package unit tests

`pnpm test:unit` (Vitest; `node --test` for `packages/config`). No database, no network.

| Package | Test files | Tests, last recorded run | Final run |
| --- | --- | --- | --- |
| `packages/ui` | 7 | 134 passed | 7 files, 134 passed, 0 failed, 27.3 s (`pnpm --filter @typease/ui test`) |
| `packages/api-client` | 5 | 57 passed | 5 files, 57 passed, 0 failed |
| `packages/branding` | 3 | 38 passed | 3 files, 38 passed, 0 failed |
| `packages/permissions` | 1 | 6 passed | 1 file, 6 passed, 0 failed |
| `packages/types` | 1 | 5 passed | 1 file, 5 passed, 0 failed |
| `packages/config` | 1 (`security.test.mjs`) | 4 passed | 4 passed, 0 failed (`node --test`) |
| `packages/validation` | 0 | **no tests** (`vitest run --passWithNoTests`); the schemas are exercised by the API module tests | - |

### 2.4 API test suite

`pnpm test:api` (Jest, `--runInBand`, one file at a time): the API unit tests (`*.unit.spec.ts`, 40
files, no database) and the module tests (`services/api/src/modules/*/*.spec.ts`, `services/api/test/*.spec.ts`,
real application, real PostgreSQL with row-level security, real Redis, jobs inline).

| Measure | Last recorded run | Final run |
| --- | --- | --- |
| Suites | 94 passed, 0 failed | 99 passed, 0 failed, 99 total (`pnpm test:api`, "Test Suites" line; recorded run of 13 October 2026, log `/tmp/api-tests.log`) |
| Tests | 1,447 passed, 0 failed, 0 skipped | 1,485 passed, 0 failed, 0 skipped, 1,485 total ("Tests" line) |
| Duration | not recorded | 1,060.8 s ("Time" line). The pure unit subset was re-run separately in the final verification: `pnpm --filter @typease/api test:unit` - 40 suites, 527 tests passed, 14.1 s |

The final run covers all 99 spec files under `services/api` (`find services/api -name "*.spec.ts" -not -path
"*/node_modules/*" | wc -l`), five more than the last recorded run, because a backend hardening pass was
finalised between the two. The final figures are the ones that describe this build.

Fixed test configuration that shapes these results (`services/api/test/env.ts`; detail in
[TESTING.md](TESTING.md) section 4): `QUEUE_DRIVER=inline`, `STORAGE_DRIVER=local`, `RATE_LIMIT_ENABLED=false`,
`MFA_ENFORCEMENT=optional`, `ONBOARDING_REQUIRE_PHONE_VERIFICATION=false`, `PAYMENT_SANDBOX_ENABLED=true`,
`OCR_PROVIDER=disabled` (the OCR module's own specs use a deterministic fake engine and the offline Tesseract
on one synthetic image), `MALWARE_SCANNER=none` (a local fake `clamd` is started by the malware specs).

### 2.5 Acceptance suite: integration

`pnpm test:integration` - `tests/integration`, 9 files, scenarios 1-23 and 26-30 of specification
section 34, driven over HTTP against the real application.

| Measure | Last recorded run (9 October 2026) | Final run |
| --- | --- | --- |
| Suites | 9 passed, 0 failed | 9 passed, 0 failed (`pnpm test:integration`, 13 October 2026, [verification/acceptance-run.md](verification/acceptance-run.md)) |
| Tests | 54 passed, 0 failed | 54 passed, 0 failed |
| Duration | 91 s | 122.3 s (jest), 133 s wall clock, run alongside the production builds |

### 2.6 Acceptance suite: security

`pnpm test:security` - `tests/security`, 6 files, scenarios 24 and 25 and the authentication, session,
support-access and row-level-security boundaries around them.

| Measure | Last recorded run (9 October 2026) | Final run |
| --- | --- | --- |
| Suites | 6 passed, 0 failed | 6 passed, 0 failed (`pnpm test:security`, 13 October 2026, [verification/acceptance-run.md](verification/acceptance-run.md)) |
| Tests | 32 passed, 0 failed | 32 passed, 0 failed |
| Duration | 213 s | 236.8 s (jest), 241 s wall clock |

Expected noise in the output: a few `ERROR [Http] ... The AI document assistant is not configured` lines,
because the route walks call the extraction route with OCR switched off and `503 INTEGRATION_NOT_CONFIGURED`
is the documented answer.

**The 30 required scenarios** (specification section 34). "Pass" means the named test asserts the scenario
and passed in the last recorded run; "partial" means it passed but a part of the scenario is outside what an
API-level test can show, as stated. The full statement of what each test asserts and does not is in
[../tests/README.md](../tests/README.md), "Traceability".

| # | Scenario | File | Result | What is not shown at this level |
| --- | --- | --- | --- | --- |
| 1 | Platform admin creates a tenant | `integration/01-onboarding.spec.ts` | Pass | The console screens |
| 2 | Tenant owner completes onboarding | `integration/01` | Pass | Phone verification (off in tests); the wizard screens |
| 3 | Tenant owner creates a branch | `integration/01` | Pass | - |
| 4 | Owner invites a staff member | `integration/01` | Pass | Delivery of the email by a real provider |
| 5 | Staff member logs in | `integration/01` | Pass | MFA enrolment (API foundation spec); OTP sign-in (no SMS provider) |
| 6 | Staff creates a customer | `integration/02-request-journey.spec.ts` | Pass | Merging duplicates; Arabic names |
| 7 | Customer submits a service request | `integration/02` | Pass | The mobile source; the form UI |
| 8 | Customer uploads documents | `integration/02` | Pass | A real malware scanner; the S3 driver |
| 9 | Reviewer verifies documents | `integration/02` | Pass | OCR-assisted verification |
| 10 | Quotation is generated | `integration/02` | Pass | PDF content beyond its signature bytes |
| 11 | Customer approves quotation | `integration/02` | Pass | Quotation expiry job (module spec) |
| 12 | Payment is recorded | `integration/02` | Pass | A real gateway |
| 13 | Request is assigned | `integration/02` | Pass | Auto-assignment (module spec and automation spec) |
| 14 | Operator processes request | `integration/02` | Pass | Official API submission: **none exists**, by policy |
| 15 | Request is completed | `integration/02` | Pass | Reopening |
| 16 | Customer receives notification | `integration/02` | **Partial**: in-app message and email captured by the development mail driver; **no real delivery** (SMTP against a local server in `integration/04`; no SMS / WhatsApp / push provider) | Delivery by an external provider; rendering in a mail client |
| 17 | Customer downloads completed document | `integration/02` | Pass | S3 pre-signed URLs; the browser's handling |
| 18 | Corporate customer submits an employee request | `integration/03-corporate.spec.ts` | Pass | A real partner system (the partner is a record, by policy); the corporate portal UI |
| 19 | Reminder job runs | `integration/04-reminders-and-jobs.spec.ts` | Pass | Cron timing and BullMQ repeatable jobs (jobs run inline) |
| 20 | Invoice is generated | `integration/02` | Pass | An invoice becoming overdue (module spec); PDF layout |
| 21 | Subscription is upgraded | `integration/05-subscription-and-white-label.spec.ts` | **Partial**: paid through the sandbox gateway; **no real payment provider**; dunning emails not covered | - |
| 22 | White-label theme is changed | `integration/05` | **Partial**: API, public config, logo and email preview; **how the web and mobile apps render the theme** is not tested automatically (section 2.7 for the manual check) | Favicon; email as rendered by a client |
| 23 | Custom-domain configuration is validated | `integration/05` | **Partial**: the DNS lookup is replaced by a table (`FakeDns`); **no real DNS, no certificate, no reverse proxy** | - |
| 24 | Tenant A cannot access Tenant B data | `security/01-tenant-isolation.spec.ts`, `02-customer-and-corporate-boundaries.spec.ts`, `05-platform-support-access.spec.ts`, `06-row-level-security.spec.ts` | Pass (221 record attacks, 267 id-taking routes, 78 cross-references, header and token spoofing, portal and corporate boundaries, support-access scopes, raw SQL as `typease_app` over more than 90 tables) | Isolation of files in object storage across centres, of Redis cache keys, and dedicated-database deployments |
| 25 | Unauthorised role cannot approve refunds | `security/03-roles-and-refund-approval.spec.ts` | Pass (plus segregation of duties and the whole permission matrix: eight roles x 548 non-public routes) | Refunds through a real gateway; custom roles beyond the three used |
| 26 | Duplicate payment webhook does not duplicate payment | `integration/06-payments-idempotency.spec.ts` | Pass (sequential and six concurrent deliveries; forged, altered and misdirected webhooks; declined then successful attempts; abandoned checkouts; `Idempotency-Key` races) | A real gateway's webhook format (Stripe signatures verified against locally computed values only) |
| 27 | Failed notification is retried safely | `integration/04` | **Partial**: a real SMTP server on localhost answers 451 once; **SMS / WhatsApp / push retry has no provider**; back-off timing not observed (inline queue) | - |
| 28 | Expired document download URL is rejected | `integration/07-documents-links.spec.ts` | Pass (download, preview, upload and share links; forged links; quarantined and deleted documents) | Expiry of S3 pre-signed URLs (enforced by the provider) |
| 29 | Deleted or archived customer data is handled according to policy | `integration/08-privacy-and-retention.spec.ts` | Pass (archive and restore, erasure with the books kept, retention purge with legal hold, export to the person only) | Whether the policy satisfies UAE law (legal review); erasure of files in S3 and of backups |
| 30 | Reports match underlying financial records | `integration/09-reports-reconciliation.spec.ts` | Pass (eight financial reports, drill-downs, branch report, dashboard tiles, till reconciliation and CSV totals against the test's own set of books) | Periods longer than two days; XLSX / PDF export content; operational reports |

### 2.7 Browser verification (not automated)

**No browser end-to-end test suite exists.** `tests/e2e/playwright.config.ts` does not exist and no spec
was written; `pnpm test:e2e` prints [../tests/e2e/README.md](../tests/e2e/README.md) (what the screenshot
scenarios cover and how to turn them into Playwright tests) and exits 1 by design, so that it cannot be
mistaken for a passing suite. This is a gap against specification section 39, which asks for
end-to-end-test commands to be executed.

What was done instead: engineers drove every screen of the four web applications through a scripted
headless Chromium and looked at the results. The runner is `packages/ui/scripts/screenshots.mjs` (it uses
the Chromium of the Playwright library installed for the `tests` workspace, against a running dev server and
the demo data); the scenario files are `apps/centre-web/scripts/shots-{foundation,cases,people,fin,ops,adm}.mjs`,
`apps/customer-web/scripts/shots.mjs`, `apps/corporate-portal/scripts/shots.mjs` and
`apps/platform-admin/scripts/shots.mjs`. Each scenario opens a page, acts on it (fills a form, opens a
dialog, triggers a validation message), asserts what it is about with `check(...)` calls that throw, and
takes a picture; the runner reports console errors for every picture. This is manual verification with
scripted help and pictures: it is not an automated suite, it has no pass / fail record in CI, and nobody
re-runs it on a change.

| Measure | Value |
| --- | --- |
| Scenario entries in the scenario files | about 396 (`grep -cE "^\s{2,4}(\{ )?name: '" apps/*/scripts/shots*.mjs`): staff app 248 across six files, corporate portal 59, customer portal 41, platform console 48 |
| Variants used | `en-light-desktop` (English, light theme, desktop width), `ar-dark-desktop` (Arabic, right-to-left, dark theme, desktop), `en-light-mobile` (English, light, phone width); a few customer-portal scenarios also in `ar-light-mobile` and `ar-dark-mobile` |
| Pictures kept | 197 in `docs/brand/screenshots/` (`ls docs/brand/screenshots \| wc -l`): 117 staff app, 33 customer portal, 25 platform console, 22 corporate portal; by variant 106 English desktop, 38 Arabic dark desktop, 43 English phone, 5 Arabic phone, 5 flow pictures without a variant suffix |
| Last run | Pictures were last added in commit `2400cad` (9 October 2026); the runner and scenario scripts have uncommitted changes after it. The corporate portal, completed last, has had the least checking |

Not covered by this verification: the Flutter app (section 2.8), rendering in real mobile browsers,
accessibility beyond computed colour contrast, and any regression after the last run.

### 2.8 Flutter tests (not executed)

| Item | Value |
| --- | --- |
| Command | `cd apps/customer-mobile && tool/bootstrap.sh` (then `flutter analyze`, `flutter test`) |
| Source | about 19,400 lines of Dart under `lib/` |
| Tests written | about 3,200 lines under `test/` (unit, widget) and `integration_test/`; each file states in its first line that it has never run |
| Result | **Not executed. No Flutter SDK in the build environment.** The app has never been compiled; `dart analyze` has never run; no device or emulator has ever loaded it |
| Where the first compile will most likely fail | Listed in [../apps/customer-mobile/README.md](../apps/customer-mobile/README.md), "First compile: where to look first" |

### 2.9 Production builds

`pnpm build` = `pnpm build:packages` (Prisma client, shared packages), `pnpm build:api` (API and worker,
`tsc`), `pnpm build:web` (the four Next.js apps, standalone output, one at a time).

| Target | Last recorded result | Final run |
| --- | --- | --- |
| `packages/*`, `database` (Prisma client generation and `tsc`) | Built | Built, exit 0, 60 s (`pnpm build:packages`; Prisma Client 7.10.0 generated, every `tsc` step "Done") |
| `services/api`, `services/worker` | Built | Built, exit 0, 33 s (`pnpm build:api`; `services/api/dist/main.js` and `services/worker/dist/main.js` produced, no diagnostics) |
| `apps/centre-web` | Built (Next.js standalone output) | Built: "Compiled successfully in 49s", 61/61 static pages generated, 80 routes, middleware 34.3 kB, Next.js 15.5.4 (run as part of `pnpm build:web`, exit 0, 342 s for the four apps together) |
| `apps/customer-web` | Built | Built: "Compiled successfully in 24.0s", 29/29 static pages, 33 routes, middleware 34.6 kB |
| `apps/corporate-portal` | Built | Built: "Compiled successfully in 26.9s", 24/24 static pages, 28 routes, middleware 34.5 kB |
| `apps/platform-admin` | Built | Built: "Compiled successfully in 21.1s", 22/22 static pages, 23 routes, middleware 34.1 kB |
| Docker images | **Not built** (no daemon) | - |
| Flutter release build | **Not built** (no SDK) | - |

"Built" means the command finished without error and produced the output the Dockerfiles and
`scripts/start-web-standalone.sh` expect. Running the built artefacts as a production system (containers,
proxy) was not done; see section 2.10.

### 2.10 Infrastructure validation (static)

`pnpm check:infra` = `scripts/validate-infra.sh`: `docker compose config` on both stacks, `bash -n` / `sh -n`
on every shell script, YAML and JSON parsing of the monitoring configuration, checks of the environment
templates against `env.ts`. **Nothing was built or started.**

| Measure | Last recorded result | Final run |
| --- | --- | --- |
| Checks | 25 PASS, 0 FAIL, 5 SKIP (the SKIPs are the tools that were not installed: `shellcheck`, `hadolint`, `actionlint`, `promtool`, `caddy validate`) | 29 PASS, 0 FAIL, 5 SKIP, exit 0 (`bash scripts/validate-infra.sh`; the same five tools skipped). Also run: `node scripts/production-readiness.mjs --env-file .env.example --skip-db --skip-redis --skip-network` - 8 PASS, 7 WARN, 21 FAIL, 2 SKIP, exit 1, "NOT READY FOR PRODUCTION": every FAIL is a placeholder or development value in `.env.example`, which is the gate doing its job |

Also exercised, as recorded in the table at the top of [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md):
`scripts/production-readiness.mjs` against the development PostgreSQL and Redis (its example of a failing run
is real output), `scripts/smoke-test.sh` against a running API in direct mode, a `db-backup.sh` to
`db-restore.sh` drill against the development database with tamper and guard tests, `.env.example` loaded
through the API's own `loadEnv()` covering all 86 variables of `env.ts`, and `scripts/deploy.sh` with
`--dry-run` only.

### 2.11 Demo seed and verification

| Item | Value |
| --- | --- |
| Command | `pnpm db:seed --env-file=.env` (development only; empty database; API and worker stopped) |
| How it works | Drives the real HTTP API as the platform administrator, the owners, staff, customers and companies would; no direct database writes except the first platform administrator |
| Last recorded run | About 3,460 API calls; 144 s and 154 s for two consecutive runs; three fictional centres (`al-noor`, `gulf-star`, `desert-rose`) with staff, customers, companies and requests in every status; the seed performs its own isolation checks at the end ([DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md)) |
| Verification | `node scripts/seed-verify.mjs --env-file=.env` (read-only session): 59 checks passed at the last recorded run - expected centres, people and case states exist, no row points across centres, nothing resembles real personal data |
| Final run | The development database was reset and re-seeded on 13 October 2026 (`pnpm db:reset`; seed 213 s). The first attempt stopped in the appointments step with `no free appointment slot at Musaffah Office on 2026-10-16`: the fixtures are relative to the day the seed runs and that "upcoming" appointment fell on a day the branch is closed. The seed's slot search was changed to move on to the next open day within a week (`services/api/src/cli/seed/phase-operations.ts`, `slotFor`); the re-run completed and `node scripts/seed-verify.mjs --env-file=.env.dev-local` reported **59 of 59 checks passed**. An earlier run of the verifier against the used (not re-seeded) development database had reported 51 of 59, because screenshot and documentation sessions had added centres, users and files after seeding; that result is superseded. Detail in [verification/final-run.md](verification/final-run.md) section 8 |

## 3. What the tests prove and what they do not

Each row names the spec files (paths relative to the repository root) whose passing is the evidence.

| Property | Evidence | Proven | Not proven |
| --- | --- | --- | --- |
| **Tenant isolation over HTTP** | `tests/security/01-tenant-isolation.spec.ts`, `tests/security/02-customer-and-corporate-boundaries.spec.ts`; per resource in every module spec (`services/api/src/modules/*/*.spec.ts`); `services/api/test/foundation.spec.ts`, `services/api/test/architecture.spec.ts` | Every route of the running application that names a record refuses another centre's ids (404, nothing of the other centre in the answer); lists, searches, filters, reports and exports never contain the other centre's rows; ids of another centre in create and update bodies are refused and no row points across centres; headers, query parameters, body fields, tokens and slugs supplied by a client never switch the tenant; the other centre's rows are byte-identical before and after (fingerprint); portal users and corporate users are confined to their own records | Isolation of files in an S3 bucket (local driver only), of Redis keys, and under a connection pooler; a dedicated-database mode (not implemented) |
| **Row-level security in PostgreSQL** | `tests/security/06-row-level-security.spec.ts`; `services/api/test/foundation.spec.ts`; `services/api/test/architecture.spec.ts` (system-connection allow-list) | The application role is not a superuser, does not bypass RLS and owns nothing; 19 escape attempts are refused by PostgreSQL; every table the role can touch has a tenant policy; without a bound tenant the role sees no tenant row and cannot write in any of the more than 90 tenant-owned tables; with tenant A bound it reaches only A; cross-tenant foreign keys are refused by the trigger; a centre cannot activate itself, change its plan, rewrite its audit trail or alter issued financial records | Protection against somebody who can run arbitrary SQL as `typease_app` and binds another tenant (the application's job, tested over HTTP); `FORCE ROW LEVEL SECURITY` against the owner role (not set; the owner is used for migrations only) |
| **Immutability of financial records and trails** | `services/api/src/modules/finance/finance.documents.spec.ts`, `services/api/src/modules/audit/audit.spec.ts`; `tests/integration/02-request-journey.spec.ts` (S20), `tests/integration/09-reports-reconciliation.spec.ts`; `database/migrations/0003_integrity.sql` is what they exercise | An issued invoice cannot be edited or deleted (API and database trigger); gap-free numbering; corrections are credit notes; `audit_logs`, `security_events`, `document_access_logs`, `request_status_history`, `consent_records`, `payment_allocations`, `liability_entries` refuse `UPDATE` and `DELETE`; the two controlled exceptions (offboarding purge, erasure redaction) work only on the system connection behind a transaction-local switch (`services/api/src/modules/platform/platform.offboarding.spec.ts`, `services/api/src/modules/privacy/privacy.spec.ts`) | Tamper evidence against a database administrator (no hash chaining, no external write-once copy) |
| **Payments exactly once** | `tests/integration/06-payments-idempotency.spec.ts`; `services/api/src/modules/finance/finance.payments.spec.ts`, `finance.refunds.spec.ts`, `finance/gateways/gateways.unit.spec.ts` | A verified webhook event is stored once and a duplicate changes nothing, also for six simultaneous deliveries; forged, altered, stale and misdirected webhooks pay nothing and write security events; a declined attempt cannot be revived; abandoned checkouts expire and a late success still books once; `Idempotency-Key` makes manual payments and refund requests replay-safe, also under concurrency and across centres; amount or currency mismatch completes nothing | Any real gateway: Stripe signature verification is tested with locally computed signatures and the Stripe adapter has never talked to Stripe |
| **Erasure and retention** | `tests/integration/08-privacy-and-retention.spec.ts`; `services/api/src/modules/privacy/privacy.spec.ts`; `services/api/src/modules/documents/documents-lifecycle.spec.ts` | Erasure is blocked while a request or invoice is open; afterwards the person's values are gone from the record, the cases, the documents, the messages and the trails, while invoice, payment, receipt and report figures are identical before and after; sessions and password are dead; the address can register again; completing twice changes nothing; retention deletes exactly the documents whose period ended and spares legal holds; the export reaches only the person | Backups, logs outside the database, delivered messages, external providers' copies, free text about the person in other records; whether the scope satisfies UAE law (legal review) |
| **Support-access scopes** | `tests/security/05-platform-support-access.spec.ts`; `services/api/src/modules/platform/platform.access.spec.ts`, `platform.access-notifications.spec.ts` | Platform staff get `403 TENANT_REQUIRED` on all 451 tenant routes without a grant; a requested grant opens nothing; only the centre approves, and may approve less; with a grant exactly ten read routes open, every change is refused, the other centre stays 404, the console is closed to the session; every call is on the centre's audit trail and the document's access log; revocation and expiry end access on the next request; the one-time hand-off code cannot be guessed, reused or replaced | The console action that would start the session (it does not exist; [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) section 5.7) |
| **Permission matrix and authentication** | `tests/security/03-roles-and-refund-approval.spec.ts`, `tests/security/04-authentication-and-sessions.spec.ts`; `services/api/test/foundation.spec.ts`, `services/api/test/architecture.spec.ts` | Eight roles x 548 non-public routes behave as the matrix declares; the provisioned roles carry exactly the matrix's permissions; every non-public route refuses 401 without a token, with garbage, with expired and foreign-key tokens and eleven more variants; refresh-token reuse kills the session family; lock-out after five failures; session limits; password policy; one-time links | Rate limits (off in tests), MFA enforcement for privileged roles (optional in tests), TLS, HSTS, the proxy, cookie behaviour in real browsers |
| **Background jobs** | `tests/integration/04-reminders-and-jobs.spec.ts`; `services/api/src/modules/platform/worker.bullmq.spec.ts`, `services/api/src/modules/notifications/bullmq.spec.ts` | Every scheduled job is registered, runs, and can run twice without error; reminders are sent once per offset and respect consent; the outbox delivers at least once and subscribers are idempotent; a real BullMQ worker's heartbeat is seen by the API in its own spec | Cron timing, repeatable jobs and retry back-off in the separate worker process over time (everything else runs inline) |

## 4. Known failing, skipped and flaky tests

- **No test is known to fail** in any suite at the last recorded run, and no test is skipped. No test in the
  acceptance suite carries a `// PRODUCT DEFECT:` marker.
- **Two time-of-day sensitivities** in the acceptance suite, described in [../tests/README.md](../tests/README.md),
  "Known sensitivities": several files compute "today" on the centre's calendar when they start, so a run that
  crosses midnight in Dubai (20:00 UTC) inside `integration/04`, `integration/09` or `security/01` can fail
  and must simply be run again; and `integration/07` waits about seven seconds for links to expire with a
  two-second window for the in-time fetch, so a machine that stalls for longer makes that test fail.
- `tests/README.md` "Observations" item 1 (two sub-list routes answering `200` with an empty page for a
  foreign parent id) is no longer true: `EMPTY_SUBLIST_ROUTES` in `tests/support/attacks.ts` is empty and
  [api/modules/ocr.md](api/modules/ocr.md) documents `404`. The paragraph is stale, not a failing test.
- Final verification run (13 October 2026): no failing, skipped or re-run test in the package unit tests
  (244 tests) or in `pnpm --filter @typease/api test:unit` (527 tests); the recorded `pnpm test:api` run
  (99 suites, 1,485 tests) has no failure or skip. `pnpm test:integration` (54 tests) and `pnpm test:security` (32 tests)
  passed in full (sections 2.5 and 2.6). The one check that failed on the first attempt (`scripts/seed-verify.mjs`
  against the used development database, 8 of 59; section 2.11) passed 59 of 59 after a reset and
  re-seed - it was a data-state finding, not a
  test.

## 5. Answers to section 39 of the specification

Section 39 of [brand/MASTER_PROMPT.md](brand/MASTER_PROMPT.md) asks for eight statements. They are given
here without qualification.

### What was implemented

- A NestJS REST API (`services/api`, 26 modules) with a PostgreSQL 16 schema of 107 tables under row-level
  security applied by hand-written SQL migrations (`database/`), a background worker (`services/worker`,
  BullMQ, schedulers, transactional outbox), and shared packages for types, validation, permissions, the
  API client, UI components, branding and configuration.
- Four Next.js applications: the staff application (`apps/centre-web`), the customer portal
  (`apps/customer-web`), the corporate portal (`apps/corporate-portal`) and the platform console
  (`apps/platform-admin`), in English and Arabic.
- A Flutter customer application as source code (`apps/customer-mobile`), never compiled.
- The business modules of specification sections 7 to 27 and 32: authentication with TOTP MFA, tenants and
  onboarding, subscriptions and plans, customers, catalogue, requests with the state machine and workflow
  builder, documents with signed links and quarantine, the OCR assistant, quotations, invoices, payments,
  refunds and credit notes, corporate accounts, appointments and queue, staff and roles, notifications on
  five channels, expiry reminders, white label with custom domains, reports and exports, support tickets,
  audit, privacy tooling, platform administration with scoped support access, and the automation engine.
- The government-services compliance model of section 31 (channels, authorisation records, labelled
  statuses); **no government integration**.
- Adapters for Stripe, SMTP, Twilio / HTTP SMS, Meta WhatsApp, FCM, S3, ClamAV, Tesseract / external OCR
  and n8n, each reporting `NOT_CONFIGURED` without credentials.
- Docker images, two Compose stacks, Caddy configuration, monitoring configuration, three CI/CD workflows,
  deployment, backup, restore, readiness and smoke scripts - written, statically validated, never executed.
- The documentation set of section 38 and a demo environment of three fictional centres.

### What was tested

- Package unit tests (section 2.3); the API unit and module tests against real PostgreSQL and Redis
  (section 2.4); the acceptance suite covering all 30 scenarios of section 34 over HTTP (sections 2.5 and
  2.6); lint and type-check (2.1, 2.2); production builds of packages, API, worker and web apps (2.9); static
  validation of the infrastructure files (2.10); the demo seed through the API and its verification (2.11).
- The web applications were verified by hand through a scripted headless Chromium with pictures (2.7). This
  is not an automated end-to-end suite.
- Not tested at all: the Flutter app, the containers, the proxy, CI, monitoring, any real external
  provider, load and performance, accessibility by tooling.

### Which tests passed

At the last recorded run: all package unit tests (244 across six packages), all 1,447 tests of the 94 API
suites, all 54 tests of the 9 integration files and all 32 tests of the 6 security files. Lint was clean in
every package except `services/api` and `tests`. Final figures (13 October 2026): all 244 package unit tests
(six packages), all 1,485 tests of the 99 API suites (recorded run), all 527 tests of the 40 API pure unit
suites (re-run); lint 0 errors in every package (375 warnings in total, every package at or under its budget);
0 type errors in every package; every production build completed. The integration (9 files / 54 tests) and
security (6 files / 32 tests) acceptance suites passed in full in the final verification (sections 2.5
and 2.6).

### Which tests failed

None known at the last recorded run (section 4). Lint findings open at that time: 42 errors and 367 warnings
in `services/api`, 2 errors in `tests` (section 2.1). Final state: no test failed; lint has 0 errors everywhere
and 366 / 8 / 1 warnings in `services/api` / `database` / `apps/centre-web`, each within its `--max-warnings`
budget; `scripts/seed-verify.mjs` reported 59 of 59 checks passed after a reset and re-seed (section 2.11;
the seed itself needed one fix for an appointment falling on a closed day).

### Which external services require credentials

Stripe (or another gateway through a new adapter), an SMTP relay, Twilio or an HTTP SMS gateway, the Meta
WhatsApp Cloud API, Firebase Cloud Messaging, an S3-compatible object store, ClamAV, an external OCR vendor
(if Tesseract is not used), n8n. None has been verified against the real service; each is in
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) section 3 with its variables and its behaviour when absent.

### Which government integrations require authorisation

All of them. No integration with any authority (ICP, MOHRE, GDRFA, Tasheel- or Amer-type channels, or any
other) exists; the `OFFICIAL_API` channel always answers `OFFICIAL_INTEGRATION_NOT_AVAILABLE`. Any such
integration needs the authority's documented API access, its authorisation of the centre and the operator,
provider-issued credentials and an adapter written against the authority's sandbox. Nothing in the code
bypasses CAPTCHAs, intercepts OTPs, scrapes portals or stores credentials, and nothing in the documentation
suggests doing so ([KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) section 4).

### Which features remain blocked

- Blocked until credentials exist: online payments, email delivery by a relay, SMS (and with it OTP sign-in
  and phone verification), WhatsApp, push, S3 storage, malware scanning by ClamAV, external OCR, n8n
  webhooks.
- Blocked until an authority authorises it: any official submission channel.
- Blocked until a Flutter SDK is available: everything in the mobile application.
- Blocked until a Docker daemon and a host exist: images, Compose stacks, proxy, TLS, monitoring, CI.
- Not built: Arabic PDFs and Arabic API messages, e-invoicing and VAT returns, hand-over and courier
  tracking, bulk workflow migration, price scheduling, SSO, CAPTCHA, API keys for third parties, a console
  action to open a support session, working encryption-key rotation, automatic retention for anything but
  documents, alerting - the full list is [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) section 5.

### Whether the project is ready for production deployment

**No.** Section 39 forbids stating readiness while critical tests, security reviews, integrations or
deployment checks remain incomplete, and all four remain incomplete: no browser or mobile test has run, no
independent security review or penetration test has been performed, no external provider has been verified,
and no deployment artefact has ever been built or started. The reasons and the work that would come first
are in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) sections 8 and 9.
