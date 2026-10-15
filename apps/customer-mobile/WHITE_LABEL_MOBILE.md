# White label on mobile

> **This app has not been compiled or run.** The first `flutter analyze` may surface errors that need
> fixing. The procedures below describe what the code and the build tooling are designed to do; none
> of them has been carried out with this code base.

TypEase is multi-tenant: every typing centre is a tenant with its own name, logo, colours, services
and customers. On mobile there are two ways to give a centre "its own app". They differ in cost and
in what the stores allow, and the difference matters when a centre asks for one.

| | A. Shared app, branded at run time | B. Separately published app |
| --- | --- | --- |
| What the customer installs | "TypEase" from the stores | "Al Noor Typing" from the stores |
| Icon and name on the home screen | TypEase | The centre's |
| Inside the app | The centre's name, logo and colours | The centre's name, logo and colours |
| Choosing the centre | Once: by link, QR code or centre code | Never: the build is locked to the centre |
| New build per centre | No | **Yes** |
| Store listing, review, developer account | TypEase's | **The centre's own (or one managed for it)** |
| Effort per centre | Minutes (configuration in the centre admin) | Days, then ongoing releases |

Both are served by the same source code. Nothing about any centre is compiled into the Dart code.

## A. Shared app, branded at run time (the default)

1. The customer opens a link from the centre - `typease://centre/<slug>`, or a portal link such as
   `https://<portal-host>/…?tenant=<slug>` - or types the centre code on the "Choose your centre"
   screen. A QR code printed at the counter is simply that link.
2. The app calls `GET /public/tenant-config?slug=<slug>` and receives the public presentation data:
   name (English / Arabic), logo URL, three brand colours, support contact, default language,
   currency, feature flags.
3. The theme is built from the colours (`lib/core/theme/app_theme.dart`). Readability is enforced by
   the app, not left to the centre: text on a brand colour is black or white, whichever reaches the
   WCAG AA contrast ratio, and a brand colour used as text or icon is adjusted until it is readable
   on the background (`lib/core/theme/brand_colors.dart`).
4. The configuration is cached on the device (it is public information) and refreshed on every
   start, so a rebrand in the centre admin reaches installed apps without a release.
5. "Switch centre" on the sign-in screen forgets the centre; a customer of two centres can use both,
   one at a time. A signed-in user is never moved to another centre by a link.

What run-time branding **cannot** change, because the operating systems and stores fix these at build
or publication time: the launcher icon, the app name under the icon, the store listing (name,
screenshots, description), the splash image shown before Flutter starts, the application id / bundle
id, the sender name of push notifications as shown by the system.

## B. Separately published app

A centre that wants its own icon and store entry needs a separate build **and a separate
publication**. Apple and Google treat it as a different app; none of the following can be shared with
the TypEase app or with another centre's app.

| Needed per centre | Why | Where it is set |
| --- | --- | --- |
| Application id (Android) and bundle id (iOS), e.g. `ae.alnoor.customer` | Identity of the app; fixed for its lifetime | `ORG=… tool/bootstrap.sh` when generating the platform folders, or later in `android/app/build.gradle(.kts)` (`applicationId`, `namespace`) and in Xcode (Bundle Identifier) |
| Signing: an Android upload keystore; an Apple distribution certificate and provisioning profile | Stores accept only signed builds, and updates must be signed with the same identity | `android/key.properties` + `signingConfigs`; Xcode "Signing & Capabilities". Never commit keystores or profiles (`.gitignore` excludes them) |
| A store account: Google Play Console and Apple Developer Program | The app is published under a legal entity. Apple in particular expects an app that represents a business to be published by that business (App Review guideline 4.2.6 on template apps); a provider can publish on the centre's behalf only from the **centre's** developer account | Outside this repository |
| Icons, launch screen, store listing (name, description, screenshots, privacy details, support URL) | Fixed per published app | `android/app/src/main/res/mipmap-*`, `ios/Runner/Assets.xcassets`, the store consoles |
| A Firebase project (or app entries in one) for push | Push credentials are tied to the application id / bundle id and, on iOS, to the APNs key of the Apple team | Firebase console; `FIREBASE_*` dart-defines or `google-services.json` / `GoogleService-Info.plist` |
| Link association files on the centre's portal host | Verified `https://` links open the app only if the host vouches for this exact app and signature | `https://<host>/.well-known/assetlinks.json` (Android: package name + SHA-256 of the signing certificate) and `/.well-known/apple-app-site-association` (iOS: Team ID + bundle id) |
| Store review for every release | Each app is reviewed on its own; a TypEase release is not automatically a release of the centre's app | Release process |

Plan for the ongoing cost: every TypEase release that should reach the centre's customers has to be
built, signed, uploaded and reviewed again for that app.

### Build configuration of a locked build

All configuration is passed with `--dart-define` (read in `lib/core/config/app_config.dart`):

| Define | Example | Effect |
| --- | --- | --- |
| `API_BASE_URL` | `https://api.typease.ae/api/v1` | Required in release builds. Without it the app shows a configuration error instead of guessing a server. |
| `TENANT_SLUG` | `alnoor` | **Locks the build** to this centre: centre selection and "Switch centre" disappear, and a link that names another centre is refused. The branding is still loaded from the API at run time. |
| `TENANT_HOST` | `portal.alnoor.ae` | Sent as `X-Tenant-Host` so the API resolves the tenant like the centre's own web portal does. Optional. |
| `PORTAL_BASE_URL` | `https://portal.alnoor.ae` | Return address after an online payment (the API accepts only the centre's portal origins). Optional. |
| `DEEP_LINK_SCHEME` | `alnoor` | Custom URL scheme of this app. Use a scheme of the centre's own so that its links do not open the TypEase app when both are installed. |
| `DEEP_LINK_HOSTS` | `portal.alnoor.ae` | https hosts whose links the app accepts. When set, links from other hosts are ignored. |
| `FIREBASE_ENABLED` and the four `FIREBASE_*` values | | Push for this app (see `README.md`, "Push notifications"). |

The native side must match: run the bootstrap with the same values once per app.

```bash
# once, in a separate checkout (or a separate copy of android/ and ios/) per published app
ORG=ae.alnoor APP_NAME="Al Noor Typing" DEEP_LINK_SCHEME=alnoor DEEP_LINK_HOSTS=portal.alnoor.ae \
  tool/bootstrap.sh

# every release
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://api.typease.ae/api/v1 \
  --dart-define=TENANT_SLUG=alnoor \
  --dart-define=TENANT_HOST=portal.alnoor.ae \
  --dart-define=PORTAL_BASE_URL=https://portal.alnoor.ae \
  --dart-define=DEEP_LINK_SCHEME=alnoor \
  --dart-define=DEEP_LINK_HOSTS=portal.alnoor.ae \
  --dart-define=APP_FLAVOR=prod
flutter build ipa --release  # same --dart-define values
```

Notes:

- `flutter create --org ae.alnoor --project-name typease_customer` produces the ids
  `ae.alnoor.typease_customer` (Android) and `ae.alnoor.typeaseCustomer` (iOS). Change them to the
  ids the centre registered before the first upload; they cannot be changed afterwards.
- The Dart package name stays `typease_customer` for every centre. It is not visible to customers.
- One checkout can hold only one `android/` and one `ios/` folder. Keep a branch, a separate
  checkout, or (preferably, once the first build exists) proper Android product flavors and iOS
  schemes per centre. Flavors are **not** set up by this repository: they live in the generated
  Gradle and Xcode files, which are not hand-written here.

### What stays shared

The Dart code, the translations, the API. A locked build still fetches name, logo and colours from
the API at start, so a rebrand of the in-app appearance needs no release; only icon, name and store
listing do.

## Choosing between the two

Start every centre on **A**. It costs nothing per centre, reaches the stores once, and the customer
sees the centre's branding from the first screen after choosing it. Offer **B** only to centres that
need their own store presence and accept owning a developer account, a review cycle and a release
process. Whether a centre is entitled to it is a commercial matter outside this app. The API reports
a centre's mode in the tenant configuration (`mode: "TYPEASE"` or `"WHITE_LABEL"`); the app does not
behave differently for the two values.

## Checklist for a separately published app

- [ ] The centre has (or delegated access to) a Google Play Console and an Apple Developer account.
- [ ] Application id and bundle id chosen and registered; they are final.
- [ ] `tool/bootstrap.sh` run with the centre's `ORG`, `APP_NAME`, `DEEP_LINK_SCHEME`, `DEEP_LINK_HOSTS`.
- [ ] Icons and launch screen replaced; no TypEase artwork left unless the contract allows it.
- [ ] Android keystore created and backed up; iOS signing configured.
- [ ] Firebase app entries created for both ids; APNs key uploaded; `FIREBASE_*` values recorded.
- [ ] `assetlinks.json` and `apple-app-site-association` published on the portal host and verified.
- [ ] The portal host is registered for the tenant, so `PORTAL_BASE_URL` is accepted as payment return address.
- [ ] Release built with `TENANT_SLUG` and tested: no centre selection, links of other centres refused.
- [ ] Store listings written in English and Arabic, with the centre's privacy policy and support contact.
- [ ] Data-safety (Google) and privacy-label (Apple) forms filled in: account data, identity documents
      and photos uploaded by the user, device token for push; no advertising or tracking SDKs.
- [ ] A named owner for future releases.
