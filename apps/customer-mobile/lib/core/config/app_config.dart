import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

/// Build-time configuration, read from `--dart-define` values.
///
/// Nothing here is tenant branding. The only tenant-related values are the
/// optional build lock ([tenantSlug]) and the optional white-label hosts,
/// which exist for separately published store builds
/// (see WHITE_LABEL_MOBILE.md).
@immutable
class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    required this.tenantSlug,
    required this.tenantHost,
    required this.portalBaseUrl,
    required this.deepLinkScheme,
    required this.deepLinkHosts,
    required this.flavor,
    required this.firebaseEnabled,
    required this.firebaseApiKey,
    required this.firebaseAppId,
    required this.firebaseMessagingSenderId,
    required this.firebaseProjectId,
  });

  /// Reads every value from the compilation environment.
  factory AppConfig.fromEnvironment() {
    const rawBase = String.fromEnvironment('API_BASE_URL');
    const slug = String.fromEnvironment('TENANT_SLUG');
    const host = String.fromEnvironment('TENANT_HOST');
    const portal = String.fromEnvironment('PORTAL_BASE_URL');
    const scheme = String.fromEnvironment('DEEP_LINK_SCHEME', defaultValue: 'typease');
    const hosts = String.fromEnvironment('DEEP_LINK_HOSTS');
    const flavor = String.fromEnvironment('APP_FLAVOR', defaultValue: 'dev');
    const firebaseEnabled = bool.fromEnvironment('FIREBASE_ENABLED');
    const firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY');
    const firebaseAppId = String.fromEnvironment('FIREBASE_APP_ID');
    const firebaseSender = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
    const firebaseProject = String.fromEnvironment('FIREBASE_PROJECT_ID');

    return AppConfig(
      apiBaseUrl: resolveApiBaseUrl(rawBase, isRelease: kReleaseMode, isAndroid: _isAndroid()),
      tenantSlug: slug.trim().toLowerCase(),
      tenantHost: host.trim().toLowerCase(),
      portalBaseUrl: _stripTrailingSlash(portal.trim()),
      deepLinkScheme: scheme.trim().toLowerCase(),
      deepLinkHosts: hosts
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .where((h) => h.isNotEmpty)
          .toList(growable: false),
      flavor: flavor,
      firebaseEnabled: firebaseEnabled,
      firebaseApiKey: firebaseApiKey,
      firebaseAppId: firebaseAppId,
      firebaseMessagingSenderId: firebaseSender,
      firebaseProjectId: firebaseProject,
    );
  }

  /// Base URL of the REST API including the `/api/v1` prefix. Empty when a
  /// release build was made without `API_BASE_URL` (the app then shows a
  /// configuration error instead of guessing a server).
  final String apiBaseUrl;

  /// Build-time lock for store-published white-label builds. Empty = the user
  /// chooses the centre at first launch.
  final String tenantSlug;

  /// Portal host of a white-label build, sent as `X-Tenant-Host`. Optional.
  final String tenantHost;

  /// Origin of the centre's customer web portal (e.g. `https://portal.example.ae`).
  /// Used as the return address after an online payment. Optional.
  final String portalBaseUrl;

  /// Custom URL scheme for deep links (default `typease`).
  final String deepLinkScheme;

  /// HTTPS hosts whose links the app accepts as portal links.
  final List<String> deepLinkHosts;

  /// `dev`, `staging` or `prod`. Informational (shown in Settings).
  final String flavor;

  final bool firebaseEnabled;
  final String firebaseApiKey;
  final String firebaseAppId;
  final String firebaseMessagingSenderId;
  final String firebaseProjectId;

  bool get isConfigured => apiBaseUrl.isNotEmpty;
  bool get isTenantLocked => tenantSlug.isNotEmpty;

  /// True when all values needed for `FirebaseOptions` were passed as dart-defines.
  bool get hasExplicitFirebaseOptions =>
      firebaseApiKey.isNotEmpty &&
      firebaseAppId.isNotEmpty &&
      firebaseMessagingSenderId.isNotEmpty &&
      firebaseProjectId.isNotEmpty;

  /// Decides the API base URL. Visible for tests.
  static String resolveApiBaseUrl(String raw, {required bool isRelease, required bool isAndroid}) {
    final value = _stripTrailingSlash(raw.trim());
    if (value.isNotEmpty) return value;
    // A release build must be told where the API is.
    if (isRelease) return '';
    // Debug convenience: the Android emulator reaches the host machine on 10.0.2.2.
    return isAndroid ? 'http://10.0.2.2:4000/api/v1' : 'http://localhost:4000/api/v1';
  }

  static String _stripTrailingSlash(String value) {
    var out = value;
    while (out.endsWith('/')) {
      out = out.substring(0, out.length - 1);
    }
    return out;
  }

  static bool _isAndroid() {
    if (kIsWeb) return false;
    try {
      return Platform.isAndroid;
    } catch (_) {
      return false;
    }
  }
}
