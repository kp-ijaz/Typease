# Native configuration overlays

The `android/` and `ios/` folders are **generated** by `flutter create` (see `tool/bootstrap.sh`); their
Gradle and Xcode build files are not hand-written in this repository. The files in this folder are the
small pieces of native configuration the app needs on top of the Flutter template.

`apply_native_config.py` applies them. It is idempotent: every block it writes is wrapped in
`typease:begin <name>` / `typease:end <name>` comments and is replaced on the next run. If it cannot
find the place for a change it prints a `WARNING` naming the manual step, and exits with status 1.

> Status: the script was exercised against copies of the Flutter 3.24 manifest / plist / Gradle
> templates written from memory, not against real `flutter create` output. Read its output on the
> first run and compare the result with the table below.

```bash
python3 tool/native/apply_native_config.py            # defaults
APP_NAME="Al Noor Typing" DEEP_LINK_SCHEME=alnoor \
  DEEP_LINK_HOSTS=portal.alnoor.ae python3 tool/native/apply_native_config.py
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_NAME` | `TypEase` | Name under the icon (`android:label`, `CFBundleDisplayName`). |
| `DEEP_LINK_SCHEME` | `typease` | Custom URL scheme. Must equal the `DEEP_LINK_SCHEME` dart-define of the build. |
| `DEEP_LINK_HOSTS` | (none) | Comma-separated https hosts for Android App Links. |
| `ANDROID_MIN_SDK` | `23` | Minimum Android API level. |
| `IOS_MIN_VERSION` | `13.0` | Minimum iOS version. |

## What is applied, and why

### Android

| Snippet | Goes into | Why |
| --- | --- | --- |
| `android/manifest_permissions.xml` | `android/app/src/main/AndroidManifest.xml`, directly inside `<manifest>` | `INTERNET` (the Flutter template declares it for debug builds only) and `POST_NOTIFICATIONS` (Android 13+, push). `CAMERA` is deliberately **not** declared: `image_picker` uses the system camera app, which needs no permission unless the app declares one. |
| `android/manifest_activity.xml` | the same file, inside the main `<activity>` | Turns off Flutter's built-in deep-link handling (`flutter_deeplinking_enabled=false`, required by `app_links`) and registers the custom scheme `typease://…`. |
| `android/manifest_app_link_filter.xml` | repeated once per host of `DEEP_LINK_HOSTS`, inside the same block | `https://<host>/…` App Links with `autoVerify`. Verification needs `https://<host>/.well-known/assetlinks.json` (see `WHITE_LABEL_MOBILE.md`). Without that file the links still work, but Android asks the user which app should open them. |
| `android/manifest_queries.xml` | the same file, before `</manifest>` | Package visibility (Android 11+) for `url_launcher`: browser, phone dialler, email app. |
| `android/debug_manifest_application.xml` | `android/app/src/debug/AndroidManifest.xml` | `usesCleartextTraffic="true"` for **debug builds only**, so the emulator can reach a local API over plain http (`http://10.0.2.2:4000`). Release builds are not affected. |
| (no snippet) | `android/app/build.gradle` or `build.gradle.kts` | `minSdk` becomes `max(flutter.minSdkVersion, 23)`. API 23 is needed by `flutter_secure_storage` with `encryptedSharedPreferences` (refresh-token storage). |

`android/MainActivity.flag_secure.kt.txt` is **optional and not applied**: it blocks screenshots and the
app preview in the recent-apps list (`FLAG_SECURE`). See the file for how to enable it.

### iOS

| Key (from `ios/Info.plist.additions.xml`) | Why |
| --- | --- |
| `NSCameraUsageDescription` | Text of the camera permission prompt (photographing documents). Required by App Review; the app crashes on camera access without it. |
| `NSPhotoLibraryUsageDescription` | Text of the photo-library prompt (choosing a picture of a document). |
| `CFBundleURLTypes` | Custom URL scheme `typease://…`. |
| `FlutterDeepLinkingEnabled` = `false` | Links are handled by `app_links` and the app's own router. |
| `LSApplicationQueriesSchemes` | `url_launcher` (https, http, tel, mailto). |
| `NSAppTransportSecurity` → `NSAllowsLocalNetworking` | Plain http to hosts on the local network only, for a local API during development. App Transport Security stays on for everything else. A physical iPhone talking to a development API by LAN IP may additionally need a development-only exception; production must use https. |

Also changed: `CFBundleDisplayName` (app name), and the minimum iOS version in `ios/Podfile`
(`platform :ios`), `ios/Runner.xcodeproj/project.pbxproj` (`IPHONEOS_DEPLOYMENT_TARGET`) and
`ios/Flutter/AppFrameworkInfo.plist` (`MinimumOSVersion`). iOS 13.0 is what `firebase_core` 3.x and
`firebase_messaging` 15.x require. The `Podfile` only exists after `flutter pub get` on macOS; run the
script again afterwards if it reports that the file is missing.

## Not automated (needs Xcode, a signing identity or design assets)

| Topic | What to do |
| --- | --- |
| iOS Universal Links | Xcode → Runner → Signing & Capabilities → **Associated Domains** → `applinks:<portal-host>`. The host must serve `/.well-known/apple-app-site-association` with the app's Team ID and bundle id. Until then use the custom scheme. |
| iOS push | Xcode → Signing & Capabilities → **Push Notifications** and **Background Modes → Remote notifications**; upload an APNs key to the Firebase project. |
| Android / iOS Firebase files | Either pass the four `FIREBASE_*` dart-defines (no native file needed for messaging on Android), or add `google-services.json` / `GoogleService-Info.plist` and the Google Services Gradle plugin as described by FlutterFire. Both files are git-ignored. |
| Launcher icons, launch screen | Replace the generated placeholders in `android/app/src/main/res/mipmap-*` and `ios/Runner/Assets.xcassets`. |
| Release signing | Android: keystore + `android/key.properties` + `signingConfigs` in the app Gradle file. iOS: team, bundle id and provisioning in Xcode. |
| Application id / bundle id | Chosen by `flutter create --org <ORG>`; see `WHITE_LABEL_MOBILE.md` before changing it. |
