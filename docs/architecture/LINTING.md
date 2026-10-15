# Linting

ESLint 9 (flat config) runs over every JavaScript/TypeScript workspace from one
file, `eslint.config.mjs` at the repository root. The rules are deliberately
**non-type-aware**: `tsc --noEmit` already runs in the `typecheck` step, so a
lint run needs no tsconfig, uses little memory and finishes in seconds per
package.

## How to run it

```bash
pnpm lint                              # root scripts, then every workspace package, one at a time
pnpm lint:root                         # scripts/** and eslint.config.mjs only
pnpm --filter @typease/centre-web lint # one package
pnpm --filter @typease/ui exec eslint . --fix   # auto-fix the behaviour-neutral rules in one package
```

Every workspace `lint` script is `eslint . --max-warnings=<budget>`, so a run
fails on any error and on any warning above the package's budget. On the
shared build machine, run one package at a time with
`NODE_OPTIONS=--max-old-space-size=2048`.

## Running lint in CI

`.github/workflows/ci.yml` runs `pnpm lint` in the `quality` job (step "Lint"),
after `pnpm install --frozen-lockfile`, `pnpm build:packages` and
`pnpm typecheck` and before the package unit tests. Nothing else is needed:
the root script runs `lint:root` and then every workspace package with
`--workspace-concurrency=1`, and each package's `--max-warnings` budget makes
the step fail on any error or on warnings above the budget. ESLint needs no
build output, but `build:packages` must precede it only because it is also
what generates the Prisma client that `typecheck` needs; the lint step itself
reads sources only. There is no separate ESLint cache in CI; a full run takes
well under a minute per app.

## What is linted, with which rules

| Code | Rule sets |
| --- | --- |
| Everything (`*.ts/tsx/js/mjs/cjs`) | `@eslint/js` recommended, `typescript-eslint` recommended (non-type-checked), `eqeqeq` (null-tolerant), `prefer-const`, `no-var`, `no-empty` (empty `catch` allowed), `@typescript-eslint/no-unused-vars` with the `_` prefix escape, `@typescript-eslint/no-explicit-any` as **warn**, `@typescript-eslint/consistent-type-imports` (inline `type` imports) |
| `apps/*`, `packages/ui`, `packages/api-client`, `packages/branding` | `react-hooks/rules-of-hooks` (error), `react-hooks/exhaustive-deps` (warn), browser globals, `dangerouslySetInnerHTML` forbidden outside the allow-list |
| `apps/*`, `packages/ui` | `no-console` error (`console.warn` / `console.error` allowed) |
| `apps/*` | `no-restricted-imports`: no imports from other apps, `apps/customer-mobile`, `services/**`, `@typease/api`, `@typease/worker` or the database package |
| `packages/*` | `no-restricted-imports`: no imports from `apps/**`, `services/**`, `@typease/api`, `@typease/worker` |
| `services/**`, `database/**`, `scripts/**`, `tests/**`, config files (`next.config.mjs`, `postcss`, `tailwind`, `vitest.config.ts`) | Node globals; `consistent-type-imports` is off for `services/**` and `tests/**` because NestJS DI with `emitDecoratorMetadata` needs classes imported as values even when they appear only as constructor-parameter types |
| Playwright screenshot scripts (`packages/ui/scripts/screenshots.mjs`, `apps/*/scripts/shots*.mjs`) | Node + browser globals (their `page.evaluate()` callbacks run in the page) |
| Vitest tests (`packages/**/*.test.ts(x)`, `packages/ui/src/test-setup.ts`) | Node + browser (jsdom) globals; `no-console` and `no-explicit-any` off |
| Jest suites (`services/api/**/*.spec.ts`, `services/api/test/**`, `tests/{integration,security,support}/**`) | Node + Jest globals; `no-console`, `no-explicit-any`, `no-non-null-assertion` off |
| Playwright e2e (`tests/e2e/**`) | Node + browser globals; `no-console`, `no-explicit-any` off |
| `*.d.ts` | `no-explicit-any` and `no-unused-vars` off |

Plugins in use: `typescript-eslint` 8.45, `eslint-plugin-react-hooks` 5.2,
`globals` 16.4, `@eslint/js` 9.36 (resolved through eslint's own dependency,
as it is not hoisted to the root). **Not installed, and therefore not used:**
`@next/eslint-plugin-next`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`,
`eslint-plugin-import`. Adding `@next/eslint-plugin-next` would be the most
valuable next step (`no-img-element`, `no-html-link-for-pages`, font/script
rules); the three `<img>` usages that would need `@next/next/no-img-element`
exceptions are marked with plain comments explaining why they are plain `<img>`
tags (tenant-uploaded logo URLs and blob URLs that `next/image` cannot serve).

### `dangerouslySetInnerHTML` allow-list

Only two files may use it, both in `packages/ui/src/providers`:

- `theme-script.tsx` - the constant inline theme bootstrap script (CSP nonce).
- `brand-style.tsx` - the tenant's brand colours as CSS custom properties.

Anything else fails `no-restricted-syntax`. Extend `RAW_HTML_ALLOW_LIST` in
`eslint.config.mjs` only with a review.

## Warning budgets

| Package | `--max-warnings` | Why |
| --- | --- | --- |
| `@typease/centre-web` | 1 | one `react-hooks/exhaustive-deps` warning in `components/fin/line-editor.tsx:65` (`items` from `useWatch` is re-created on every render). Dependency arrays are not changed by the lint pass; fix it by moving the `?? []` fallback inside the `useMemo`. |
| `@typease/database` | 8 | eight `@typescript-eslint/no-explicit-any` in `scripts/prisma-to-sql.ts`, a build-time script that walks Prisma's loosely typed DMMF. |
| `@typease/api` | 366 | 366 `@typescript-eslint/no-explicit-any` across the API (Prisma `tx: any` plumbing, raw-SQL rows, webhook payloads, test fixtures in non-spec `fixtures.ts` files). The lint pass deliberately rewrote no types; the budget is the exact count at the time of the pass and should only go down. |
| every other package (including `@typease/tests` and `@typease/worker`), and `pnpm lint:root` | 0 | clean |

## What is deliberately not linted

`node_modules`, `dist`, `build`, `coverage`, `.next*`, `out`, `*.tsbuildinfo`,
`next-env.d.ts`, generated code (`packages/types/src/generated/**`,
`database/generated/**`, `docs/api/openapi.json`), the Flutter app
(`apps/customer-mobile/**`, linted by `dart analyze`), `storage-data/**`,
`docs/**` and `infrastructure/**`.

## Inline disables added by the lint pass

All existing `react-hooks/exhaustive-deps` and `no-explicit-any` directives were
left in place (one unused `exhaustive-deps` directive in
`apps/platform-admin/app/(app)/staff/staff.tsx` was removed). New ones:

| File | Rule | Reason |
| --- | --- | --- |
| `packages/api-client/src/download.ts` | `no-control-regex` | the regex strips control characters from a server-supplied file name |
| `packages/ui/src/lib/safe-path.ts` | `no-control-regex` | the regex rejects control characters in a `next=` redirect path |
| `packages/ui/src/lib/lib.test.ts` | `no-constant-binary-expression` | `false && 'hidden'` is the `cn()` input being tested |
| `services/api/src/common/files.ts` | `no-control-regex` | control characters are what is stripped from an uploaded file name |
| `services/api/src/modules/finance/pdf.renderer.ts` | `no-control-regex` | tab and newline are kept on purpose in the Latin-1 whitelist of the PDF text sanitiser |
| `services/api/src/modules/{catalogue,corporate,documents}/fixtures.ts` (4x), `services/api/test/helpers.ts`, `test/encryption.spec.ts`, `test/foundation.spec.ts` | `@typescript-eslint/no-require-imports` | `require('.../auth.service')` inside a fixture function is a deliberate lazy load of the auth module graph; a top-level import would change spec-file load order |
| `services/api/test/global-setup.ts` | `@typescript-eslint/no-require-imports` | `require('./env')` is a side-effect module (process.env defaults) loaded when the setup runs |
| `tests/support/jobs.ts` (2x) | `@typescript-eslint/no-require-imports` | `require('.../config/env')` is deferred on purpose: that module reads `process.env` when it loads, which must happen after the test app has set the variables; a top-level import would change the load order |

Unused directives are reported as warnings (`reportUnusedDisableDirectives`), so
a disable that stops being needed counts against the package's budget.

The 19 `require()` calls that were provably load-order-safe (`node:fs`,
`node:path`, `otplib`, `@nestjs/core`, `../src/common/auth/access`, and
modules the file already imported statically) were converted to static
imports in `services/api` spec files and `test/helpers.ts`.

`services/api/test/helpers.js` is ignored: it is stale `tsc` output checked
in next to `helpers.ts` (see the note in `tests/jest.config.js`), not source.

## State on 2026-10-13

Every workspace package lints with zero errors inside its budget; `pnpm lint`
from the root passes end to end.
