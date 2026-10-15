# tests/e2e - browser end-to-end tests: NOT WRITTEN

`pnpm test:e2e` is not a passing test suite. It prints this file and exits with status 1 so that nobody
mistakes it for one. There is no `playwright.config.ts` in this folder and no `*.spec.ts`: the Playwright
browser tests that `docs/TESTING.md` lists as level 4 were deliberately not written, to deliver the rest
of the product sooner. This is a gap against section 39 of `docs/brand/MASTER_PROMPT.md` and is recorded in
`docs/KNOWN_LIMITATIONS.md` (sections 2 and 7) and `docs/TEST_REPORT.md` (section 2.7).

What exists instead is the **screenshot runner** and its **scenario files**. They drive real flows of the
four web applications through a headless Chromium against a running dev server and the demo data, take
pictures in several variants, and report console errors and failed steps - but they are a tool engineers
ran by hand and looked at. They are not assertions in a CI sense: nothing runs them on a change, no pass /
fail record is kept, most scenarios assert only that a page reached a state and a picture could be taken,
and a green run still needs a person to look at the pictures.

## What the screenshot scenarios cover

Runner: `packages/ui/scripts/screenshots.mjs` (loads `@playwright/test`'s Chromium from the `tests`
workspace package; signs in with demo accounts; variants `en-light-desktop`, `ar-dark-desktop`,
`en-light-mobile`, some scenarios also `ar-light-mobile` / `ar-dark-mobile`; prints `ok` / `FAIL` per
picture with the first console error, writes `<name>.FAILED.png` on a failure, and ends with exit code 1
when any scenario failed). It carries a few built-in scenarios per app (sign-in, dashboard, lists, the
component gallery, white-label home pages, the plans page); the bulk is in the per-app files below, passed
with `--scenarios`. Scenario counts are `grep -cE "^\s{2,4}(\{ )?name: '" <file>` at commit `04c2f34`.

| File | Scenarios | What it covers (from the file's own header) |
| --- | --- | --- |
| `apps/centre-web/scripts/shots-foundation.mjs` | 10 | Shared foundation of the staff app: Select, DataTable, dialogs, the shell, print view, Arabic layout, onboarding redirect. Each scenario asserts what it is about with `check(...)` and throws when it does not hold; nothing changes data |
| `apps/centre-web/scripts/shots-cases.mjs` | 30 | The "cases" section: request wizard, case page, tasks. "Look" scenarios in three variants; `flow-*` scenarios drive one request through the whole workflow for real (wizard, review, assignment, preparation, approval, submission, messages, completion, refusal, cancel, self-approval guard, tasks, duplicates) and hand ids to each other; the money part is done by API calls as set-up |
| `apps/centre-web/scripts/shots-people.mjs` | 50 | The "people" section: customer detail, corporate clients, document vault. Records looked up through the API of the seeded demo centre; `people-flow-*` scenarios drive real flows once (edit, note, tag, consent, merge, upload, verify, share, company, employee, contract price, employee login) |
| `apps/centre-web/scripts/shots-fin.mjs` | 37 | The "fin" section: invoices, payments, refunds and their approval, reports and drill-downs, subscription, audit log. Read-only scenarios on seeded records; `flow-quote-to-refund` and `flow-reports` write through the UI (quotation, invoice, payments, refund, scheduled report) |
| `apps/centre-web/scripts/shots-ops.mjs` | 59 | The "ops" section: service catalogue, workflows, appointments, queue, reminders, support tickets, notifications (inbox, templates, delivery log, retry), automations (validation, actions, problems). `*-flow` scenarios create records through the UI and the API |
| `apps/centre-web/scripts/shots-adm.mjs` | 62 | The "adm" section: staff and invitations, roles and the escalation guard, branches and plan limits, settings, white-label branding and logos, custom domains, integrations (SMTP, government authorisation record), privacy (erasure, incidents, vendors, retention, cleanup), support access grants and sessions, onboarding. `flow-*` scenarios change data on the Gulf Star / Desert Rose demo centres |
| `apps/customer-web/scripts/shots.mjs` | 41 | Customer portal, signed in: requests in every state, documents tab, rejected-document replacement, quotations, unpaid invoices, appointments, account menu; `flow-*` scenarios register a customer, create a request, fix documents and pay, decline / cancel, book an appointment, open a ticket, manage documents, profile and security |
| `apps/corporate-portal/scripts/shots.mjs` | 60 | Corporate portal, signed in as a company administrator and as an employee: employee directory and detail, requests (external, ready, completed), approvals, invoices (unpaid, paid), navigation, suspended account; `flow-*` scenarios add employees, invite an employee login, create a request, decide approvals, pay, open a ticket, notifications, company settings, renewals, documents, rating |
| `apps/platform-admin/scripts/shots.mjs` | 50 | Platform console: tenants (overview, billing, access, audit, suspend, flags, agent view), support tickets, access requests, integrations and providers review; `flow-*` scenarios create a centre, bill it, suspend and close it, coupons, plans, tickets, access grants (request, revoke, enter), feature flags, settings, staff, incidents, processor register |

Pictures kept from the last run are in `docs/brand/screenshots/` (`docs/TEST_REPORT.md` section 2.7 has the
counts). Not covered by any of this: the Flutter app, real mobile browsers, accessibility tooling, and any
regression since the last manual run.

## Prerequisites to run the scenario files

1. PostgreSQL and Redis running, the API started and the demo data seeded
   (`pnpm db:seed --env-file=.env`, then `node scripts/dev-quickstart.mjs` prints the credentials;
   `docs/DEMO_ENVIRONMENT.md`). The flows write data: use a demo database only.
2. The app under test running on its port (`pnpm dev:centre` 3001, `dev:customer` 3002, `dev:corporate`
   3003, `dev:admin` 3004), or `next start` of a production build.
3. Playwright's Chromium installed: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` on the authoring machine;
   elsewhere `pnpm --filter @typease/tests exec playwright install chromium`.
4. Then, from the repository root, for example
   `node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-cases.mjs --out /tmp/shots-cases [--only flow-wizard]`.
   Flows run in file order and depend on each other; read the header of each file first.

## How to turn them into Playwright tests

1. Create `tests/e2e/playwright.config.ts` (`@playwright/test` 1.56.1 is already a dev dependency of
   `tests/package.json`; `eslint.config.mjs` already has a block for `tests/e2e/**/*.ts`). Give it a
   `webServer` entry per app (or point `baseURL` at running servers), the three projects that mirror the
   screenshot variants (desktop 1440x900, phone 390x844 with `isMobile`, and an Arabic dark project: locale
   `ar-AE`, cookie `te_locale=ar`, `localStorage.te_theme=dark`, `colorScheme: 'dark'`, exactly as the runner
   does in its `newContext` call), `timezoneId: 'Asia/Dubai'`, `fullyParallel: false` for the flows, and a global setup that checks
   the API is up and the demo seed is present (`scripts/seed-verify.mjs` does that read-only).
2. Add `e2e/**/*.ts` to `tests/tsconfig.json` `include` (today only `support/`, `integration/` and
   `security/` are type-checked) and restore `test:e2e` in `tests/package.json` to
   `playwright test --config e2e/playwright.config.ts`.
3. Port scenario by scenario. A scenario object `{ name, path, as, signInPath, tenant, ready, prepare, act,
   variants }` maps directly: `as` / `signInPath` become a fixture that signs in through the real form
   (or a stored `storageState` per demo account), `ready` becomes `await expect(page.locator(ready)).toBeVisible()`,
   `act` becomes the test body, and every `check(cond, msg)` becomes an `expect(...)`. Replace "a picture was
   taken" with assertions on what the picture was meant to show (a validation message, a row, a status
   badge, a disabled button, the Arabic direction `dir="rtl"`); keep `toHaveScreenshot()` only where layout
   itself is the subject.
4. Keep the flows' data discipline: use the Gulf Star / Desert Rose centres and self-created records as the
   files do, never Al Noor's seeded staff; give each flow a `test.describe.serial` block in the file's order,
   because they hand ids to each other through `state`; let the API set up the money part as the files do.
5. Do the staff app's `shots-foundation.mjs` first (it already asserts), then the `flow-*` chains of
   `shots-cases.mjs`, the customer and corporate portals, and the platform console; the corporate portal has
   had the least checking (`docs/KNOWN_LIMITATIONS.md` section 5.6).
6. Wire the suite into `.github/workflows/ci.yml` after the `api-tests` job, with the demo seed as a step
   and the Playwright HTML report (`playwright-report/`, already in `.gitignore`) as an artefact, and update
   `docs/TESTING.md` section 1 (level 4) and `docs/KNOWN_LIMITATIONS.md` sections 2 and 7 when the suite
   exists and has a recorded run.
