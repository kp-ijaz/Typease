# TypEase final verification run

- Repository: `/home/claude/typease`, last commit `04c2f34` ("Documentation reconciliation with the final code")
- Date: 2026-10-13 (Asia/Dubai, +04)
- Toolchain: Node v22.22.0, pnpm 10.28.0
- Environment: `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` exported for every pnpm command; `NODE_OPTIONS=--max-old-space-size=2048` for lint / type-checks, `3072` for the Next.js builds
- Every command was run one at a time, in the foreground, from the repository root. Raw logs are in `/tmp/final-verify/<name>.log`.
- Note: a separate engineer was running the jest acceptance suites on the same machine during this run.

# 1. Build packages

## build-packages

- Command: `pnpm build:packages`
- Date: 2026-10-13 18:03:04 +0400
- Exit code: **0**
- Wall time: 60s
- Log: `/tmp/final-verify/build-packages.log`

Summary lines:

```
packages/config build: Done
packages/types build: Done
packages/permissions build: Done
database build: Done
packages/branding build: Done
packages/validation build: Done
packages/api-client build: Done
packages/ui build: Done
```

# 2. Lint

## lint-root

- Command: `pnpm lint:root`
- Date: 2026-10-13 18:04:10 +0400
- Exit code: **0**
- Wall time: 4s
- Log: `/tmp/final-verify/lint-root.log`

Summary lines:

```
> eslint scripts eslint.config.mjs --max-warnings=0
```

## lint-centre-web

- Command: `pnpm --filter @typease/centre-web lint`
- Date: 2026-10-13 18:04:14 +0400
- Exit code: **0**
- Wall time: 19s
- Log: `/tmp/final-verify/lint-centre-web.log`

Summary lines:

```
> eslint . --max-warnings=1
  65:9  warning  The 'items' logical expression could make the dependencies of useMemo Hook (at line 66) change on every render. Move it inside the useMemo callback. Alternatively, wrap the initialization of 'items' in its own useMemo() Hook  react-hooks/exhaustive-deps
✖ 1 problem (0 errors, 1 warning)
```

## lint-corporate-portal

- Command: `pnpm --filter @typease/corporate-portal lint`
- Date: 2026-10-13 18:04:33 +0400
- Exit code: **0**
- Wall time: 6s
- Log: `/tmp/final-verify/lint-corporate-portal.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-customer-web

- Command: `pnpm --filter @typease/customer-web lint`
- Date: 2026-10-13 18:04:39 +0400
- Exit code: **0**
- Wall time: 5s
- Log: `/tmp/final-verify/lint-customer-web.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-platform-admin

- Command: `pnpm --filter @typease/platform-admin lint`
- Date: 2026-10-13 18:04:44 +0400
- Exit code: **0**
- Wall time: 4s
- Log: `/tmp/final-verify/lint-platform-admin.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-api

- Command: `pnpm --filter @typease/api lint`
- Date: 2026-10-13 18:04:53 +0400
- Exit code: **0**
- Wall time: 23s
- Log: `/tmp/final-verify/lint-api.log`

Summary lines:

```
> eslint . --max-warnings=366
  105:23  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  20:15  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  24:15  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  63:15  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  13:20  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  19:19   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  37:113  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  72:41   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  77:77   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  190:17  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  219:51  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  223:56  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  227:80  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  277:37  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  284:33  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  328:35  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  329:19  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  354:34  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  390:14  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  517:36  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  530:37  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  555:43  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   88:36  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  141:22  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  142:23  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  180:38  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  201:20  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  248:22  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  252:18  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  255:20  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   21:19  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  127:16  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   56:11  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   59:12  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   62:11  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   65:13  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   68:14  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   73:20  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  108:60  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  117:15  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  158:30  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  188:18  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  210:17  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  268:15  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  277:22  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   23:26   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   23:74   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   23:123  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   24:24   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   57:81   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   58:78   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   80:17   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   93:71   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  101:17   warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   73:23  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   88:13  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  109:59  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  31:23  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   83:33  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
```

## lint-worker

- Command: `pnpm --filter @typease/worker lint`
- Date: 2026-10-13 18:05:16 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/lint-worker.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-api-client

- Command: `pnpm --filter @typease/api-client lint`
- Date: 2026-10-13 18:05:18 +0400
- Exit code: **0**
- Wall time: 3s
- Log: `/tmp/final-verify/lint-api-client.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-branding

- Command: `pnpm --filter @typease/branding lint`
- Date: 2026-10-13 18:05:21 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/lint-branding.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-config

- Command: `pnpm --filter @typease/config lint`
- Date: 2026-10-13 18:05:23 +0400
- Exit code: **0**
- Wall time: 1s
- Log: `/tmp/final-verify/lint-config.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-permissions

- Command: `pnpm --filter @typease/permissions lint`
- Date: 2026-10-13 18:05:25 +0400
- Exit code: **0**
- Wall time: 1s
- Log: `/tmp/final-verify/lint-permissions.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-types

- Command: `pnpm --filter @typease/types lint`
- Date: 2026-10-13 18:05:26 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/lint-types.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-ui

- Command: `pnpm --filter @typease/ui lint`
- Date: 2026-10-13 18:05:28 +0400
- Exit code: **0**
- Wall time: 6s
- Log: `/tmp/final-verify/lint-ui.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-validation

- Command: `pnpm --filter @typease/validation lint`
- Date: 2026-10-13 18:05:34 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/lint-validation.log`

Summary lines:

```
> eslint . --max-warnings=0
```

## lint-database

- Command: `pnpm --filter @typease/database lint`
- Date: 2026-10-13 18:05:36 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/lint-database.log`

Summary lines:

```
> eslint . --max-warnings=8
   18:14  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   19:14  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   70:31  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   81:52  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   83:18  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   83:45  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
   97:68  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  117:36  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
✖ 8 problems (0 errors, 8 warnings)
```

## lint-tests

- Command: `pnpm --filter @typease/tests lint`
- Date: 2026-10-13 18:05:38 +0400
- Exit code: **0**
- Wall time: 4s
- Log: `/tmp/final-verify/lint-tests.log`

Summary lines:

```
> eslint . --max-warnings=0
```

### Lint summary (per package budget vs. actual)

| Package | `lint` script budget | Errors | Warnings | Exit |
|---|---|---|---|---|
| root (`pnpm lint:root`: `eslint scripts eslint.config.mjs`) | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/centre-web | `--max-warnings=1` | 0 | 1 (`react-hooks/exhaustive-deps`, `components/fin/line-editor.tsx:65`) | 0 |
| @typease/corporate-portal | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/customer-web | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/platform-admin | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/api | `--max-warnings=366` | 0 | 366 (all `@typescript-eslint/no-explicit-any`) | 0 |
| @typease/worker | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/api-client | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/branding | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/config | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/permissions | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/types | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/ui | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/validation | `--max-warnings=0` | 0 | 0 | 0 |
| @typease/database | `--max-warnings=8` | 0 | 8 (all `@typescript-eslint/no-explicit-any`) | 0 |
| @typease/tests | `--max-warnings=0` | 0 | 0 | 0 |

Total: 0 errors, 375 warnings across 16 lint targets; every package is exactly at or under its budget (api and database are exactly at budget, centre-web is exactly at budget).

# 3. Type-check

## typecheck-api

- Command: `pnpm --filter @typease/api typecheck`
- Date: 2026-10-13 18:06:00 +0400
- Exit code: **0**
- Wall time: 50s
- Log: `/tmp/final-verify/typecheck-api.log`

Summary lines:

```
```

## typecheck-worker

- Command: `pnpm --filter @typease/worker typecheck`
- Date: 2026-10-13 18:06:50 +0400
- Exit code: **0**
- Wall time: 1s
- Log: `/tmp/final-verify/typecheck-worker.log`

Summary lines:

```
```

## typecheck-tests

- Command: `pnpm --filter @typease/tests typecheck`
- Date: 2026-10-13 18:06:51 +0400
- Exit code: **0**
- Wall time: 18s
- Log: `/tmp/final-verify/typecheck-tests.log`

Summary lines:

```
```

## typecheck-api-client

- Command: `pnpm --filter @typease/api-client typecheck`
- Date: 2026-10-13 18:07:09 +0400
- Exit code: **0**
- Wall time: 8s
- Log: `/tmp/final-verify/typecheck-api-client.log`

Summary lines:

```
```

## typecheck-branding

- Command: `pnpm --filter @typease/branding typecheck`
- Date: 2026-10-13 18:07:17 +0400
- Exit code: **0**
- Wall time: 4s
- Log: `/tmp/final-verify/typecheck-branding.log`

Summary lines:

```
```

## typecheck-config

- Command: `pnpm --filter @typease/config typecheck`
- Date: 2026-10-13 18:07:21 +0400
- Exit code: **0**
- Wall time: 1s
- Log: `/tmp/final-verify/typecheck-config.log`

Summary lines:

```
```

## typecheck-permissions

- Command: `pnpm --filter @typease/permissions typecheck`
- Date: 2026-10-13 18:07:22 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/typecheck-permissions.log`

Summary lines:

```
```

## typecheck-types

- Command: `pnpm --filter @typease/types typecheck`
- Date: 2026-10-13 18:07:24 +0400
- Exit code: **0**
- Wall time: 3s
- Log: `/tmp/final-verify/typecheck-types.log`

Summary lines:

```
```

## typecheck-ui

- Command: `pnpm --filter @typease/ui typecheck`
- Date: 2026-10-13 18:07:27 +0400
- Exit code: **0**
- Wall time: 16s
- Log: `/tmp/final-verify/typecheck-ui.log`

Summary lines:

```
```

## typecheck-validation

- Command: `pnpm --filter @typease/validation typecheck`
- Date: 2026-10-13 18:07:43 +0400
- Exit code: **0**
- Wall time: 9s
- Log: `/tmp/final-verify/typecheck-validation.log`

Summary lines:

```
```

## typecheck-database

- Command: `pnpm --filter @typease/database typecheck`
- Date: 2026-10-13 18:07:52 +0400
- Exit code: **0**
- Wall time: 6s
- Log: `/tmp/final-verify/typecheck-database.log`

Summary lines:

```
```

## typecheck-centre-web

- Command: `pnpm --filter @typease/centre-web typecheck`
- Date: 2026-10-13 18:07:58 +0400
- Exit code: **0**
- Wall time: 7s
- Log: `/tmp/final-verify/typecheck-centre-web.log`

Summary lines:

```
```

## typecheck-corporate-portal

- Command: `pnpm --filter @typease/corporate-portal typecheck`
- Date: 2026-10-13 18:08:05 +0400
- Exit code: **0**
- Wall time: 5s
- Log: `/tmp/final-verify/typecheck-corporate-portal.log`

Summary lines:

```
```

## typecheck-customer-web

- Command: `pnpm --filter @typease/customer-web typecheck`
- Date: 2026-10-13 18:08:10 +0400
- Exit code: **0**
- Wall time: 5s
- Log: `/tmp/final-verify/typecheck-customer-web.log`

Summary lines:

```
```

## typecheck-platform-admin

- Command: `pnpm --filter @typease/platform-admin typecheck`
- Date: 2026-10-13 18:08:15 +0400
- Exit code: **0**
- Wall time: 5s
- Log: `/tmp/final-verify/typecheck-platform-admin.log`

Summary lines:

```
```

### Type-check summary

All 15 `typecheck` targets exited 0 with zero `error TS` lines. Note: `@typease/config` has `typecheck: node -e ""` (the package is plain JavaScript; its script is a deliberate no-op). `@typease/worker` finished in 1s and `@typease/centre-web` in 7s because `tsc` reused the incremental `tsconfig.tsbuildinfo` left by the earlier build; both logs contain no diagnostics.

| Package | Exit | Errors | Wall |
|---|---|---|---|
| @typease/api | 0 | 0 | 50s |
| @typease/worker | 0 | 0 | 1s |
| @typease/tests | 0 | 0 | 18s |
| @typease/api-client | 0 | 0 | 8s |
| @typease/branding | 0 | 0 | 4s |
| @typease/config | 0 | n/a (no-op script) | 1s |
| @typease/permissions | 0 | 0 | 2s |
| @typease/types | 0 | 0 | 3s |
| @typease/ui | 0 | 0 | 16s |
| @typease/validation | 0 | 0 | 9s |
| @typease/database | 0 | 0 | 6s |
| @typease/centre-web | 0 | 0 | 7s |
| @typease/corporate-portal | 0 | 0 | 5s |
| @typease/customer-web | 0 | 0 | 5s |
| @typease/platform-admin | 0 | 0 | 5s |

# 4. Package unit tests

## test-ui

- Command: `pnpm --filter @typease/ui test`
- Date: 2026-10-13 18:08:34 +0400
- Exit code: **0**
- Wall time: 28s
- Log: `/tmp/final-verify/test-ui.log`

Summary lines:

```
> vitest run --passWithNoTests
 Test Files  7 passed (7)
      Tests  134 passed (134)
   Duration  27.31s (transform 2.83s, setup 1.38s, collect 4.07s, tests 13.24s, environment 5.80s, prepare 947ms)
```

## test-api-client

- Command: `pnpm --filter @typease/api-client test`
- Date: 2026-10-13 18:09:02 +0400
- Exit code: **0**
- Wall time: 5s
- Log: `/tmp/final-verify/test-api-client.log`

Summary lines:

```
> vitest run --passWithNoTests
 Test Files  5 passed (5)
      Tests  57 passed (57)
   Duration  3.17s (transform 518ms, setup 0ms, collect 738ms, tests 324ms, environment 1ms, prepare 710ms)
```

## test-branding

- Command: `pnpm --filter @typease/branding test`
- Date: 2026-10-13 18:09:07 +0400
- Exit code: **0**
- Wall time: 4s
- Log: `/tmp/final-verify/test-branding.log`

Summary lines:

```
> vitest run --passWithNoTests
 Test Files  3 passed (3)
      Tests  38 passed (38)
   Duration  2.79s (transform 277ms, setup 0ms, collect 462ms, tests 1.14s, environment 1ms, prepare 402ms)
```

## test-permissions

- Command: `pnpm --filter @typease/permissions test`
- Date: 2026-10-13 18:09:11 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/test-permissions.log`

Summary lines:

```
> vitest run --passWithNoTests
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  647ms (transform 160ms, setup 0ms, collect 156ms, tests 13ms, environment 0ms, prepare 159ms)
```

## test-types

- Command: `pnpm --filter @typease/types test`
- Date: 2026-10-13 18:09:13 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/test-types.log`

Summary lines:

```
> vitest run --passWithNoTests
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  625ms (transform 202ms, setup 0ms, collect 215ms, tests 8ms, environment 0ms, prepare 130ms)
```

## test-config

- Command: `pnpm --filter @typease/config test`
- Date: 2026-10-13 18:09:15 +0400
- Exit code: **0**
- Wall time: 0s
- Log: `/tmp/final-verify/test-config.log`

Summary lines:

```
# tests 4
# suites 0
# pass 4
# fail 0
```

## test-validation

- Command: `pnpm --filter @typease/validation test`
- Date: 2026-10-13 18:09:15 +0400
- Exit code: **0**
- Wall time: 1s
- Log: `/tmp/final-verify/test-validation.log`

Summary lines:

```
> vitest run --passWithNoTests
No test files found, exiting with code 0
```

## test-api-unit

- Command: `pnpm --filter @typease/api test:unit`
- Date: 2026-10-13 18:09:20 +0400
- Exit code: **0**
- Wall time: 18s
- Log: `/tmp/final-verify/test-api-unit.log`

Summary lines:

```
Test Suites: 40 passed, 40 total
Tests:       527 passed, 527 total
Snapshots:   0 total
Time:        14.079 s
```

### Package unit test summary

| Package | Runner | Result | Exit |
|---|---|---|---|
| @typease/ui | vitest | 7 files, 134 tests passed (27.3s) | 0 |
| @typease/api-client | vitest | 5 files, 57 tests passed | 0 |
| @typease/branding | vitest | 3 files, 38 tests passed | 0 |
| @typease/permissions | vitest | 1 file, 6 tests passed | 0 |
| @typease/types | vitest | 1 file, 5 tests passed | 0 |
| @typease/config | node --test | 4 tests passed, 0 failed | 0 |
| @typease/validation | vitest | **no tests** ("No test files found, exiting with code 0" via `--passWithNoTests`) | 0 |
| @typease/api `test:unit` (`jest --testPathPattern=\.unit\.`) | jest | 40 suites, 527 tests passed (14.1s) | 0 |

Package totals (excluding the API): 17 files / 244 tests passed, 0 failed.

## API full suite (recorded run)

Not re-run here: the full `pnpm --filter @typease/api test` (jest, `--runInBand`, hits PostgreSQL + Redis) was executed earlier today by the other engineer; its log is `/tmp/api-tests.log` (written 2026-10-13 16:39 +04). Summary: **99 suites / 1485 tests passed, 0 failed, 1060.8 s** (99 `PASS` lines, 0 `FAIL` lines in the log).

First 5 lines of `/tmp/api-tests.log`:

```

> typease@1.0.0 test:api /home/claude/typease
> pnpm --filter @typease/api test


```

Last 8 lines of `/tmp/api-tests.log`:

```
PASS src/modules/requests/lifecycle-diagram.unit.spec.ts
PASS src/common/author-display.unit.spec.ts

Test Suites: 99 passed, 99 total
Tests:       1485 passed, 1485 total
Snapshots:   0 total
Time:        1060.819 s
Ran all test suites.
```

# 5. Production builds

## build-api

- Command: `pnpm build:api`
- Date: 2026-10-13 18:09:53 +0400
- Exit code: **0**
- Wall time: 33s
- Log: `/tmp/final-verify/build-api.log`

Summary lines:

```
> tsc -p tsconfig.build.json
> tsc -p tsconfig.json
```
- build:api note: both tsc builds produced no diagnostics; `services/api/dist/main.js` and `services/worker/dist/main.js` exist.

## build-web

- Command: `pnpm build:web`
- Date: 2026-10-13 18:10:34 +0400
- Exit code: **0**
- Wall time: 342s
- Log: `/tmp/final-verify/build-web.log`

Summary lines:

```
   ▲ Next.js 15.5.4
   Creating an optimized production build ...
 ✓ Compiled successfully in 49s
   Generating static pages (0/61) ...
   Generating static pages (15/61) 
   Generating static pages (30/61) 
   Generating static pages (45/61) 
 ✓ Generating static pages (61/61)
Route (app)                                 Size  First Load JS
   ▲ Next.js 15.5.4
   Creating an optimized production build ...
 ✓ Compiled successfully in 24.0s
   Generating static pages (0/29) ...
   Generating static pages (7/29) 
   Generating static pages (14/29) 
   Generating static pages (21/29) 
 ✓ Generating static pages (29/29)
Route (app)                                 Size  First Load JS
   ▲ Next.js 15.5.4
   Creating an optimized production build ...
 ✓ Compiled successfully in 26.9s
   Generating static pages (0/24) ...
   Generating static pages (6/24) 
   Generating static pages (12/24) 
   Generating static pages (18/24) 
 ✓ Generating static pages (24/24)
Route (app)                                 Size  First Load JS
   ▲ Next.js 15.5.4
   Creating an optimized production build ...
 ✓ Compiled successfully in 21.1s
   Generating static pages (0/22) ...
   Generating static pages (5/22) 
   Generating static pages (10/22) 
   Generating static pages (16/22) 
 ✓ Generating static pages (22/22)
Route (app)                                 Size  First Load JS
```

### Web build summary (`pnpm build:web`, exit 0, 342s total, Next.js 15.5.4)

| App | Compile | Static-page generation step | Routes in `Route (app)` table | Middleware | Shared First Load JS |
|---|---|---|---|---|---|
| @typease/centre-web | ✓ Compiled successfully in 49s | ✓ Generating static pages (61/61) | 80 (all `ƒ` dynamic) | 34.3 kB | 102 kB |
| @typease/customer-web | ✓ Compiled successfully in 24.0s | ✓ Generating static pages (29/29) | 33 | 34.6 kB | 102 kB |
| @typease/corporate-portal | ✓ Compiled successfully in 26.9s | ✓ Generating static pages (24/24) | 28 | 34.5 kB | 102 kB |
| @typease/platform-admin | ✓ Compiled successfully in 21.1s | ✓ Generating static pages (22/22) | 23 | 34.1 kB | 102 kB |

No warnings or errors in the build log (grep for `warn`/`error` returns nothing). Total: 164 routes across the four apps.

# 6. Production-readiness gate

## readiness-help

- Command: `node scripts/production-readiness.mjs --help`
- Date: 2026-10-13 18:16:44 +0400
- Exit code: **0**
- Wall time: 0s
- Log: `/tmp/final-verify/readiness-help.log`

Summary lines:

```
Usage: node scripts/production-readiness.mjs [options]
  --env-file <path>       Environment file to check (repeatable; later files win).
                          ignored, so the result describes the file. Add --inherit-env to overlay it.
  --inherit-env           Also read the process environment (the file still wins).
  --database-url <url>    Connection used for the inspection (default: DATABASE_MIGRATION_URL,
  --migrations-dir <dir>  Default: database/migrations
  --backup-marker <file>  Marker written by scripts/db-backup.sh (default: $BACKUP_MARKER_FILE)
  --backup-max-age-hours <n>   Default 26
  --skip-db | --skip-redis | --skip-network   Skip live probes (reported as SKIP, never as PASS)
  --strict                WARN also produces a non-zero exit code
  --json                  Machine-readable output
  --no-color
```

## readiness-env-example

- Command: `node scripts/production-readiness.mjs --env-file .env.example --skip-db --skip-redis --skip-network --no-color`
- Date: 2026-10-13 18:16:44 +0400
- Exit code: **1**
- Wall time: 0s
- Log: `/tmp/final-verify/readiness-env-example.log`

Summary lines:

```
  FAIL  NODE_ENV is production                                  NODE_ENV is "development" - the API only applies its production safety
  FAIL  JWT_ACCESS_SECRET is a generated secret                 JWT_ACCESS_SECRET is the published development / example value - the API
  FAIL  HMAC_KEY is a generated secret                          HMAC_KEY is the published development / example value - the API refuses to
  FAIL  INTERNAL_API_TOKEN is a generated secret                a published development value or a placeholder - the API refuses to start
  FAIL  DATA_ENCRYPTION_KEY is 32 random bytes                  DATA_ENCRYPTION_KEY is the published development / example value - the API
  PASS  Encryption keyring is readable                          one key, no rotation in progress
  PASS  Secrets are distinct                                    4 secrets, all different
  FAIL  PAYMENT_SANDBOX_ENABLED is off                          the sandbox payment adapter is enabled: payments could be "completed"
  FAIL  EXPOSE_DEV_TOKENS is off                                OTP / verification tokens would be returned in API responses
  FAIL  COOKIE_SECURE is on                                     refresh cookies would be sent over plain HTTP
  FAIL  MFA_ENFORCEMENT is required                             "optional" - privileged roles could sign in without a second factor
  PASS  RATE_LIMIT_ENABLED is on                                true
  FAIL  API_PUBLIC_URL is HTTPS                                 http://localhost:4000/ is not https
  FAIL  CENTRE_WEB_URL is HTTPS                                 http://localhost:3001/ is not https
  FAIL  CUSTOMER_WEB_URL is HTTPS                               http://localhost:3002/ is not https
  FAIL  CORPORATE_WEB_URL is HTTPS                              http://localhost:3003/ is not https
  FAIL  PLATFORM_ADMIN_URL is HTTPS                             http://localhost:3004/ is not https
  PASS  CORS_ORIGINS are HTTPS origins                          none (the four app URLs and verified tenant domains are always allowed)
  FAIL  PLATFORM_BASE_DOMAIN is a real domain                   "typease.localhost" is not a public host name
  FAIL  CUSTOM_DOMAIN_CNAME_TARGET is a real domain             "portal.typease.localhost" is not a public host name
  FAIL  DATABASE_URL password is strong                         password is 10 characters and/or a known development / placeholder value
  FAIL  DATABASE_SYSTEM_URL password is strong                  password is 13 characters and/or a known development / placeholder value
  FAIL  DATABASE_MIGRATION_URL password is strong               password is 12 characters and/or a known development / placeholder value
  PASS  Database roles have different passwords                 3 roles
  PASS  REDIS_URL is set                                        redis://127.0.0.1:6379/0
  WARN  QUEUE_DRIVER is bullmq                                  inline with QUEUE_INLINE_AUTORUN (single-process mode): jobs live in the
  FAIL  STORAGE_DRIVER is s3                                    "local": files would live on the API container's disk (not shared between
  WARN  Malware scanning is enabled                             MALWARE_SCANNER=none: uploads are marked SKIPPED and are never scanned
  WARN  Email delivery is configured                            MAIL_DRIVER=log: verification, invitation and password-reset emails are only
  WARN  MAIL_FROM_ADDRESS is a real address                     "no-reply@typease.localhost" will be rejected by mail servers
  WARN  SMS delivery is configured                              SMS_DRIVER=log: OTP login and SMS notifications are only written to the log
  WARN  Platform payment gateway is configured                  no STRIPE_SECRET_KEY: subscription invoices can only be settled offline by a
  WARN  LOG_FORMAT is json                                      text: readable on a console, but a log collector wants one JSON object per
  PASS  PASSWORD_MIN_LENGTH is between 10 and 128               10
  PASS  WORKER_HEARTBEAT_INTERVAL_SECONDS is between 5 and 300  15
  SKIP  Database inspection                                     --skip-db
  SKIP  Redis is reachable                                      --skip-redis
  FAIL  A recent database backup exists                         no evidence: pass --backup-marker <file written by scripts/db-backup.sh> (or
Summary: 8 PASS, 7 WARN, 21 FAIL, 2 SKIP  ->  NOT READY FOR PRODUCTION
```

### Readiness gate interpretation

The script has no dedicated "check" sub-command; the file-only mode is `--env-file <path>` (the shell environment is then ignored). The live probes were skipped with `--skip-db --skip-redis --skip-network` so the result describes `.env.example` alone. Result: **exit 1, "Summary: 8 PASS, 7 WARN, 21 FAIL, 2 SKIP -> NOT READY FOR PRODUCTION"**. Every FAIL is a placeholder / development value in `.env.example` (development secrets, `NODE_ENV=development`, http://localhost URLs, `*.typease.localhost` domains, short dev DB passwords, sandbox payments, `EXPOSE_DEV_TOKENS`, `COOKIE_SECURE` off, no backup marker). This is the expected and correct behaviour: the gate rejects the example file. `--help` exits 0 and prints the usage.

# 7. Infrastructure static validation

## validate-infra

- Command: `bash scripts/validate-infra.sh`
- Date: 2026-10-13 18:16:52 +0400
- Exit code: **0**
- Wall time: 2s
- Log: `/tmp/final-verify/validate-infra.log`

Summary lines:

```
PASS  sh -n infrastructure/docker/entrypoint.sh
PASS  sh -n infrastructure/docker/minio/init-buckets.sh
PASS  bash -n infrastructure/docker/postgres/init/01-typease-roles.sh
PASS  bash -n scripts/ci-api-tests.sh
PASS  bash -n scripts/db-backup.sh
PASS  bash -n scripts/db-restore.sh
PASS  bash -n scripts/deploy.sh
PASS  bash -n scripts/dev-api.sh
PASS  bash -n scripts/dev-down.sh
PASS  bash -n scripts/dev-stop.sh
PASS  bash -n scripts/dev-up.sh
PASS  bash -n scripts/dev-web-supervised.sh
PASS  bash -n scripts/generate-secrets.sh
PASS  bash -n scripts/lib/backup-common.sh
PASS  bash -n scripts/smoke-test.sh
PASS  bash -n scripts/start-web-standalone.sh
PASS  bash -n scripts/storage-backup.sh
PASS  bash -n scripts/validate-infra.sh
PASS  bash -n scripts/wait-for.sh
SKIP  shellcheck  (not installed, no Docker daemon)
PASS  node --check scripts/production-readiness.mjs
PASS  every variable of env.ts is documented in .env.example and typease.env.example
PASS  .env.example passes the API's own validation (dist build)
PASS  no real secret file is tracked or present in infrastructure/deployment/env
PASS  docker compose config: docker-compose.yml (profiles full, deps, monitoring, seed)
PASS  docker compose config: docker-compose.prod.yml (bundled services + monitoring)
PASS  docker compose config: docker-compose.prod.yml (managed data services)
PASS  production stack publishes only ports 80 and 443 (Caddy)
PASS  YAML parses: monitoring configuration and GitHub workflows
PASS  JSON parses: Grafana dashboard, bucket lifecycle
SKIP  caddy validate (Caddyfile, Caddyfile.prod)  (caddy is not installed, no Docker daemon)
SKIP  promtool / amtool / alloy fmt  (not installed, no Docker daemon)
SKIP  hadolint / docker build --check  (not installed, no Docker daemon)
SKIP  actionlint (.github/workflows)  (not installed, no Docker daemon)
Summary: 29 PASS, 0 FAIL, 5 SKIP
```

Result: **29 PASS, 0 FAIL, 5 SKIP** (exit 0). The 5 SKIPs are tools not installed on this machine and no Docker daemon available (shellcheck, caddy validate, promtool/amtool/alloy, hadolint/docker build --check, actionlint); the script reports these as SKIP, never PASS. `--strict` was not used (it would turn the SKIPs into failures; it is meant for CI with Docker).

# 8. Demo seed verification (read-only)

## seed-verify

- Command: `node scripts/seed-verify.mjs --env-file=.env.dev-local`
- Date: 2026-10-13 18:17:04 +0400
- Exit code: **1**
- Wall time: 1s
- Log: `/tmp/final-verify/seed-verify.log`

Summary lines:

```
   ok    al-noor: a failed online payment attempt
     al-noor      1530  EMAIL sent 816, EMAIL suppressed 123, IN_APP sent 313, SMS failed 5, SMS sent 246, SMS suppressed 27
   ok    al-noor: notifications sent, failed and suppressed - sent, suppressed, failed
51 of 59 checks passed. FAILED: exactly the three demo centres exist | gulf-star: name, plan, status, branches, branding | one platform super admin and one support agent | every phone number is in the demo range +971 59 000 xxxx (198 distinct values in 9 columns) | licence, tax and external reference numbers are labelled sample values (SAMPLE-...) | companies, authorities and partners carry "demo" / "fictional" in their name | every Emirates ID (77) and passport number (86) is from the fake demo ranges | every uploaded file is a generated sample (292 files named sample-...)
```

### Seed verification result: FAIL (51 of 59 checks passed, 8 failed, exit 1)

The script did not need the API (it connects directly, read-only, as `typease_system` to `typease_dev` on 127.0.0.1:5432), so the API was not started. The 8 failures were NOT fixed and are recorded as-is:

| Failed check | Detail from the log |
|---|---|
| exactly the three demo centres exist | 10 centres found: the 3 seeded ones plus `probe-10881`, `shots-bzna0`, `shots-c0gj2`, `harbour-docs`, `docs-example`, `shots-console`, `shots-flow-m5l3m` (all created 2026-10-09) |
| gulf-star: name, plan, status, branches, branding | 2 branches found, the seed creates 1 (everything else matches) |
| one platform super admin and one support agent | SUPER_ADMIN 1, SUPPORT_AGENT 2 |
| every phone number is in the demo range +971 59 000 xxxx | 8 phone values outside the range (customers / appointments / branches) |
| licence, tax and external reference numbers are labelled sample values | 5 company and 2 payment references without the `SAMPLE-` label |
| companies, authorities and partners carry "demo" / "fictional" in their name | 5 company names without it |
| every Emirates ID (77) and passport number (86) is from the fake demo ranges | 23 outside the ranges, e.g. CUS-000051 (the script itself suggests a wrong `HMAC_KEY`; it may also be the non-seed customers) |
| every uploaded file is a generated sample (292 files named sample-...) | 37 files with another name |

Reading of the failures (not verified by re-seeding, which would have been a write): every failure is consistent with the `typease_dev` database no longer being a fresh `pnpm db:seed` result - seven additional centres and the extra users, branch, customers, companies and uploads were created on 2026-10-09, i.e. by the screenshot / documentation and probing sessions that used this database after it was seeded. The 51 passing checks cover the seeded centres' structure, cross-centre isolation, request states, finance and notification data. A clean pass would require re-seeding (`pnpm db:reset && pnpm db:seed`) and re-running the script; that was outside the scope of this read-only verification and was not done.

# Overall summary

| # | Command | Exit | Key result |
|---|---|---|---|
| 1 | `pnpm build:packages` | 0 | 8 packages built, Prisma Client 7.10.0 generated, 60 s |
| 2 | `pnpm lint:root` + 15 `pnpm --filter <pkg> lint` | 0 (all) | 0 errors, 375 warnings total (api 366, database 8, centre-web 1), every package at or under budget |
| 3 | 15 x `pnpm --filter <pkg> typecheck` | 0 (all) | 0 type errors |
| 4a | 7 x `pnpm --filter @typease/<pkg> test` | 0 (all) | 244 tests passed (ui 134, api-client 57, branding 38, permissions 6, types 5, config 4); validation has no tests |
| 4b | `pnpm --filter @typease/api test:unit` | 0 | 40 suites / 527 tests passed, 14.1 s |
| 4c | API full suite (recorded, `/tmp/api-tests.log`) | - | 99 suites / 1485 tests passed, 1060.8 s |
| 5a | `pnpm build:api` | 0 | API + worker built, 33 s |
| 5b | `pnpm build:web` | 0 | 4 apps "Compiled successfully" (49s / 24.0s / 26.9s / 21.1s), 164 routes, 342 s |
| 6 | `node scripts/production-readiness.mjs --env-file .env.example --skip-db --skip-redis --skip-network` | 1 (expected) | 8 PASS, 7 WARN, 21 FAIL, 2 SKIP - rejects the example placeholders as designed |
| 7 | `bash scripts/validate-infra.sh` | 0 | 29 PASS, 0 FAIL, 5 SKIP (tools not installed) |
| 8 | `node scripts/seed-verify.mjs --env-file=.env.dev-local` | **1** | **51 / 59 checks passed, 8 failed** - development database contains non-seed data from the 9 October screenshot / documentation sessions |

Not run in this verification: `pnpm test:integration` and `pnpm test:security` (executed in parallel by the acceptance engineer), any Playwright, Flutter or Docker step (none available, as `docs/TEST_REPORT.md` states).


## 9. Addendum: demo seed re-run (after section 8)

Because section 8 showed the development database was no longer a fresh seed, it was reset and re-seeded
(`ALLOW_DB_RESET=true pnpm db:reset`, then `pnpm db:seed` with the `.env.dev-local` settings).

- First attempt: stopped after 215 s in the appointments step with `gs-a04: no free appointment slot at
  Musaffah Office on 2026-10-16` - the fixture's "upcoming" day fell on a day the branch is closed.
- Fix: `services/api/src/cli/seed/phase-operations.ts`, `slotFor()` now tries the following days (up to a
  week) when the wanted day has no free slot.
- Second attempt (after another reset): completed in 213 s (3m33s wall clock).
- `node scripts/seed-verify.mjs --env-file=.env.dev-local`: **59 of 59 checks passed**, exit 0.
