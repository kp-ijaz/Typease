# App-builder rules (one engineer owns one web app; other engineers work elsewhere in the same tree)

You own ONE of the TypEase web apps and finish all of its remaining screens. Other engineers are working at
the same time in the same working tree (`/home/claude/typease`) on OTHER apps, on the API and on the docs.
The design system, the app shell of your app, authentication, the API client and a few reference pages exist
and are good. Your screens must look and behave like the reference pages.

## Read first (in this order)
1. `docs/architecture/FRONTEND_CONVENTIONS.md` - binding. How to build a list, a form, a detail page and a
   wizard with the shared components; i18n / RTL / permission / formatting rules; how the portals resolve the
   centre.
2. `docs/architecture/PAGE_BUILDER_RULES.md` - read the sections "Quality bar" and "Checking your work"; they
   apply to you unchanged (replace `centre-web` by your app). The file-ownership part of that document does
   NOT apply to you: see "Files" below.
3. The pages already built in YOUR app (listed in your assignment) and its shell / nav / dictionaries.
4. The finished staff app `apps/centre-web` is your pattern library: `app/(app)/customers/page.tsx` (list +
   dialog form), `app/(app)/requests/page.tsx` (filters), `app/(app)/requests/[id]/` (detail with tabs,
   timeline, documents, messages), `app/(app)/invoices/[id]/`, `app/(app)/support/`, `components/**`.
   Read the staff screen that corresponds to the one you are building before you write yours - then write
   the simpler, role-appropriate version for your audience. Copying small helpers into your app is fine.
5. LOOK at these pictures with your image-capable Read tool: `docs/brand/typease-brand-reference.png`,
   `docs/brand/screenshots/centre-dashboard-en-light-desktop.png`,
   `centre-customers-add-validation-ar-dark-desktop.png`, `centre-requests-en-light-mobile.png`,
   `centre-components-en-light-desktop.png`, and the screenshots of your own app that already exist in
   `docs/brand/screenshots/` (`ls docs/brand/screenshots | grep <your app>`).
6. `packages/ui/src/index.ts` and the component files you will use (read their props before using them);
   `packages/api-client/src/index.ts`.
7. The API: `docs/api/ENDPOINTS.md` (every route with its access rule) and the `docs/api/modules/*.md` files
   named in your assignment. Entities: `packages/types/src/generated/models.ts`, `packages/types/src/*.ts`.
   Request schemas: `packages/validation/src/*.ts` (use the SAME Zod schemas in forms via `zodResolver`).
8. `docs/brand/MASTER_PROMPT.md`: sections 2 and 36 plus the sections named in your assignment.

## The running environment
- API: http://localhost:4000/api/v1 (Swagger UI at /api/docs), seeded with three fictional centres. Logins:
  `docs/DEMO_ENVIRONMENT.md`; every password is `TypEase-Demo-2026`. `EXPOSE_DEV_TOKENS=true` (verification /
  invitation / OTP tokens come back in a `dev` field) and `PAYMENT_SANDBOX_ENABLED=true` (online payments can
  be completed with the sandbox provider).
- BEFORE writing a screen, call every endpoint it uses with curl and look at the real JSON. Sign in with
  `POST /api/v1/auth/login` (`{"email":..,"password":..,"app":"<customer|corporate|platform>"}` plus
  `"tenantSlug":"al-noor"` for the portals - check `packages/validation/src/auth.ts` for the exact body) and
  use `accessToken` as Bearer token. Never guess a response shape.
- A Next.js dev server for YOUR app is already running (hot reload) on the port given in your assignment. It
  is supervised: it restarts by itself when it uses too much memory, so a request may fail for ~20 seconds
  now and then - wait and retry. Do not start, stop or restart any server; never run `next build`. If your
  server stays down for more than two minutes, look at its log file (named in your assignment) and report.
- Do not reset or reseed the database. Creating records through the UI / API while testing is fine. Do not
  change demo passwords, disable demo users, suspend demo centres or leave them in a broken state. If you
  change something to test (a setting, a plan, a flag), put it back.
- Shared machine (2 cores, 8 GB, several engineers). ONE heavy command at a time, nothing in the background.
  Type-check sparingly (a handful of times in total):

  ```bash
  cd /home/claude/typease/apps/<your-app>
  NODE_OPTIONS=--max-old-space-size=1536 pnpm exec tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile /tmp/tsbuild-<your-app>.json 2>&1 | grep -E "error TS" | head -40
  ```

  If a command is killed (exit 137 = out of memory), wait a minute and run it again.
- No new npm dependencies; never run `pnpm install`.

## Files
- You may create / edit everything inside `apps/<your-app>/` (routes, components, `lib/**`, dictionaries,
  nav, query keys, `scripts/shots.mjs`).
- Strings: every user-visible string goes through `t()` with English AND proper Arabic in your app's
  dictionaries (identical keys). Shared strings (`common.*`, `status.*`, table / form / validation messages)
  already exist in `packages/ui/src/i18n/dictionaries/` - use them instead of duplicating.
- A page that currently renders `<SectionMarker>` (comment `// TEMPORARY MARKER`) is replaced completely.
  When none is left, delete `components/section-marker.tsx`.
- `packages/**`, `services/**`, `database/**`, other apps: do NOT edit. Two narrow exceptions:
  1. A genuine defect in a `packages/ui` or `packages/api-client` file that blocks you may be fixed with a
     minimal, backwards-compatible change (other apps use the same code and are being edited right now).
     Then run `pnpm --filter @typease/ui test` (or `@typease/api-client`) and list the change in your report.
  2. If the API lacks something your screens truly need, do NOT work around it with fake data and do NOT
     edit the API: build the screen against what exists, and describe the gap precisely in your report
     (endpoint, what is missing, which screen is affected).

## Definition of done
1. No `TEMPORARY MARKER` left in your app. Every route in your assignment works against the real API for the
   demo accounts named there: loading, empty, error states; forms with field errors; real actions.
2. Zero TypeScript errors in your app (command above).
3. `cd /home/claude/typease && pnpm --filter @typease/ui exec vitest run src/i18n` passes for your app's keys.
4. You have SEEN every screen: scenarios in `apps/<your-app>/scripts/shots.mjs`, run with

   ```bash
   cd /home/claude/typease && export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
   node packages/ui/scripts/screenshots.mjs --app <customer|corporate|platform> --scenarios apps/<your-app>/scripts/shots.mjs --out /tmp/shots-<your-app>
   ```

   in English desktop, Arabic dark desktop and English phone, with zero console errors, hydration mismatches
   and horizontal overflow reported by the script, and each important flow driven for real with `act` steps
   at least once (open, fill, submit, see the result). Copy a handful of your best final screenshots to
   `docs/brand/screenshots/` (file names start with your app name).
5. Final report (concise, precise, honest): routes built with the endpoints each uses; what you drove end to
   end in the browser; what you only type-checked; API gaps; shared-package changes; anything not done or
   not verified. An accurate "X is not done" is far more useful than a rosy summary.
