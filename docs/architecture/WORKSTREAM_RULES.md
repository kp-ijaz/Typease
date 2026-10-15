# Workstream rules (several engineers are working in this repository at the same time)

You are one of several engineers building TypEase modules IN PARALLEL in the same working tree
(`/home/claude/typease`). Follow these rules exactly so nobody breaks anybody else.

## Read first
1. `docs/architecture/BACKEND_CONVENTIONS.md` (how modules are written - mandatory).
2. `docs/brand/MASTER_PROMPT.md` - the product specification. Read the sections named in your assignment.
3. `database/prisma/schema.prisma` - the data model. It is the contract; find your tables there.
4. Reference code: `services/api/src/modules/tenancy/*.ts`, `services/api/src/common/*.ts`,
   `services/api/test/helpers.ts`, `services/api/test/foundation.spec.ts`.
5. `packages/types/src/*.ts`, `packages/permissions/src/index.ts`, `packages/validation/src/common.ts`.

## Files you may create or edit
ONLY the module folders and validation / docs files named in your assignment.

You must NOT edit: `database/**`, `services/api/src/common/**`, `services/api/src/config/**`,
`services/api/src/app.module.ts`, `services/api/src/modules/index.ts`, `services/api/test/**`,
`packages/types/**`, `packages/permissions/**`, `packages/validation/src/common.ts`,
`packages/validation/src/index.ts`, any `package.json`, or any other engineer's module folder.

- Modules are auto-discovered: just create `services/api/src/modules/<name>/<name>.module.ts`.
- All environment variables already exist in `services/api/src/config/env.ts`. Use them via `env()`.
- Do not add npm dependencies. Everything listed in `services/api/package.json` is installed. If you truly
  cannot do without another package, say so in your final report instead of installing it.
- If you believe the database schema needs a change, DO NOT change it. Work with the existing columns
  (JSON columns such as `settings`, `config`, `meta`, `payload` exist for extensibility) and describe the
  wish in your final report.
- Other modules may not exist yet while you work. Never import another engineer's module. Read their
  tables through Prisma, and communicate through domain events (see the conventions) and ports
  (`services/api/src/common/ports.ts`).
- Put test fixtures for your module in your own folder (e.g. `src/modules/<name>/fixtures.ts`). Create rows
  of other modules' tables directly with Prisma (`t.sys.<model>.create` or `t.inTenant(...)`) when your tests
  need them.

## Environment (shared machine: 2 CPU cores, 8 GB RAM - be gentle)
- PostgreSQL 16 on 127.0.0.1:5432 and Redis on 127.0.0.1:6379 are running. Do not restart or reconfigure them.
- Always `export PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` in a shell before any pnpm / prisma command.
- Never run `prisma migrate`, `prisma db push`, `pnpm install` or `pnpm add`.
- No internet access except what is already installed. Do not try to download anything.
- Run ONE heavy command at a time, never in the background, and never the whole test suite.
- Your private test database, Redis db and storage dir are given in your assignment. Run your tests like this
  (from `/home/claude/typease`):

  ```bash
  export PRISMA_SCHEMA_ENGINE_BINARY=/bin/true NODE_OPTIONS=--max-old-space-size=1536
  TEST_PG_DATABASE=<yours> TEST_REDIS_URL=redis://127.0.0.1:6379/<n> TEST_STORAGE_DIR=/tmp/typease-test-<yours> \
  TYPEASE_MODULES=<your,module,folders> \
  pnpm --filter @typease/api exec jest --runInBand src/modules/<folder>
  ```

  `TYPEASE_MODULES` makes the app load only your modules, so half-finished code of other engineers cannot
  break your run. The test database is rebuilt from the migration files on every jest invocation.
- Type-check (slow, use sparingly - a few times in total) and look only at YOUR files:

  ```bash
  pnpm --filter @typease/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "src/modules/(<your|folders>)/|packages/validation/src/(<your|files>)\.ts"
  ```

  Errors in other folders belong to other engineers: ignore them. Your own files must end with zero errors.
  Typing tips: type service inputs as `z.infer<typeof schema>` (export the type from the validation file);
  do not annotate service return types with Prisma payload types unless needed.

## Definition of done
1. Everything in your assignment is implemented for real: persisted in PostgreSQL, authorised, audited,
   tenant-isolated. No TODOs, no stubs, no fake success. Where an external service is needed and no
   credentials exist: interface + real adapter + clear NOT_CONFIGURED behaviour (see conventions section 7).
2. Integration tests (`*.spec.ts`) in your module folders pass with the command above, covering the five
   points in conventions section 8. Pure logic has `*.unit.spec.ts` tests.
3. Zero TypeScript errors in your files.
4. `docs/api/modules/<module>.md` exists for each module you built: a table of every endpoint (method, path,
   access rule / permission, request body or query, response shape with a short JSON example for the main
   ones), the events emitted / consumed, the background jobs, and the business rules a frontend developer or
   an operator must know. Write only what is implemented.
5. Your final message is a concise report: files created, endpoint count, test results (real numbers from the
   last run: suites / tests passed / failed), anything you could not finish or verify, assumptions made about
   other modules, and schema wishes. Be precise and honest: an accurate "X is not done" is far more useful
   than a rosy summary.

---

# Phase 2 notes (read these too - they override anything above that conflicts)

- All phase-1 backend modules are finished and tested: auth, tenancy, customers, corporate, catalogue, workflows,
  requests, storage, documents, ocr, privacy, finance, subscriptions, notifications, reminders, appointments, queue,
  tasks, support. 477 endpoints. You MAY now import and inject the exported services of those modules (check each
  module's `*.module.ts` for what it exports; if a service you need is not exported, you may add it to that module's
  `exports` array - that is the only edit allowed in another module unless your assignment says otherwise).
- API reference for everything that exists: `docs/api/ENDPOINTS.md` (every route + access rule),
  `docs/api/modules/*.md` (request / response details, business rules), `docs/api/openapi.json`.
- A TypEase API server is ALREADY RUNNING on http://localhost:4000 (prefix `/api/v1`, Swagger UI at `/api/docs`).
  It runs a build snapshot against the `typease_dev` database in single-process mode with `EXPOSE_DEV_TOKENS=true`
  (email-verification / invitation / OTP tokens are returned in a `dev` field of the JSON responses) and
  `PAYMENT_SANDBOX_ENABLED=true`. Do NOT stop, restart or rebuild it, and do not reset the `typease_dev` database.
  It does not contain code written in this phase.
- `pnpm install` / `pnpm add` remain forbidden unless your assignment explicitly allows it.
- The shared machine rule still applies: one heavy command at a time, nothing in the background except what your
  assignment explicitly allows, never the whole test suite.
