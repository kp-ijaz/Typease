# TypEase customer mobile app (Flutter)

The customer's side of TypEase on Android and iOS: choose a typing centre, sign in, start a service
request, upload documents, follow the status, approve the quotation, pay, book an appointment and talk
to the centre. One app serves every centre; name, logo and colours are loaded from the API at run time.

> ## Verification status
>
> **This app has not been compiled or run. The first `flutter analyze` may surface errors that need
> fixing.**
>
> It was written on a machine without the Flutter / Dart SDK and without internet access. Nothing in
> this folder was built, analysed or executed with Flutter: not the app, not the tests, not
> `tool/bootstrap.sh` with a real SDK. What *was* done instead:
>
> - every response model was written against responses captured from the running local API
>   (`test/fixtures/`, see "Tests");
> - every file was re-read for syntax, imports, null-safety and API usage, and checked with small
>   scripts for bracket balance, unresolved imports and missing translation keys;
> - only conservative, long-stable Flutter and package APIs were used, and no code generation.
>
> None of that replaces a compiler. Section "First compile: where to look first" lists the places most
> likely to need a fix. Treat the first `tool/bootstrap.sh` run as part of the development work, not
> as a formality.

## Contents

| Path | What |
| --- | --- |
| `lib/` | The application (127 Dart files). Structure: `ARCHITECTURE.md`. |
| `assets/l10n/` | `app_en.arb`, `app_ar.arb` (718 messages each). |
| `test/` | Unit and widget tests, real API response fixtures. **Not executed.** |
| `integration_test/` | Happy-path skeleton against a local API. **Not executed.** |
| `tool/bootstrap.sh` | Generates `android/` and `ios/`, applies native configuration, runs analyze and tests. |
| `tool/native/` | Native configuration snippets and the script that applies them (`tool/native/README.md`). |
| `config/*.example.json` | Example build configurations for `--dart-define-from-file`. |
| `ARCHITECTURE.md` | How the code is organised and why. |
| `WHITE_LABEL_MOBILE.md` | Run-time branding versus separately published apps. |
| `SCREEN_ENDPOINT_MAP.md` | Every screen with the API endpoints it calls. |

There is no `android/`, `ios/` or `pubspec.lock` in the repository: they are created by the bootstrap
script on a machine with Flutter. Commit all three after the first successful run.

## Requirements

- Flutter **3.24 or newer** (Dart 3.5+), stable channel.
- Android Studio with an emulator or device (Android 6.0 / API 23 or newer); for iOS a Mac with Xcode
  and CocoaPods (iOS 13 or newer).
- `python3` (used by the bootstrap script to apply the native configuration).
- A running TypEase API. Locally that is `http://localhost:4000/api/v1`.

## First-time setup

```bash
cd apps/customer-mobile
tool/bootstrap.sh
```

The script: checks Flutter → runs
`flutter create --platforms=android,ios --org ae.typease --project-name typease_customer .` (the
project's own files are backed up first and put back afterwards; the template's counter test is
removed) → `flutter pub get` → applies the native configuration → `flutter analyze` → `flutter test`.
It prints a summary and exits non-zero if analysis or tests report anything. It is safe to run again.

Options (environment variables): `ORG`, `APP_NAME`, `DEEP_LINK_SCHEME`, `DEEP_LINK_HOSTS`,
`ANDROID_MIN_SDK`, `IOS_MIN_VERSION`, `SKIP_CREATE=1`, `SKIP_CHECKS=1` - see the header of the script.

If `flutter pub get` cannot resolve a version, see "Packages".

## Run the app

The API address is a build-time value. In **debug** builds it defaults to the local API:
`http://10.0.2.2:4000/api/v1` on Android (see below) and `http://localhost:4000/api/v1` elsewhere.

```bash
# Android emulator
flutter run -d emulator-5554

# iOS simulator
flutter run -d "iPhone 15"

# A physical phone on the same Wi-Fi as the development machine
flutter run --dart-define=API_BASE_URL=http://192.168.1.20:4000/api/v1

# With a configuration file (copy config/dev.example.json to config/dev.json first)
flutter run --dart-define-from-file=config/dev.json
```

### Why `10.0.2.2` on the Android emulator

Inside the Android emulator `localhost` is the emulator itself. The development machine is reachable
as `10.0.2.2`. Two consequences are handled for you:

- the debug default of `API_BASE_URL` on Android is `http://10.0.2.2:4000/api/v1`;
- a local API signs upload, download and payment links with its own address (`http://localhost:4000/…`).
  `lib/core/network/url_rewriter.dart` rewrites such loopback links to the host of `API_BASE_URL`.
  It does nothing for real hosts.

Plain http is allowed in **debug builds only** (`android/app/src/debug/AndroidManifest.xml`, added by
the bootstrap). Release builds must use https. On a physical iPhone, http to a LAN address may be
blocked by App Transport Security; use the simulator, an https tunnel, or a development-only exception.

### Signing in

On first launch the app shows a short introduction, then asks for the **centre code** (the tenant
slug), or accepts a link `typease://centre/<slug>`. Then sign in with a customer account of that
centre, or register (if the centre allows self-registration). With a development API
(`EXPOSE_DEV_TOKENS=true`) debug builds show the one-time codes and offer a "confirm now" button for
email verification, because no real email or SMS is sent.

## Configuration (`--dart-define`)

Read in `lib/core/config/app_config.dart`. Nothing here is a secret, and nothing is centre branding.

| Define | Default | Meaning |
| --- | --- | --- |
| `API_BASE_URL` | debug: local API; **release: none** | Base URL including `/api/v1`. A release build without it shows a configuration error screen instead of guessing a server. |
| `TENANT_SLUG` | (empty) | Locks the build to one centre (separately published white-label app). Empty: the user chooses the centre. |
| `TENANT_HOST` | (empty) | Sent as `X-Tenant-Host` (white-label portal host). |
| `PORTAL_BASE_URL` | (empty) | Origin of the centre's web portal; used as the return address after online payment. The API accepts only portal origins registered for the centre. |
| `DEEP_LINK_SCHEME` | `typease` | Custom URL scheme. Must match the native configuration (`DEEP_LINK_SCHEME` of the bootstrap). |
| `DEEP_LINK_HOSTS` | (empty) | Comma-separated https hosts whose links are accepted. Empty: any host (the centre is then resolved from `?tenant=` or the host). |
| `APP_FLAVOR` | `dev` | `dev`, `staging` or `prod`. Shown in Settings; no behaviour depends on it. |
| `FIREBASE_ENABLED` | `false` | Turns push notifications on. |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID` | (empty) | Firebase options. If all four are given, no `google-services.json` / `GoogleService-Info.plist` is needed to initialise Firebase. |

### Flavours

Environments differ only in these values, so a "flavour" is a configuration file:

```bash
cp config/dev.example.json  config/dev.json      # local API
cp config/prod.example.json config/prod.json     # fill in the real values
flutter run   --dart-define-from-file=config/dev.json
flutter build appbundle --release --dart-define-from-file=config/prod.json
```

`config/*.json` is git-ignored (the examples are not). Native flavours (different application ids
and icons in one project) are **not** set up; they are needed only for separately published apps,
see `WHITE_LABEL_MOBILE.md`.

## Build

```bash
# Android: APK for testers
flutter build apk --release --dart-define-from-file=config/prod.json

# Android: bundle for Google Play
flutter build appbundle --release --dart-define-from-file=config/prod.json

# iOS: archive for TestFlight / App Store (on macOS, after signing is set up in Xcode)
flutter build ipa --release --dart-define-from-file=config/prod.json
```

Before the first release build: set up signing (Android keystore and `signingConfigs`; iOS team and
provisioning in Xcode), replace the placeholder launcher icons, and check the application id / bundle
id. None of that is automated; see `tool/native/README.md`, "Not automated".

## Push notifications

Push uses Firebase Cloud Messaging and is **off by default**. The in-app notification inbox does not
depend on it.

1. Create a Firebase project and add an Android app and an iOS app with this app's ids.
2. iOS: upload an APNs key in the Firebase console; in Xcode enable the *Push Notifications*
   capability and *Background Modes → Remote notifications*.
3. Build with `FIREBASE_ENABLED=true` and the four `FIREBASE_*` values (from the Firebase console), or
   add `google-services.json` / `GoogleService-Info.plist` and the Google Services Gradle plugin as
   described by FlutterFire. Both files are git-ignored.
4. On the server, push must be configured (`PUSH_DRIVER=fcm` with a service-account key, or a PUSH
   integration of the centre; see `docs/api/modules/notifications.md`). Otherwise the API stores the
   device token and delivers nothing. The API documentation states that its FCM sender was tested
   against a local fake server only, not against Google.

After sign-in the app asks for notification permission, registers the device token with
`POST /me/devices`, and removes it on sign-out. The API's push payload carries only a
`notificationId`; tapping a notification opens the related request, invoice, appointment or ticket by
looking the notification up in the inbox.

Not covered: notification channels / custom sounds on Android, rich notifications, a background
message handler (messages received while the app is closed are shown by the system; the app reacts
when the user taps them).

## Deep links

| Link | Opens |
| --- | --- |
| `typease://centre/<slug>` | Selects the centre (first launch, QR code at the counter). |
| `typease://requests/<id>`, `…/invoices/<id>`, `…/quotations/<id>`, `…/support/<id>` | The item, after sign-in if necessary. |
| `typease://appointments`, `…/notifications`, `…/reminders`, `…/payments` | The list. |
| `typease://requests/new?renewalOf=<reminder id>` | The catalogue, to start a renewal. |
| `typease://verify-email?token=…`, `…/reset-password?token=…`, `…/accept-invitation?token=…` | The account flows from emails. |
| `https://<portal-host>/<same paths>?tenant=<slug>` | The same, from links in emails and messages. |
| `https://<portal-host>/payments/return?invoice=<id>` | The invoice, after returning from the payment page. |

The custom scheme is registered by the bootstrap. `https://` links additionally need the portal host to
vouch for the app: Android App Links (`DEEP_LINK_HOSTS` at bootstrap time, plus
`/.well-known/assetlinks.json` on the host) and iOS Universal Links (Associated Domains capability in
Xcode, plus `/.well-known/apple-app-site-association`). See `tool/native/README.md` and
`WHITE_LABEL_MOBILE.md`.

Try a link:

```bash
adb shell am start -a android.intent.action.VIEW -d "typease://centre/<slug>"
xcrun simctl openurl booted "typease://centre/<slug>"
```

## Packages

Versions as declared in `pubspec.yaml`. They are the releases that were current when the code was
written (late 2024) and were **not resolved by `pub` here**; there is no `pubspec.lock` yet.

| Package | Constraint | Used for |
| --- | --- | --- |
| `flutter_riverpod` | `^2.6.1` | State management (classic `Notifier` / `AsyncNotifier`, no generator). |
| `go_router` | `^14.6.2` | Navigation and redirects. |
| `dio` | `^5.7.0` | HTTP client, interceptors, upload progress. |
| `flutter_secure_storage` | `^9.2.2` | Refresh token in Android Keystore / iOS Keychain. |
| `shared_preferences` | `^2.3.3` | Non-sensitive preferences and the cached centre branding. |
| `image_picker` | `^1.1.2` | Camera and photo library. |
| `file_picker` | `^8.1.4` | Choosing PDF and image files. |
| `firebase_core` | `^3.8.0` | Firebase initialisation (only when push is enabled). |
| `firebase_messaging` | `^15.1.5` | Push notifications (only when push is enabled). |
| `app_links` | `^6.3.2` | Incoming deep links. |
| `url_launcher` | `^6.3.1` | Browser (payment page, documents), phone, email. |
| `package_info_plus` | `^8.1.1` | Version shown in Settings. |
| `app_settings` | `^5.1.1` | "Open settings" after a refused camera permission. |
| `intl` | `any` | Dates, plurals. Pinned by `flutter_localizations` of the installed SDK. |
| `flutter_localizations` | SDK | Material / Cupertino translations, RTL. |
| dev: `flutter_test`, `integration_test` | SDK | Tests. |
| dev: `flutter_lints` | `^5.0.0` | Lints (`analysis_options.yaml`). |

No code generators (`build_runner`, `freezed`, `json_serializable`, `riverpod_generator`) and no
`flutter gen-l10n` step: `flutter pub get` is the only step before analysing.

**Upgrading.** With a newer Flutter some constraints may no longer resolve, or you may simply want
current versions:

```bash
flutter pub outdated
flutter pub upgrade --major-versions
flutter analyze && flutter test
```

Read the changelogs of the packages that jump a major version before doing this; the ones most likely
to need code changes are `flutter_riverpod` (3.x removes the `AutoDispose…` class names used in three
places), `go_router`, `file_picker`, `flutter_secure_storage` (10.x changes the Android options) and
the Firebase packages (newer versions raise the minimum iOS / Android versions; adjust
`IOS_MIN_VERSION` / `ANDROID_MIN_SDK` and run the bootstrap again).

## Tests

**Everything below is written and has never been executed.** Each test file says so in its first line.

```bash
flutter test                                   # unit and widget tests
flutter test test/unit/token_refresh_test.dart # one file
```

| File | Covers |
| --- | --- |
| `test/unit/models_test.dart` | Parsing of the response models from the fixtures. |
| `test/unit/money_test.dart` | Decimal-safe money helper (no `double`). |
| `test/unit/form_engine_test.dart` | Dynamic form: validation, `showIf`, payload. |
| `test/unit/token_refresh_test.dart` | Token refresh: single-flight under parallel 401s, session expiry, offline, replay once; request headers; error mapping. Uses a fake Dio adapter (`test/support/fake_adapter.dart`). |
| `test/unit/brand_colors_test.dart` | Contrast helpers of the tenant theme. |
| `test/unit/timeline_builder_test.dart` | Status timeline entries; external statuses always carry a source label. |
| `test/unit/deep_links_test.dart`, `redirect_logic_test.dart` | Link parsing; router redirect table. |
| `test/unit/l10n_test.dart` | EN / AR key and placeholder parity, plurals, and that every key used in `lib/` exists. |
| `test/unit/upload_rules_test.dart`, `core_utils_test.dart` | File checks before upload; error mapping, URL rewriting, validators, dates, JSON helpers. |
| `test/widget/login_form_test.dart` | Sign-in form: validation, API field errors, kept input, Arabic. |
| `test/widget/status_timeline_rtl_test.dart` | Status timeline in Arabic (right-to-left) with the source label. |

**Fixtures.** `test/fixtures/*.json` (44 files) are real responses of the local API, captured with
`curl` while a test centre and a test customer went through the whole journey; only secrets were
replaced (`test/fixtures/README.md`). The Dart models were written against them. Which screens rest
on a captured response and which only on the API documentation is listed per screen in
`SCREEN_ENDPOINT_MAP.md`.

**Integration test.** `integration_test/app_test.dart` is a skeleton of the happy path (choose centre →
sign in → home → catalogue → service details, optionally start a draft). It needs a device, a local
API and an existing customer account:

```bash
flutter test integration_test/app_test.dart -d <device-id> \
  --dart-define=API_BASE_URL=http://10.0.2.2:4000/api/v1 \
  --dart-define=IT_CENTRE=<centre-code> \
  --dart-define=IT_EMAIL=<customer-email> \
  --dart-define=IT_PASSWORD=<customer-password>
```

Without the three `IT_*` values the test is skipped. `IT_CREATE_DRAFT=true` additionally creates one
draft request in the API's database.

## Security and privacy notes

- **Tokens.** The refresh token is stored only in the platform keystore (`flutter_secure_storage`:
  Android Keystore-backed encrypted preferences, iOS Keychain "after first unlock, this device
  only"). The access token is kept in memory only. Neither is ever written to `shared_preferences`.
- **Logs.** The app has no request / response logging and no `print` calls (the `avoid_print` lint
  is switched on in `analysis_options.yaml`). Errors shown to the user are the server's
  plain-language messages or localised texts, never stack traces.
- **Documents** are opened through short-lived signed links requested at the moment of the tap; links
  are not stored. Uploaded files are checked on the device (type by content, size) before any byte is
  sent, and the server scans them again.
- **Identity numbers** (Emirates ID, passport) reach the app only masked.
- **Screenshot privacy (optional, not enabled).** Blocking screenshots and the recent-apps preview
  protects documents on screen but also prevents customers from sending a screenshot to support.
  Android: `tool/native/android/MainActivity.flag_secure.kt.txt` shows the change (`FLAG_SECURE`).
  iOS has no equivalent switch; hiding content in the app switcher needs a small native overlay,
  which is not included.
- **Certificate pinning (optional hardening, not implemented).** The app relies on the platform's TLS
  validation. Pinning the API's certificate or public key would further limit interception on
  compromised devices or networks, at the cost of an app release (or a remote pin update mechanism)
  whenever the certificate changes. If required, add it in `lib/core/network/api_client.dart` by
  giving Dio an `IOHttpClientAdapter` whose `HttpClient` validates the pinned key, and pin at least
  two keys (current and backup).
- **Jailbreak / root detection, app attestation:** not implemented.

## Known limitations

- PDF download of quotations, invoices and receipts is not implemented (amounts and lines are shown
  on screen).
- After submission the form answers are read-only in the app; documents can be replaced and messages
  sent. Correcting form fields when the centre asks for it has to be done in the web portal.
- The app does not use the API's branch directory for signed-in customers
  (`GET /api/v1/branches/directory`: names, addresses and opening hours). The booking screen derives
  branches from the centre's published booking options and the customer's own appointments and
  requests, and explains what to do when there are none; switching it to the directory route is a
  small change that has not been made.
- Enrolling in two-step verification (MFA) is not offered; signing in with an existing authenticator
  or recovery code is.
- No in-app QR scanner: the phone's camera app opens `typease://centre/<slug>` links.
- No offline mode: every screen needs the network and shows a retry on failure.
- If Android destroys the app while the system camera is open, the photo is lost and has to be taken
  again (`ImagePicker.retrieveLostData` is not used).
- Returning from the payment page through a portal link while the invoice screen is already open
  pushes a second invoice screen on top (the data is correct; "back" shows the first one).
- Company (corporate) users can sign in but there are no company-account screens.

## First compile: where to look first

A candid list, most likely first. The code was reviewed against these, but not compiled.

1. **Package API details.** Call sites written from memory of the package versions above:
   - `dio`: `Interceptor` overrides declared `Future<void> … async`, `DioException.copyWith`,
     `Dio.fetch`, stream upload with `Options(contentType:)` and a `Content-Length` header
     (`lib/core/network/api_client.dart`, `lib/features/documents/data/documents_repository.dart`);
   - `go_router`: `GoRouterState.uri`, `pushReplacement`, `ShellRoute`, `refreshListenable`
     (`lib/core/routing/app_router.dart`);
   - `flutter_riverpod`: `AutoDisposeAsyncNotifier`, `AutoDisposeFamilyNotifier`,
     `NotifierProvider.autoDispose.family` (`requests_providers.dart`, `inbox_controller.dart`,
     `upload_queue.dart`);
   - `flutter_secure_storage` option names (`lib/core/storage/token_store.dart`);
   - `firebase_messaging` / `firebase_core` (`push_controller.dart`); `app_links` (`lib/app.dart`);
     `image_picker`, `file_picker`, `app_settings` (`document_upload_screen.dart`,
     `camera_capture_screen.dart`, `attachment_picker.dart`).
2. **Flutter widget APIs that changed between releases.** `PopScope.onPopInvokedWithResult` (needs
   Flutter 3.22+), `SegmentedButton`, `FilledButton.tonalIcon`, `IconButton.isSelected`,
   `showModalBottomSheet(showDragHandle:)`, `Badge`, and the theme properties in
   `lib/core/theme/app_theme.dart`.
3. **Flow analysis.** Places that rely on Dart 3 exhaustiveness or definite assignment: enum
   `switch` statements without `default` that return in every case (`describeError`,
   `resolveRedirect`, `DeepLinkTarget.location`, `continueSignIn`, `ToneColors.of`,
   `FormEngine._check`, `describeFormValue`, `DynamicFormField.build`), and variables assigned inside
   `try` with a `catch` that returns (`DocumentsRepository.inspect`, `payInvoiceFlow`,
   `_startUpload`, the pattern check in `FormEngine._check`).
4. **Lints.** `flutter analyze` treats infos as failures by default. Expect some
   `prefer_const_constructors`, `use_build_context_synchronously` and similar findings; use
   `flutter analyze --no-fatal-infos` to separate them from errors.
5. **Tests.** The widget tests drive Dio through a fake adapter inside the test's fake clock
   (`tester.pump(Duration)`); if a request does not complete, that is where to look. The RTL test
   uses `find.bySemanticsLabel`; the timeline tests need `initializeDateFormatting()` (called in
   `setUpAll`).
6. **Run-time behaviour that only a device shows.** Layout overflow on very small screens or large
   font scales, keyboard handling in the wizard, redirect timing around deep links at cold start,
   and plain-http access to a local API (see "Why `10.0.2.2`").
7. **`tool/native/apply_native_config.py`.** Tested against template files written from memory, not
   against real `flutter create` output. Read its messages; every change it makes is listed in
   `tool/native/README.md`.
