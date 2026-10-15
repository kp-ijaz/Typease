# Page-builder rules (several engineers build pages in the same app at the same time)

You are one of several frontend engineers filling in the remaining screens of the TypEase web apps IN PARALLEL,
in the same working tree (`/home/claude/typease`). The design system, app shells, authentication, the API client
and reference pages exist and are good. Your screens must look and behave like the reference pages: same
components, same patterns, same tone. Read and follow these rules exactly.

## Read first (in this order)
1. `docs/architecture/FRONTEND_CONVENTIONS.md` - binding. It shows how to build a list, a form, a detail page
   and a wizard with the shared components, and the i18n / RTL / permission / formatting rules.
2. The reference implementations in `apps/centre-web`: `app/(app)/customers/page.tsx` (list + dialog form),
   `app/(app)/requests/page.tsx` (list with filters), `app/(app)/dashboard/page.tsx`, `components/pickers.tsx`
   (CustomerPicker, ServicePicker, StaffPicker, CorporateAccountPicker, DocumentTypePicker, RoleSelect -
   use them, do not write your own), `components/branch.tsx`, `lib/query-keys.ts`.
3. LOOK at these pictures with your image-capable Read tool to absorb the visual language:
   `docs/brand/screenshots/centre-dashboard-en-light-desktop.png`, `centre-customers-en-light-desktop.png`,
   `centre-customers-add-validation-ar-dark-desktop.png`, `centre-requests-en-light-mobile.png`,
   `centre-components-en-light-desktop.png` (every component in its states).
4. `packages/ui/src/index.ts` and the component files you will use (read their props before using them).
5. The API you will call: `docs/api/ENDPOINTS.md` (576 endpoints with access rules) and the
   `docs/api/modules/*.md` files named in your assignment. Types: `packages/types/src/generated/models.ts`
   (entities), `packages/types/src/*.ts`; request schemas: `packages/validation/src/*.ts` (use the SAME Zod
   schemas in your forms via `zodResolver`).
6. Product rules for the screens: sections 2 and 36 of `docs/brand/MASTER_PROMPT.md`, plus the spec sections
   named in your assignment.

## The running environment
- API: http://localhost:4000/api/v1 (Swagger at /api/docs), database seeded with three fictional centres.
  Logins are listed in `docs/DEMO_ENVIRONMENT.md`; every password is `TypEase-Demo-2026`. Main ones:
  `owner@al-noor.test` (Business plan, white label, 2 branches, lots of data), `reception.dubai@al-noor.test`,
  `operator1@al-noor.test`, `reviewer@al-noor.test`, `accountant@al-noor.test`, `manager@al-noor.test`,
  `owner@gulf-star.test` (Professional), `owner@desert-rose.test` (Starter, trial), customers such as
  `aisha.rahman@example.test` (customer portal, centre `al-noor`), corporate admin `admin@falcon-demo.test`,
  platform `admin@typease.test`.
- BEFORE writing a screen, call every endpoint it uses with curl and look at the real JSON (sign in with
  `POST /api/v1/auth/login {"email":..,"password":..,"app":"centre"}` and use `accessToken` as Bearer token).
  Model your TypeScript types on the real responses (reuse `@typease/types` entities; extend locally for
  joined fields). Never guess a response shape.
- A shared Next.js dev server for `apps/centre-web` is ALREADY RUNNING on http://localhost:3001 (hot reload).
  Do not start, stop or restart any server, and never run `next build`. If the dev server is down, report it.
- Do not reset or reseed the database. Creating records through the UI / API while testing is fine. Do not
  change demo passwords, disable demo users, or leave the demo centres in a broken state (e.g. if you change
  Al Noor's branding or a setting to test, put it back).
- Shared machine (2 cores, 8 GB). One heavy command at a time. Type-check sparingly:

  ```bash
  cd /home/claude/typease/apps/centre-web
  NODE_OPTIONS=--max-old-space-size=1536 pnpm exec tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile /tmp/tsbuild-<your-section>.json 2>&1 | grep -E "<your paths regex>|error TS" | head -40
  ```

  Other engineers' files may have errors while they work: only YOUR files must be clean at the end. If a
  command is killed (exit 137 = out of memory), wait a minute and run it again.
- No new npm dependencies; never run `pnpm install`.

## Files
You may create / edit ONLY the paths listed in your assignment. In particular:
- NEVER edit `lib/dictionaries/en.ts`, `ar.ts`, `lib/nav.ts`, `lib/query-keys.ts`, `components/pickers.tsx`,
  `components/branch.tsx`, anything in `packages/**`, or another engineer's routes / components.
- Your strings go in YOUR section dictionary `lib/dictionaries/sections/<section>.ts` (English and Arabic
  objects with identical keys; proper Arabic). Keys are used as `t('<section>.area.key')`.
  Shared strings (`common.*`, `status.*`, table / form / validation messages) already exist in
  `packages/ui/src/i18n/dictionaries/en.ts` - use them instead of duplicating.
- Your query keys go in `lib/keys/<section>.ts`; your components in `components/<section>/`.
- A page that currently renders `<SectionMarker>` (comment `// TEMPORARY MARKER`) is replaced completely.
- If you need something from a shared file (a nav entry, a new prop on a shared component, a missing export),
  do not edit it: work without it and list the wish in your final report.

## Cross-section links (URL contract - other engineers build the targets)
`/requests/:id` · `/requests/new?customerId=&serviceId=&corporateAccountId=` · `/customers/:id` ·
`/corporate/:id` · `/documents/:id` · `/documents?customerId=&requestId=` · `/quotations/:id` ·
`/quotations/new?requestId=&customerId=` · `/invoices/:id` · `/invoices/new?customerId=&requestId=` ·
`/payments/:id` · `/payments/new?invoiceId=&customerId=` · `/refunds/:id` · `/refunds/new?paymentId=` ·
`/tasks?requestId=` · `/appointments?customerId=` · `/support/:id` · `/support/platform/:id` ·
`/reminders?customerId=` · `/reports/:key` · `/reports/scheduled/:id` · `/automations/:id` ·
`/automations/executions/:id` · `/services/:id` · `/workflows/:id` · `/staff/:id` · `/subscription` ·
`/settings` · `/audit-log?resourceType=&resourceId=`.
Link to these freely (plain `<Link>`); do not embed another section's forms.

## Quality bar (spec section 36)
- One clear primary action per screen; simple headings; familiar words (a receptionist must understand it).
- Show only relevant fields; step-by-step forms for complex input; say what happens next.
- Loading skeletons, empty states with a helpful next action, error states with retry.
- Success and failure toasts with the API's own message; field errors mapped onto the form; input is
  preserved on recoverable errors; destructive actions use `ConfirmDialog`.
- Every button does something real through the API. No placeholders, no "coming soon", no static arrays.
- Actions the signed-in role may not perform are hidden (`PermissionGate` / `useSession().hasPermission`);
  the API enforces them anyway - handle 403 gracefully.
- Money is shown with `formatMoney` from decimal strings (never parseFloat for arithmetic); dates with the
  i18n formatters; identity numbers stay masked unless the screen is the explicit "reveal" action.
- Everything in English AND Arabic, correct in RTL, usable at 390 px width, keyboard accessible.
- External (authority / partner) statuses are always shown together with their source label
  (`STATUS_SOURCE_LABEL`): never present a staff-entered status as an official one.

## Checking your work (mandatory before you report)
1. Type-check (command above): zero errors in your files.
2. `cd /home/claude/typease && pnpm --filter @typease/ui exec vitest run src/i18n` must pass (it checks that
   every key you use exists in both languages, across all apps; failures caused by other sections' keys are
   not yours - say so).
3. SEE your screens. Write your scenarios in `apps/centre-web/scripts/shots-<section>.mjs` (default export:
   an array; the scenario shape is documented at the top of `packages/ui/scripts/screenshots.mjs`) and run:

   ```bash
   cd /home/claude/typease && export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
   node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-<section>.mjs --out /tmp/shots-<section>
   ```

   The script reports console errors, hydration mismatches and horizontal overflow. Open the PNGs with your
   Read tool and look at them critically: English desktop, Arabic dark desktop, English phone. Fix what is
   wrong and repeat. Use `act` steps to drive each important flow at least once for real (open the dialog,
   fill the form, submit, see the result) - a screen you have not seen working is not done.
   Copy your best final screenshots (a handful, not all) to `docs/brand/screenshots/`.
4. Final report: routes built (with the endpoints each uses), what you drove end to end in the browser, what
   you only type-checked, known gaps, wishes for shared files. Precise and honest: say plainly what is not
   done or not verified.
