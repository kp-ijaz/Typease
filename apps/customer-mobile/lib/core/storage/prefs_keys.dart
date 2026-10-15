/// Keys of the NON-sensitive preferences kept in shared_preferences.
/// Tokens are never stored here (see `token_store.dart`).
class PrefsKeys {
  const PrefsKeys._();

  static const String onboardingSeen = 'onboarding_seen';
  static const String languageCode = 'language_code';
  static const String themeMode = 'theme_mode';
  static const String tenantSlug = 'tenant_slug';
  static const String tenantConfigJson = 'tenant_config_json';
  static const String pushDeviceToken = 'push_device_token';

  /// Who signed in last on this device: pre-fills the sign-in form and greets
  /// them by name. Kept after signing out, like the email on most apps.
  static const String lastSignInEmail = 'last_sign_in_email';
  static const String lastSignInName = 'last_sign_in_name';
}
