# Architecture of the TypEase customer app

> **This app has not been compiled or run.** The first `flutter analyze` may surface errors that need
> fixing. This document describes how the code is organised and why; it is not a claim that the code
> works. See `README.md`, "Verification status".

The app is the customer's side of TypEase: choose a typing centre, sign in, start a service request,
upload documents, follow the status, approve the quotation, pay, and talk to the centre. It talks to
one backend, the TypEase REST API (`/api/v1`), and contains no business rules of its own beyond
earlier, friendlier validation of what the server validates anyway.

## 1. Constraints that shaped the code

| Constraint | Consequence |
| --- | --- |
| No Flutter SDK was available while writing | Conservative Dart 3 / Flutter 3.24 APIs only; **no code generation** (no `freezed`, `json_serializable`, `riverpod_generator`, `build_runner`, `gen-l10n`), so nothing needs to be generated before the first analysis. Models, providers and translations are plain hand-written code. |
| One binary serves every centre | Nothing about a centre is compiled in. Name, logo and colours come from `GET /public/tenant-config` at run time. |
| Customers handle identity documents | Tokens only in the platform keystore, no request / response logging, signed short-lived links for files. |
| English and Arabic | Every string is in `assets/l10n/app_en.arb` and `app_ar.arb`; layouts use `start` / `end`, never `left` / `right`. |

## 2. Folder structure

```
lib/
  main.dart                 start: date formats, shared_preferences, ProviderScope
  app.dart                  MaterialApp.router, theme from the centre, incoming links
  core/
    config/                 AppConfig: values from --dart-define
    errors/                 ApiException (one typed error for everything)
    l10n/                   AppLocalizations (runtime ARB loader), context extensions
    network/                ApiClient, SessionManager, TokenRefresher, Page<T>, UrlRewriter
    routing/                Routes, go_router setup, redirect logic, deep links
    storage/                TokenStore (secure), keys of the plain preferences
    theme/                  BrandColors (contrast maths), BrandTokens, AppTheme
    utils/                  defensive JSON helpers, Money / Decimal, Dates, Validators, countries
    widgets/                shared widgets: states, buttons, fields, badges, timeline
    providers.dart          the handful of app-wide providers
  features/<feature>/
    data/                   models (fromJson) and the repository (one method per endpoint)
    application/            Riverpod providers / notifiers; pure logic (e.g. FormEngine)
    presentation/           screens and feature-specific widgets
```

Features: `tenant`, `auth`, `home`, `catalogue`, `requests`, `documents`, `finance`, `notifications`,
`appointments`, `support`, `reminders`, `profile`, `settings`.

Dependency direction: `presentation → application → data → core`. A feature may use another feature's
`data` and `application` (the request screen shows finance data), never its screens, except through
the router.

## 3. Layers

### data

- **Models** are immutable classes with a hand-written `factory X.fromJson(Object? json)`. Parsing is
  defensive (`core/utils/json.dart`): a missing or wrongly typed field becomes a default, never an
  exception, because an installed app outlives server releases. Unknown enum values are kept as
  strings; an unknown form field type becomes `FormFieldType.unsupported`.
- **Money** is never a `double`. Amounts stay the decimal strings the API sends (`"476.00"`);
  arithmetic and formatting go through `core/utils/money.dart` (`Decimal` on `BigInt`).
- **Dates** stay ISO strings in the models and are formatted at display time (`core/utils/dates.dart`).
  Calendar dates are not shifted by the time zone.
- **Repositories** are thin: one method per endpoint, returning models. They hold no state.

### application

Riverpod 2 in its classic, non-generated form:

| Kind | Used for |
| --- | --- |
| `Provider` | repositories, configuration, the router |
| `FutureProvider.autoDispose(.family)` | "load this screen's data" (`requestDetailProvider(id)`, `invoiceProvider(id)`, …). Pull-to-refresh is `ref.invalidate(...)`. |
| `Notifier` / `AsyncNotifier` | state with behaviour: `AuthController`, `TenantController`, `SettingsController`, `RequestListController` (paging), `InboxController`, `UploadQueue`, `PushController` |
| `StateProvider.autoDispose` | small UI state shared between widgets (the request list filter) |

After a mutation the screen invalidates the providers that show the changed data
(`refreshFinance` in `finance/presentation/finance_actions.dart` is the largest example). There is no
client-side cache beyond that: the server is the source of truth.

### presentation

Screens are `ConsumerWidget` / `ConsumerStatefulWidget`. Rules followed throughout:

- one primary action per screen (`PrimaryButton`); everything else is a text or outlined button;
- three states for every load: `LoadingView`, `EmptyStateView`, `ErrorStateView` with "Try again"
  (`AsyncValueView` wraps the pattern), plus pull-to-refresh (`RefreshableList`);
- forms keep their own `TextEditingController`s, so input survives a failed submit; API field errors
  (`ApiException.fieldErrorMap`) are shown at the fields;
- destructive or irreversible actions (cancel request, approve / reject quotation, sign out other
  devices, delete-data request) ask first (`showConfirmDialog`);
- providers are watched in the screen's `build`, not inside builder callbacks of child widgets.

## 4. Start-up and navigation

`appGateProvider` (`auth/application/bootstrap.dart`) reduces configuration, start-up, preferences,
centre selection and sign-in state to one enum, and `resolveRedirect` (`core/routing/redirect_logic.dart`,
a pure function with unit tests) turns that into the router's redirect:

| Gate | Reachable |
| --- | --- |
| `configError` | only the configuration error screen (release build without `API_BASE_URL`) |
| `booting`, `bootError` | splash (with "Try again" after a failed start) |
| `needsOnboarding` | introduction |
| `needsCentre` | centre selection, accept invitation |
| `signedOut` | sign-in family; centre selection unless the build is locked to a centre |
| `signedIn` | everything else; sign-in screens lead home |

`go_router` uses flat top-level routes plus one `ShellRoute` for the four tabs (Home, My requests,
Payments, Profile). The "+" in the bottom bar is not a tab: it pushes the catalogue.

Start-up (`bootstrapProvider`): load or refresh the centre configuration, then, if a refresh token is
in the keystore, `POST /auth/refresh`. A stored token that the server rejects signs the user out with
a message; a server that cannot be reached leaves the session intact and shows "Try again".

## 5. Networking and tokens

`core/network/api_client.dart` is the only place that performs API calls.

- Headers on every request: `X-Client-App: mobile`, `Accept-Language: en|ar`, `X-Tenant-Host` (only
  in white-label builds with `TENANT_HOST`), and `Authorization: Bearer <access token>` unless the
  call is public.
- The **access token** lives in memory only. The **refresh token** lives only in the platform
  keystore (`flutter_secure_storage`), never in `shared_preferences`, never in logs.
- The API rotates refresh tokens on every use, and presenting a used token revokes the whole
  session. Refresh is therefore **single-flight** (`TokenRefresher`): any number of requests that
  need a new token wait for one `POST /auth/refresh { refreshToken, app: "mobile" }`.
- Proactive refresh: before a request when there is no access token (after a restart) or it is
  about to expire. Reactive refresh: on `401 TOKEN_INVALID`, then the request is replayed once.
- `401 SESSION_EXPIRED`, or a refresh answered with 400 / 401 / 403, ends the session:
  `SessionManager.expire()` clears the keystore entry, and `AuthController` shows the sign-in screen
  with "Your session has ended". A refresh that fails for transport reasons keeps the session.
- The refresh call and the upload of file bytes use separate `Dio` instances without interceptors,
  so the refresh can never recurse and the bearer token is never sent to a storage URL.
- Every failure becomes an `ApiException` with a `kind` (network, timeout, unauthorized, validation,
  …), the server's `code` and `message`, and field errors. `describeError` turns it into one sentence:
  the server's own message when there is one, a localised text for transport failures.
- Nothing is logged. There is no logging interceptor, and `avoid_print` is enabled in
  `analysis_options.yaml`.

```
request ──► onRequest: token missing / expiring? ──► TokenRefresher.refresh() ─┐ (one call, shared)
                │ token ok                                                     │
                ▼                                                              ▼
            send ──► 401 TOKEN_INVALID ──► refresh (shared) ──► replay once ──► result
                 └─► 401 SESSION_EXPIRED ─► SessionManager.expire() ─► sign-in screen
```

## 6. White label at run time

See `WHITE_LABEL_MOBILE.md` for the product view. In code:

1. The centre is chosen by typing its code, by a link (`typease://centre/<slug>`, a portal link with
   `?tenant=<slug>`, or a custom-domain portal link resolved with `?host=`), or fixed by the
   `TENANT_SLUG` dart-define.
2. `TenantController` verifies it with `GET /public/tenant-config`, caches the JSON in
   `shared_preferences` (branding is public information) and refreshes it on every start.
3. `AppTheme.build` creates the `ThemeData` from the three brand colours. `BrandColors`
   (`core/theme/brand_colors.dart`, pure Dart, unit-tested) computes WCAG contrast: text on a brand
   colour is black or white, whichever is readable, and a brand colour used *as* text or icon is
   darkened or lightened until it reaches 4.5:1 (text) or 3:1 (icons) on the surface. A centre can
   therefore not configure an unreadable app.
4. The logo is loaded from the configured URL (`BrandLogo`); the centre's name is shown while it
   loads or if it fails. No logo or colour of any centre is bundled.

## 7. Localisation

`AppLocalizations` (`core/l10n/app_localizations.dart`) reads the ARB files from the asset bundle at
run time and looks messages up by key: `context.l10n.t('loginTitle')`, with `{placeholders}` and ICU
plurals (`Intl.pluralLogic`, including the Arabic forms).

**Why not `flutter gen-l10n`:** it generates Dart code, and this project was written to analyse
without any generation step. The cost is that a misspelt key is not a compile error. Two tests cover
that instead (`test/unit/l10n_test.dart`): every key the code looks up exists, and both languages have
the same keys and placeholders. Moving to `gen-l10n` later is mechanical (the ARB files are standard).

Server-provided texts (service names, status labels, checklist labels) arrive in both languages and
are picked with `context.pick(en, ar)` / `LocalizedText.resolve`. Labels derived from server codes use
`tOr(key, fallback)` so that a code newer than the app still shows something sensible.

Right-to-left: `MaterialApp` gets the locale from `SettingsController`; widgets use
`EdgeInsetsDirectional`, `AlignmentDirectional` and start / end alignment. Email addresses, phone
numbers and codes are forced left-to-right (`AppTextField.forceLtr`). Money is wrapped in Unicode
isolates so that `AED 476.00` does not get reordered inside Arabic text.

## 8. Requests: dynamic forms, documents, status

- **Dynamic form.** The service's form definition (`FormSchema`: steps → fields, `showIf`, options,
  limits) comes from the API. `FormEngine` (`requests/application/form_engine.dart`, pure Dart,
  unit-tested) mirrors the server's validator: which fields are visible, what is missing or
  malformed, and the payload to save (hidden fields are cleared). The server validates again and its
  field errors are mapped back onto the fields.
- **Wizard.** Form steps → documents → review. Each step is saved to the server as a draft
  (`PUT /requests/:id/fields`), so a request can be continued later or on another device.
- **Upload** is the API's three-step protocol: `POST /documents/upload-intents` → `PUT` the bytes to
  the signed URL with exactly the headers the API returned → `POST …/complete`. Before any byte is
  sent the file type is checked by content (magic bytes) and size (`UploadRules`). `UploadQueue`
  tracks progress per file; a failed file can be retried without losing the others.
- **Status timeline.** `buildRequestTimeline` combines the customer-visible status history, the
  status reported by an outside party and the workflow steps still to come. A status that came from
  outside TypEase is always shown with its **source label** ("Entered by staff (not verified by the
  authority)", "Verified via official integration", …); when the API sends no label, the standard
  wording for the source is used, and an unknown source is never presented as official.

## 9. Payments

The app never marks anything as paid. "Pay now" asks the API for a checkout session
(`POST /invoices/:id/pay`) and opens the gateway's page in the browser. The invoice changes when the
gateway confirms the payment to the server; the invoice screen reloads when the app returns to the
foreground. The API accepts only return addresses on the centre's web portal, so the app sends
`PORTAL_BASE_URL/payments/return?invoice=…` when that dart-define is set (and retries without it when
the API answers `INVALID_RETURN_URL`). With the development sandbox gateway a test dialog can complete
or fail the payment; it appears only when the API itself reports `gateway: "sandbox"` and
`testMode: true`.

## 10. Links and push

- `DeepLinkParser` (pure, unit-tested) turns a URI into a `DeepLinkTarget`. `lib/app.dart` receives
  links from `app_links`. For a signed-out user it selects the centre the link names; for a user who
  is signed in to a different centre it does not switch centre behind their back but says that the
  link belongs to another centre. A target that needs a session is kept until the user has signed
  in, and then opened.
- Push uses Firebase Cloud Messaging and is entirely optional (`FIREBASE_ENABLED`). The API's push
  payload carries only `notificationId`; the tapped notification is resolved through the inbox to its
  request / invoice / ticket. The in-app inbox does not depend on Firebase.

## 11. Testing strategy

Everything under `test/` and `integration_test/` is **written but has never been executed**.

| Area | File | What it pins down |
| --- | --- | --- |
| Models | `test/unit/models_test.dart` | parsing of 40+ real API responses (`test/fixtures/`) |
| Money | `test/unit/money_test.dart` | exact decimal arithmetic and formatting |
| Dynamic form | `test/unit/form_engine_test.dart` | required / type / option checks, `showIf`, payload |
| Token refresh | `test/unit/token_refresh_test.dart` | single-flight under parallel 401s, expiry, offline, replay-once (fake Dio adapter) |
| Theme contrast | `test/unit/brand_colors_test.dart` | contrast helpers for arbitrary brand colours |
| Timeline | `test/unit/timeline_builder_test.dart` | order, current step, source label always present |
| Links, gates | `test/unit/deep_links_test.dart`, `redirect_logic_test.dart` | link parsing, redirect table |
| Translations | `test/unit/l10n_test.dart` | key parity EN / AR, placeholders, plurals, keys used in code exist |
| Uploads, helpers | `test/unit/upload_rules_test.dart`, `core_utils_test.dart` | file checks, error mapping, validators, dates |
| Widgets | `test/widget/login_form_test.dart`, `status_timeline_rtl_test.dart` | form validation and API errors; timeline in Arabic / RTL |
| End to end | `integration_test/app_test.dart` | skeleton: centre → sign in → home → catalogue → service (needs a device and a local API) |

## 12. Decisions worth knowing before changing things

- **`Page<T>`** (`core/network/page.dart`) shares its name with Flutter's navigation `Page`. It is
  only imported by data and application files, which do not import Flutter widgets. If a screen ever
  needs the type by name, import it with a prefix or rename it.
- **Version-neutral widgets.** The theme avoids properties whose types changed between Flutter
  releases (`cardTheme`, `dialogTheme`, `tabBarTheme`, `Color.withOpacity`), and the form uses its
  own bottom-sheet `SelectField` and radio rows instead of `DropdownButtonFormField` /
  `RadioListTile`, whose APIs moved in recent releases.
- **No offline mode.** Screens need the network; a failed load shows the error state with a retry.
  Only the centre configuration and device preferences are cached.
- **Branch list for appointments.** The API has no "list branches" call for customers, so the booking
  screen assembles branches from public booking options, the customer's appointments and requests
  (`bookableBranchesProvider`), and explains what to do when there are none.
- **Not implemented** (see also `SCREEN_ENDPOINT_MAP.md`): PDF download of quotations / invoices /
  receipts, editing form fields after submission (the fields are shown read-only; documents can be
  replaced), MFA enrolment, an in-app QR scanner (the phone camera opens `typease://centre/<slug>`
  links), offline queueing of uploads, recovery of a photo when Android kills the app while the
  camera is open (`ImagePicker.retrieveLostData`).
