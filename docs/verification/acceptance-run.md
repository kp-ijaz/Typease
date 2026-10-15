# TypEase acceptance suites - final verification run

- Repository: `/home/claude/typease`, last commit `04c2f34` ("Documentation reconciliation with the final code"); no code change was made for this run
- Date: 2026-10-13, 14:03-14:10 UTC (18:03-18:10 Asia/Dubai)
- Toolchain: Node v22.22.0, pnpm 10.28.0
- Services: PostgreSQL 16 on 127.0.0.1:5432, Redis on 127.0.0.1:6379 (already running)
- Environment, exported for every command:

  ```bash
  export PRISMA_SCHEMA_ENGINE_BINARY=/bin/true
  export NODE_OPTIONS=--max-old-space-size=1536
  export TEST_PG_DATABASE=typease_test_b2          # dropped and rebuilt from the migrations by services/api/test/global-setup.ts
  export TEST_REDIS_URL=redis://127.0.0.1:6379/2
  export TEST_STORAGE_DIR=/tmp/typease-test-b2
  ```

  (`services/api/test/env.ts` reads these three `TEST_*` variables; the `typease_dev` database was not used.)
- Every command was run one at a time, in the foreground, from the repository root. Raw logs:
  `/tmp/final-verify/acceptance-integration.log`, `/tmp/final-verify/acceptance-security.log`,
  `/tmp/final-verify/acceptance-typecheck.log` (each starts with a UTC timestamp and ends with `exit=<code> duration=<s>`).
- Machine load: a second engineer was running lint / type-checks / Next.js builds (up to 4 GB) on the same host during
  this run (their report: `docs/verification/final-run.md`), which is why wall-clock times are a little above the
  estimates in `tests/README.md` (about 1.5 min and 3.5 min).

## Summary

| # | Command | Exit code | Suites | Tests | Jest time | Wall clock | Re-run needed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `pnpm test:integration` | 0 | 9 passed / 9 total | 54 passed / 54 total | 122.3 s | 133 s | no (nothing failed) |
| 2 | `pnpm test:security` | 0 | 6 passed / 6 total | 32 passed / 32 total | 236.8 s | 241 s | no (nothing failed) |
| 3 | `pnpm --filter @typease/tests typecheck` | 0 | - | - | - | 19 s | no |

All counts equal what `tests/README.md` announces (9 files / 54 tests, 6 files / 32 tests). No test was skipped,
no test was modified, nothing was re-run: every file passed on the first attempt, so no flakiness assessment was
required (the sensitivities listed in `tests/README.md`, "Known sensitivities" - midnight in Dubai, real waiting in
`integration/07` - did not come into play; the run was well clear of 20:00 UTC).

## 1. `pnpm test:integration` (scenarios 1-23, 26-30)

Started 2026-10-13T14:03:20Z; `exit=0 duration=133s`.

```
PASS ../../tests/integration/01-onboarding.spec.ts (16.889 s)
PASS ../../tests/integration/02-request-journey.spec.ts (14.631 s)
PASS ../../tests/integration/03-corporate.spec.ts (9.439 s)
PASS ../../tests/integration/04-reminders-and-jobs.spec.ts (9.784 s)
PASS ../../tests/integration/05-subscription-and-white-label.spec.ts (11.689 s)
PASS ../../tests/integration/06-payments-idempotency.spec.ts (8.988 s)
PASS ../../tests/integration/07-documents-links.spec.ts (13.91 s)
PASS ../../tests/integration/08-privacy-and-retention.spec.ts (24.029 s)
PASS ../../tests/integration/09-reports-reconciliation.spec.ts (12.745 s)
Test Suites: 9 passed, 9 total
Tests:       54 passed, 54 total
Snapshots:   0 total
Time:        122.312 s
```

The log contains no warning or error line.

## 2. `pnpm test:security` (scenarios 24, 25 and the boundaries around them)

Started 2026-10-13T14:05:39Z; `exit=0 duration=241s`.

```
PASS ../../tests/security/01-tenant-isolation.spec.ts (53.516 s)
PASS ../../tests/security/02-customer-and-corporate-boundaries.spec.ts (31.376 s)
PASS ../../tests/security/03-roles-and-refund-approval.spec.ts (76.459 s)
PASS ../../tests/security/04-authentication-and-sessions.spec.ts (12.229 s)
PASS ../../tests/security/05-platform-support-access.spec.ts (38.201 s)
PASS ../../tests/security/06-row-level-security.spec.ts (24.877 s)
Test Suites: 6 passed, 6 total
Tests:       32 passed, 32 total
Snapshots:   0 total
Time:        236.77 s
```

The only other output is four `ERROR [Http] ... AppError: The AI document assistant is not configured ...` stack
traces logged by the API. This is the noise `tests/README.md` ("Running") announces: OCR is disabled in the test
environment (`OCR_PROVIDER=disabled`), the route walks of the security files call the extraction route, and the
API's documented answer `503 INTEGRATION_NOT_CONFIGURED` is what the tests expect. It is not a failure.

## 3. `pnpm --filter @typease/tests typecheck`

Started 2026-10-13T14:09:47Z; `exit=0 duration=19s`. `tsc --noEmit -p tsconfig.json` over `tests/` produced no
diagnostics.

## What this run does and does not show

- It shows that, at commit `04c2f34`, the 30 acceptance scenarios of section 34 of the specification pass over
  HTTP against the real NestJS application, a real PostgreSQL 16 with row-level security and a real Redis, with
  background jobs executed inline (`tests/README.md`, "Traceability" lists exactly what each test asserts and what
  it does not cover).
- It does not start a browser, the Next.js apps, the Flutter app, the worker process, a reverse proxy, S3, a real
  payment gateway, a real SMS / WhatsApp / push provider, real DNS or a certificate authority; it does not measure
  performance. `pnpm test:e2e` is not a passing suite - it prints `tests/e2e/README.md` and exits 1, because the
  Playwright browser tests were not written. See `docs/KNOWN_LIMITATIONS.md`.
