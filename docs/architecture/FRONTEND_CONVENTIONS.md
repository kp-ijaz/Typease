# Frontend conventions

For everyone who builds pages in the four TypEase web apps. Read this before writing a page; it is short on
purpose. The two reference implementations are real files you can open next to it:

- list page: `apps/centre-web/app/(app)/requests/requests-list.tsx`
- form: `apps/centre-web/components/add-customer-dialog.tsx` (reusable: `<AddCustomerDialog open onOpenChange onCreated />`;
  `/customers?add=1` opens it on the customers list)

Everything shared is visible, in every state, in the component gallery: start the staff app and open
`/dev/components` (available in development, and in a production build only with `ENABLE_DEV_GALLERY=true`).

## 1. What lives where

```
packages/
  branding/     colour tokens, logo components + static SVGs, brandingToCssVars() for white-label centres
  ui/           design system: Tailwind preset, components, providers, shell, auth screens, i18n
    src/components/   Button, Input, Select, Dialog, Table ... one file per family
    src/data-table/   DataTable (server-driven lists)
    src/shell/        AppShell, RequireAuth, PermissionGate helpers, error / not-found / skeleton screens
    src/auth/         sign-in, MFA, password, invitation, sessions: used by all four apps
    src/i18n/         dictionaries (en, ar), provider, plural rules
    src/lib/          format (dates, money, numbers), phone, countries, status-meta, tenant resolution
    src/index.ts      client entry        src/server.ts   server-safe entry (layouts, middleware)
  api-client/   createApiClient, session manager (token refresh), typed endpoint groups, document upload
  config/       shared Next config factory, security headers / CSP, PostCSS, base tsconfig
apps/
  centre-web/        staff app            :3001   one centre per session, white-label after sign-in
  customer-web/      customer portal      :3002   one centre per host / ?tenant=
  corporate-portal/  company portal       :3003   one centre per host / ?tenant=
  platform-admin/    TypEase console      :3004   always TypEase-branded
```

Inside an app:

```
app/(auth)/...        signed-out screens          app/(app)/... or (account)/...   signed-in screens
app/<route>/page.tsx  server file: metadata + the client component, nothing else
app/<route>/<name>.tsx  'use client' component with the page's logic
lib/config.ts         the ONLY place that reads process.env
lib/nav.ts            navigation as data            lib/query-keys.ts   TanStack Query keys
lib/dictionaries/     en.ts + ar.ts of this app     components/         shells and app-wide pieces
```

Rules that keep this tidy:

- Apps import from `@typease/ui`, `@typease/api-client`, `@typease/types`, `@typease/validation`,
  `@typease/permissions`. Server files (layouts, `page.tsx`, middleware) import from `@typease/ui/server`.
- A component used by two apps moves to `packages/ui`. A component used by one page stays beside that page.
- No hex colours, no `text-gray-500`, no pixel font sizes in pages: use the semantic classes of the preset
  (`bg-card`, `text-muted-foreground`, `border`, `bg-primary`, `text-destructive-text`, `bg-success-soft` ...).
  That is what makes dark mode and white-label work without anybody thinking about them.
- `process.env` is read in `lib/config.ts` only. Client components get the API URL through `<AppProviders>`.
- No `next/font/google`, no CDN: fonts are self-hosted (`@fontsource`), the build must work offline.

## 2. Adding a page

A route is two files. The server file sets the title; the client file does the work.

```tsx
// app/(app)/invoices/page.tsx
import { pageTitle } from '@/lib/metadata';
import { InvoicesList } from './invoices-list';

export const generateMetadata = () => pageTitle('invoices.title');

export default function Page() {
  return <InvoicesList />;
}
```

Then: add the strings to `lib/dictionaries/en.ts` AND `ar.ts`, add the route to `lib/nav.ts` if it belongs in
the navigation (with the permissions that may see it), and add its query keys to `lib/query-keys.ts`.

Every page starts with `<PageHeader title description action />`. A page has ONE primary action; it goes in
`action`. Secondary actions go in `secondary`.

### Buttons: which variant

| Variant | Use |
| --- | --- |
| `accent` | the page's one "start something" action: New request, Add customer, Create account |
| `default` | confirm what is on screen: Save, Continue, Sign in, Add (inside a dialog) |
| `outline` | the alternative next to a primary button: Cancel, Back, Export |
| `subtle`, `ghost` | row-level and toolbar actions |
| `link` | navigation that reads as text: View all |
| `destructive`, `destructive-outline` | delete, cancel a request, revoke. Always behind `<ConfirmDialog>` |

A button that waits for the server shows it: `<Button loading={mutation.isPending} loadingText={t('common.saving')}>`.

## 3. A list page

Use `<DataTable>` for every list that comes from a `{ data, meta }` endpoint. It owns search, filters, sorting,
paging, the URL state, the skeleton, the empty and error states, and the stacked cards on phones. This is the
whole body of the requests page:

```tsx
<PageHeader title={t('requests.title')} description={t('requests.description')} action={newRequest} />
<DataTable<RequestListItem>
  caption={t('requests.title')}
  queryKey={keys.requests.all}
  queryFn={(params, signal) => api.requests.list(params, signal)}
  columns={columns}
  rowKey={(r) => r.id}
  rowHref={(r) => `/requests/${r.id}`}
  rowActions={rowActions}
  filters={filters}
  searchPlaceholder={t('requests.searchPlaceholder')}
  defaultSort="createdAt:desc"
  empty={{ icon: <ClipboardList />, title: t('requests.emptyTitle'), description: t('requests.emptyText'), action: newRequest }}
/>
```

Columns are data. `sortField` is the API's sort field; `mobile` says where the column goes in the phone card
(`title`, `badge`, `field` (default), `hidden`):

```tsx
{ id: 'number', header: t('requests.columns.number'), sortField: 'requestNo', mobile: 'title',
  className: 'whitespace-nowrap', cell: (r) => <span className="tabular">{r.requestNo}</span> },
{ id: 'status', header: t('requests.columns.status'), mobile: 'badge',
  cell: (r) => <StatusBadge kind="request" status={r.status} label={r.statusLabel} /> },
```

Filters are data too: `{ id: 'priority', type: 'select', label, options }` or
`{ id: 'created', type: 'dateRange', label, fromKey: 'createdFrom', toKey: 'createdTo' }`.

- Return `null` from `cell` when there is no value. The table shows a dash; the phone card leaves an empty
  badge out. Do not write the dash yourself.
- Statuses are always `<StatusBadge kind=... status=...>`. Never colour a status by hand: labels and tones come
  from `packages/ui/src/lib/status-meta.ts` (requests from `REQUEST_STATUS_META` in `@typease/types`).
- A list inside a card (dashboard): `bare`, `pagination={false}`, `searchable={false}`, `syncUrl={false}`.

## 4. A form

React Hook Form with the SHARED Zod schema from `@typease/validation`, so the browser and the API apply the
same rules. `useZodForm` turns empty strings into "no value" (the schemas reject `""` for optional fields).

```tsx
const schema = customerSchema.pick({ type: true, fullName: true, phone: true, email: true });
const form = useZodForm(schema, { defaultValues: { type: 'INDIVIDUAL', fullName: '', phone: '', email: '' } });

<Form form={form} onSubmit={(values) => save(values)}>
  <FormField name="fullName" label={t('customers.form.fullName')} required hint={t('customers.form.fullNameHint')}>
    {(field) => <Input {...field} autoComplete="off" />}
  </FormField>
  <FormField name="phone" label={t('customers.form.phone')}>
    {(field) => <PhoneInput {...field} />}
  </FormField>
  <FormError />
  <FormActions>
    <Button variant="outline" onClick={close}>{t('common.cancel')}</Button>
    <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>{t('common.save')}</Button>
  </FormActions>
</Form>
```

What `<Form>` does for you, and what you must not undo:

- `onSubmit` may throw. An `ApiError` with field details (`VALIDATION_FAILED`, `FORM_INVALID`) is put on the
  fields; anything else appears in `<FormError />` above the buttons. What the person typed stays.
- Validation messages are translated (`validation.*` in the shared dictionary); the first invalid field gets focus.
- A business rule with its own answer is caught BEFORE it reaches `<Form>` and explained in place, as the
  duplicate check does:

```tsx
} catch (error) {
  if (isApiError(error) && error.code === 'POSSIBLE_DUPLICATE') {
    setDuplicates((error.details as { candidates?: DuplicateCandidate[] } | undefined)?.candidates ?? []);
    return;
  }
  throw error;
}
```

- After success: toast, invalidate the resource's queries, close or navigate.

```tsx
toasts.success(t('customers.form.added'), t('customers.form.addedDescription', { name, number }));
await queryClient.invalidateQueries({ queryKey: keys.customers.all });
onOpenChange(false);
```

Field choices: `Select` for up to about ten options, `Combobox` (searchable, optional server search) for more,
`CountrySelect` for nationality, `PhoneInput` for phones (stores E.164), `MoneyInput` for amounts (stores a
decimal STRING, never a number), `DatePicker` for dates (stores `YYYY-MM-DD`). Ask for as few fields as the
task needs; mark the optional ones with `optional`, the required ones with `required`.

## 5. A detail page

`PageHeader` with `breadcrumbs` (the trail without the page itself) and `meta` (the status badge), then cards.
Label / value pairs are `<DescriptionList items columns />` (empty values show a dash). History is `<Timeline>`.
Sections that are large or rarely needed go under `<Tabs>`, and the active tab belongs in the URL
(`?tab=documents`) so a link opens the right one. Load with `useQuery`; while loading render skeletons of the
same shape, on error an `<Alert tone="danger">` with a "Try again" button (see section 10).

## 6. A wizard

`<Stepper steps current />` on top, one `useZodForm` per step (each with its own slice of the schema), the
answers kept in the parent. Rules: Back never loses input; the request is saved as a draft on the server as
soon as there is something to save, so a reload or a phone call does not cost the customer their work; the
last step is a review of everything before the one irreversible action. The step is in the URL (`?step=3`).

## 7. Data fetching

- TanStack Query everywhere; no `useEffect` + `fetch`. Get the typed endpoints with `const api = useApi()`.
  Adding an endpoint is one line in `packages/api-client/src/endpoints/<group>.ts`.
- Query keys live in `lib/query-keys.ts` and start with the resource name: `keys.requests.all = ['requests']`,
  `keys.requests.counts(branchId) = ['requests', 'counts', branchId]`. Invalidate by the resource prefix after
  a mutation: `invalidateQueries({ queryKey: keys.requests.all })` refreshes every list, count and detail of it.
  Invalidate neighbours the mutation touches too (a payment changes invoices AND the request).
- Optimistic updates: NOT for money, status transitions, documents or anything with a server-side rule. Wait
  for the answer and show progress on the button. Allowed only for cheap, reversible toggles (mark a
  notification read, pin, reorder), with rollback in `onError`.
- Errors: a failed READ is shown where the data would be (`<Alert tone="danger">` with retry; DataTable does it
  itself). A failed WRITE inside a form goes through `<Form>`; outside a form use `toasts.error(error)`.
  `useErrorMessage()` gives the sentence for any caught error. Never show `error.message` of an unknown
  error, a status code or a stack trace.
- Payments and refunds require an `Idempotency-Key`. Create it once per user intent, not per attempt, and pass
  it as a request option: `client.post(path, body, { idempotencyKey })` with `newIdempotencyKey()` from
  `@typease/api-client` kept in a ref for the life of the dialog, so a retry after a timeout cannot charge twice.
- Sessions: the access token lives in memory only; the refresh cookie is HttpOnly. `useSession()` gives the
  user, centre, permissions and `signOut`. Never read or store tokens yourself, and never call `fetch` directly:
  the client handles refresh, retry-once on 401 and cross-tab coordination.

## 8. Languages

- Every visible string comes from a dictionary: `const { t, tn, pick } = useI18n()`.
  `t('requests.title')`, `t('dashboard.greeting', { name })`, `tn('table.results', count)` for plurals,
  `pick(row.name, row.nameAr)` for data that has both languages.
- A key added to `en.ts` must be added to `ar.ts` in the same change. `packages/ui/src/i18n/apps.test.ts`
  fails otherwise, and also when a key used in the code is missing or a placeholder differs.
- Arabic plurals have six forms (`zero, one, two, few, many, other`); English has two (`one, other`).
- No string concatenation to build sentences, no English words left inside Arabic text. Names of people,
  companies and services are data and are shown as stored.
- Write for the person at the counter: plain verbs, sentence case, say what happens next. An action keeps one
  name through the whole flow (the button says "Add customer", the toast says "Customer added").

## 9. Right-to-left

- Use logical utilities only: `ms-* me-* ps-* pe-* start-* end-* text-start text-end border-s rounded-e-*`.
  Never `ml- mr- pl- pr- left- right- text-left text-right`.
- Icons that point (chevrons, arrows) get `rtl-mirror`. Icons that do not point are left alone.
- Values that are always written left to right (phone numbers, emails, IDs, request numbers, file sizes) get
  `ltr-value`; inputs for them get `dir="ltr"`. Numbers in tables get `tabular`.
- Text in ONE language shown in the other direction (a centre's tagline, a service description) goes inside
  `<bdi>` or gets `dir="auto"`, or its punctuation jumps to the wrong side.
- Do not set letter-spacing on text; Arabic is connected script (the base stylesheet resets it for `[lang=ar]`).
- Check every new screen in Arabic. It takes one command (section 13).

## 10. Loading, empty, error (spec section 36)

| State | What to show |
| --- | --- |
| First load of a page or card | a skeleton of the same shape (`<Skeleton>`, `<PageSkeleton>`), never a blank area or a centred spinner on a full page |
| Waiting after an action | the button that was pressed: `loading`; the rest of the form stays readable |
| Nothing there yet | `<EmptyState icon title description action>`: say what will appear here and offer the action that fills it |
| Nothing matches the filters | DataTable's own "no results" state with "Clear filters" |
| Could not load | `<Alert tone="danger" action={Try again}>` where the data would be; the page around it stays usable |
| Could not save | the message next to the fields or above the buttons; input is preserved |
| Saved | a toast that names what happened, with the number or name when there is one |
| Destructive or irreversible | `<ConfirmDialog>`; `typedConfirmation` for the ones that cannot be undone |
| Not allowed | the control is not rendered (`<PermissionGate>`); a page reached by URL explains it |
| Session ended | handled by `<RequireAuth>`: says so and returns to the same page after sign-in |

Route files every app already has and you should not duplicate: `error.tsx`, `global-error.tsx`,
`not-found.tsx`, `loading.tsx`.

## 11. Permissions

- Navigation: `anyOf: ['invoice.read']` on the item in `lib/nav.ts`; the shell hides what a role cannot use.
- Inside a page: `<PermissionGate permission="request.create">...</PermissionGate>` (or `anyOf={[...]}`), and
  `useSession().hasPermission('refund.approve')` when logic depends on it.
- A whole route: `<RequirePermission anyOf={[...]}>` around the page component.
- These only hide things. The API checks every permission again; never rely on the UI for security, and never
  send a request "just to see" whether it is allowed.
- Permission keys come from `packages/permissions`. Do not invent keys in the frontend.

## 12. Money, dates, numbers, phones

- Money is a decimal STRING from the API (`"1250.50"`). Display with `formatMoney(amount, currency)` from
  `useI18n()`. Do not `parseFloat` and add amounts in the browser: totals come from the API. To compare with
  zero, `Number(x) === 0` is fine.
- Dates: `formatDate`, `formatDateTime`, `formatRelative` from `useI18n()`; they use the centre's time zone and
  the active language. Never `toLocaleDateString()` and never `new Date().toISOString().slice(0, 10)` for
  "today" (use `todayInTimeZone`).
- Numbers: `formatNumber`. File sizes: `formatFileSize`. Phones: `formatPhone`.
- Hydration hazard: `Intl` data differs between Node and browsers. Anything built from `Intl.DisplayNames` or
  locale-dependent sorting must be computed after mount, not during server render (see `PhoneInput`).
  Fixed formats through the helpers above are safe.

## 13. Files

- Upload: `<FileUpload upload={(file, o) => uploadDocument(client, { file, requestId, documentTypeKey: 'passport', ...o })} />`
  with `const client = useApiClient()`. `uploadDocument` runs the three API steps (create upload, send the
  bytes, confirm) and reports progress; the component shows progress, per-file errors, retry and remove.
  `capture="environment"` adds "Take a photo" on phones.
- View: `<FileViewer open onOpenChange getSource={() => documentPreviewLink(client, id)} />`. Signed URLs live
  for minutes: `getSource` is called every time the viewer opens; never keep such a URL in state or in a query cache.
- Download: `client.download(path)` + `saveBlob`, or `documentDownloadLink`. Never build storage URLs by hand.
- Identity numbers arrive masked from the API. Do not try to unmask them in the browser.

## 14. Accessibility checklist

Before a page is done:

- [ ] Everything works with the keyboard alone; focus is visible; focus goes into a dialog and back to its trigger.
- [ ] One `h1` (the PageHeader), headings in order, landmarks from the shell untouched.
- [ ] Every input has a visible label (`FormField`); icon-only buttons have `aria-label`; decorative icons `aria-hidden`.
- [ ] Errors are text next to the field, not colour alone; status is a word, not a colour alone.
- [ ] Tables have a `caption`; DataTable provides it from the `caption` prop.
- [ ] Touch targets are at least 40 px; nothing scrolls sideways at 390 px width.
- [ ] Works in dark mode and in Arabic; text contrast holds (use the token pairs: `bg-x` with `text-x-foreground`).
- [ ] Motion only answers an action; `prefers-reduced-motion` is respected by the shared components.

## 15. Checking your work

```bash
pnpm --filter @typease/ui test            # components, i18n completeness for ui AND the four apps
pnpm --filter @typease/centre-web typecheck
pnpm dev:centre                           # dev:customer, dev:corporate, dev:admin
node scripts/dev-quickstart.mjs           # creates two demo centres and prints their accounts (idempotent)
```

Screenshots in the combinations a screen has to be checked in (English light desktop, Arabic dark desktop,
English phone), against the running app and API:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers      # where Chromium is installed on this machine
node packages/ui/scripts/screenshots.mjs --app centre --only dashboard,requests --out /tmp/shots
```

Add a scenario for your page in `SCENARIOS` of that script (path, who is signed in, what must be visible,
optional steps such as opening a dialog). The script reports console errors, hydration mismatches and
horizontal overflow for every picture; it waits for `html[data-hydrated]`, which `<AppProviders>` sets once
React has taken over. The committed set is in `docs/brand/screenshots/`. LOOK at the pictures: a screenshot
that was taken is not a screen that works.

Builds are heavy on a small machine: build one app at a time
(`NODE_OPTIONS=--max-old-space-size=2048 pnpm --filter @typease/centre-web build`).

## 16. Tenants, branding and the first response

- `customer-web` and `corporate-portal` resolve the centre on the server for every request, in this order:
  the host (a centre's own domain or `<slug>.<platform domain>`), `?tenant=<slug>` (links in emails; remembered
  in the `te_tenant` cookie), the cookie, `NEXT_PUBLIC_DEFAULT_TENANT_SLUG`. See `lib/tenant.ts`. The root
  layout inlines the centre's colours (`<BrandStyle>`), so a white-label domain never flashes TypEase colours.
- On a centre's own domain the browser talks to the API through the app's origin (`/api/v1/*` rewrite) so the
  session cookie is first-party. Pages do not need to know: `useApi()` already points at the right base URL.
- `centre-web` shows the centre's brand after sign-in (and remembers it for the next full load).
  `platform-admin` is always TypEase.
- Use `useBranding()` for the centre's name and config and `<BrandLogo>` for its logo. Never hard-code
  "TypEase" in a portal page.
- Links the API writes into emails use these paths; keep them working when you build the real pages:
  customer portal `/requests/:id`, `/requests/new`, `/quotations/:id`, `/invoices/:id`, `/payments`,
  `/payments/return`, `/appointments`, `/support/:id`, `/verify-email`, `/reset-password`, `/accept-invitation`;
  staff app `/verify-email`, `/accept-invitation`, `/settings/subscription?invoice=..&result=..` (redirects to
  `/subscription`), `/reports/scheduled/:id`; platform console `/reset-password`.

## 17. Security headers and CSP

- Each app's `middleware.ts` issues the Content-Security-Policy with a fresh nonce per request
  (`contentSecurityPolicy()` in `packages/config/security.mjs`). Because of the nonce every page is rendered on
  demand; do not add `export const dynamic = 'force-static'`.
- The other headers (frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy, HSTS in production) come
  from `createNextConfig()` in `packages/config/next.mjs`. The camera is allowed only in the staff app and the
  customer portal (document capture).
- Consequences for page code: no inline `<script>`, no `eval`, no third-party script or font hosts. An inline
  script that is really needed takes the nonce from the `x-nonce` request header in a server component (see
  `ThemeScript`). Images and downloads from a storage host other than the API need that origin in
  `NEXT_PUBLIC_STORAGE_ORIGINS`.
- `NEXT_PUBLIC_API_URL` and the `/api/v1` proxy target are fixed at BUILD time. `API_PUBLIC_URL` and
  `API_INTERNAL_URL` are read at run time by the server. Each app has a `.env.example`.

## 18. Temporary markers

Routes that exist so that navigation and emailed links have no dead ends, but whose page is not built yet.
Each renders `<SectionMarker>` (a page header and an honest "not available yet" state) and carries the comment
`// TEMPORARY MARKER`. Replace the whole `page.tsx`; nothing else depends on the marker. Find what is left with:

```bash
grep -rl "TEMPORARY MARKER" apps/*/app
```

**centre-web**: none. Every route of the staff app is a built page.

**customer-web** (15), under `app/(account)/`: `requests`, `requests/new`, `requests/[id]`, `documents`,
`quotations`, `quotations/[id]`, `invoices/[id]`, `payments`, `payments/return`, `appointments`, `messages`,
`notifications`, `profile`, `support`, `support/[id]`.

**corporate-portal** (13), under `app/(app)/`: `employees`, `employees/[id]`, `requests`, `requests/new`,
`requests/[id]`, `approvals`, `invoices`, `invoices/[id]`, `reminders`, `company`, `support`, `support/[id]`,
`notifications`.

**platform-admin** (12), under `app/(app)/`: `dashboard`, `tenants`, `tenants/[id]`, `subscriptions`,
`plans/coupons`, `support`, `access-requests`, `integrations`, `feature-flags`, `staff`, `audit`,
`system-health`.

Built for real in those three: customer-web home, services, service detail, track, FAQ / about / contact /
privacy / terms, login, register and the other auth screens, dashboard; corporate-portal auth screens,
overview, account profile and security; platform-admin auth screens, plans, account profile and security.

## 19. Working in a large app: sections

The staff app is built in sections (`cases`, `people`, `fin`, `ops`, `adm`). A section owns:

```
app/(app)/<its routes>/            pages
components/<section>/              pieces shared by its pages
lib/dictionaries/sections/<section>.ts   its strings, under the `<section>.` namespace
lib/keys/<section>.ts              its TanStack Query keys
scripts/shots-<section>.mjs        its screenshot scenarios
```

App-wide pieces stay outside the sections: `components/pickers.tsx` (customer, service, staff, role ...
pickers), `components/add-customer-dialog.tsx`, `components/staff-shell.tsx`, `lib/nav.ts`.

### Section dictionaries

A section writes every text ONCE as a pair, so the two languages cannot drift apart:

```ts
// lib/dictionaries/sections/ops.ts
const queue: Tree = {
  title: ['Queue', 'قائمة الانتظار'],
  called: ['Token {token} called to counter {counter}', 'تم نداء الرقم {token} إلى الشباك {counter}'],
  waiting: plural({ one: '1 person waiting', other: '{count} people waiting' }, { zero: '...', one: '...', two: '...', few: '...', many: '...', other: '...' }),
};
const tree: Tree = { common, queue /* ... */ };
export const opsEn: Dictionary = side(tree, 0);
export const opsAr: Dictionary = side(tree, 1);
```

`lib/dictionaries/en.ts` and `ar.ts` import the two halves and mount them under the section's name
(`ops: opsEn`), so pages use `t('ops.queue.title')`. `packages/ui/src/i18n/apps.test.ts` checks the merged
dictionaries like any other. A new section copies the small `Pair` / `Tree` / `side` / `plural` helpers from an
existing section file.

Two shared blocks can be EXTENDED from an app or section dictionary (dictionaries are merged deeply):

- `apiErrors.<CODE>`: translated wording for an error code with one meaning. It replaces the API's message.
- `apiErrorFallbacks.<CODE>`: a general sentence for a code, used only when the API said nothing specific.

### Scenario files

`packages/ui/scripts/screenshots.mjs` takes `--scenarios <file.mjs>[,<file.mjs>]`. A file default-exports an
array of scenarios (`name`, `path`, `as`, `ready`, optional `variants`, `prepare(context)`, `act(page)`):

```bash
node packages/ui/scripts/screenshots.mjs --app centre --scenarios apps/centre-web/scripts/shots-fin.mjs --out /tmp/shots-fin --only invoices
```

- `act` may assert: throw an `Error` and the scenario is reported as failed.
  `apps/centre-web/scripts/shots-foundation.mjs` is written that way (Select, lists, dialogs, bell, print,
  onboarding redirect) and is the regression run for changes to `packages/ui`.
- `prepare(context)` runs after sign-in and before the page opens: route interception for states the demo
  data does not have.
- Scenarios named `flow-*` change data: one variant only, on the centre the header of that section's file names
  (Al Noor's seeded records are left alone).
- Accounts are those of `docs/DEMO_ENVIRONMENT.md` (password `TypEase-Demo-2026`).

### Running the apps on a small machine

- `scripts/dev-web-supervised.sh <app> <port> [max-rss-mb]` keeps `next dev` (Turbopack, build directory
  `.next-dev`) alive: it restarts the server when it exits or when its memory passes the limit. While it
  restarts, requests fail for a few seconds: wait and retry; do not start a second server on the same app.
- `scripts/start-web-standalone.sh <app> <port>` runs the production build (`.next/standalone`) after copying
  the static files next to it. Build first, one app at a time:
  `NODE_OPTIONS=--max-old-space-size=2048 pnpm --filter @typease/<app> build`.
- Type-check one app without holding everything in memory twice:
  `NODE_OPTIONS=--max-old-space-size=1536 pnpm exec tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile /tmp/tsbuild-<you>.json`.

## 20. Things the shared components decide for you

Short notes on behaviour that surprised people. Details are in the components' comments.

- **Select** renders its own label; there is no Radix `Select.Value` inside (two owners of one node is what
  React 19 reports as "Cannot use a ref on a React element as a container ..."). It never calls
  `onValueChange('')`: Radix echoes an empty string when a form sets the value programmatically, and no
  option can have that value. Forms need no workaround; to clear a select, set its value to `''` / `null`.
- **DataTable** compares `filters`, `filterValues` and `initialFilterValues` by content, so they need not be
  memoised. `onRowClick(row)` makes rows clickable (links, buttons and the row menu keep their own clicks; the
  title cell becomes a button for the keyboard). `initialFilterValues` starts filters the URL does not carry;
  `filterValues` + `onFilterValuesChange` let a page own them (its own tabs, say; the keys need no control in
  the filter bar); `onPageLoaded({ rows, page, pageSize, total, totalPages, params })` reports each answer.
- **Errors** (`describeError`, `useErrorMessage`, `toasts.error`, `<Form>`): translated wording for a code with
  one meaning (`apiErrors.*`), otherwise the API's own sentence, otherwise a translated general one
  (`apiErrorFallbacks.*`, then by kind). The API writes English only, so add `apiErrors.<CODE>` for the codes
  of your section that have one meaning; never for FORBIDDEN, NOT_FOUND, CONFLICT or PLAN_LIMIT_REACHED, whose
  message carries the specifics. A plain `Error` you throw on purpose shows its message; engine errors do not.
- **Dialogs** hang from a fixed top edge (8% from the top, at most 84% high, body scrolls) and are not
  vertically centred, so growing content never moves the panel upwards. **FormField** holds a message that
  appears because a field was left by a mouse press until the press is released: the control under the pointer
  does not move, and the click is not lost. Use `useHeldWhilePressing(value)` for anything else you reveal on blur.
- **Status badges**: `<StatusBadge kind status>` knows request, invoice, payment, quotation, refund, document,
  verification, checklist, appointment, task, ticket, customer, corporate, membership, subscription,
  subscriptionInvoice, tenant, priority, portalAccess, queue, reminder, reminderDispatch, notification,
  delivery, automationExecution, publish, approval, domain and integration. Add a kind to
  `packages/ui/src/lib/status-meta.ts` (both languages) rather than a local map.
- **Roles**: `roleDisplayName(role, locale)` gives the Arabic name of a built-in role; `RoleSelect` and the top
  bar use it. Roles a centre created keep the name it gave them.
- **Shell**: `notificationsCount` puts the unread count on the bell; a nav item with `parent: '<id>'` is a
  sub-entry (indented, left out of the icon rail); only the most specific matching item is marked current.
- **Printing**: the shell hides its sidebar and top bar, and a page printed from dark mode uses the light
  theme. `.no-print` hides an element on paper, `.print-only` shows one only there.
- **The name of the product**: `useBranding().brandName` is the centre's name in a white-label app and
  "TypEase" otherwise. Use it in every text that names the product ("the code for {brand}"); never write
  "TypEase" into a text a centre's users can read. The shared auth and account screens already do (the
  authenticator entry and the recovery-codes file carry the centre's name too).
- **Password rules**: the rules come from the centre (`PublicTenantConfig.passwordPolicy`, also on an
  invitation preview). `useNewPasswordRules(policy?)` returns `{ policy, field, hint }`: `field` is the Zod
  schema for a NEW password and `hint` the sentence under the input, in the reader's language. The register,
  reset, change-password and accept-invitation forms use it by themselves; pass `passwordPolicy` to them only
  where the branding context has no centre.
- **Devices signed in**: `<SessionsPanel />` lists this device first and ten more, with the total and "Show
  more"; `api.auth.sessionsPage({ limit, app })` returns `{ sessions, total }` (the total is the
  `X-Total-Count` header; `client.requestWithHeaders()` is there for other lists that answer that way).
- **No access**: the default wording is neutral ("Ask an administrator if you need it."). An app that knows
  better overrides `session.noPermissionDescription` in its dictionaries (the platform console does).
- **Support sessions** (TypEase staff inside a centre under an access grant, `session.supportGrant`): the page
  `/support-session` calls `api.auth.exchangeSupportSession(code)` and navigates to `landing`. From there
  `<AppShell>` shows `<SupportSessionBanner />` by itself (permanent, with the countdown and the scopes) and
  `<RequireAuth>` lets the session in although it has no membership, and shows "This support session has
  ended" when it is over (time, revoked by the centre, "End session") instead of the sign-in page. Build
  the navigation from `permissions` as always, and switch off what a support session may not call (the
  server answers `403 SUPPORT_ACCESS_SCOPE`): check `useSession().supportGrant`.
- **Truncated names**: a name that may be written in either script gets `dir="auto"` next to `truncate`, so
  that the ellipsis is at its end in both layouts (see the top bar).
- **Visually hidden labels in scrolling boxes**: `.sr-only` is absolutely positioned. The shared `Table`,
  `DataTable` and every `.scroll-quiet` / `.overflow-x-auto` box are positioning contexts, so such a label
  cannot widen the page; give your own sideways-scrolling box one of these classes.
