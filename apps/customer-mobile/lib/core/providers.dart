import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../features/settings/application/settings_controller.dart';
import 'config/app_config.dart';
import 'network/api_client.dart';
import 'network/session_manager.dart';
import 'network/url_rewriter.dart';
import 'storage/token_store.dart';

/// Build-time configuration. Overridden in tests.
final appConfigProvider = Provider<AppConfig>((ref) => AppConfig.fromEnvironment());

/// Overridden in `main()` with the instance loaded before `runApp`.
final sharedPreferencesProvider = Provider<SharedPreferences>((ref) {
  throw UnimplementedError('sharedPreferencesProvider must be overridden in main()');
});

/// Refresh-token storage. Overridden with [MemoryTokenStore] in tests.
final tokenStoreProvider = Provider<TokenStore>((ref) => SecureTokenStore());

final sessionManagerProvider = Provider<SessionManager>((ref) {
  return SessionManager(ref.watch(tokenStoreProvider));
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final config = ref.watch(appConfigProvider);
  return ApiClient(
    baseUrl: config.apiBaseUrl,
    session: ref.watch(sessionManagerProvider),
    tenantHost: config.tenantHost,
    // Read lazily on every request so a language change applies at once
    // without rebuilding the client.
    languageCode: () => ref.read(settingsControllerProvider).languageCode,
  );
});

final urlRewriterProvider = Provider<UrlRewriter>((ref) {
  return UrlRewriter(ref.watch(appConfigProvider).apiBaseUrl);
});
