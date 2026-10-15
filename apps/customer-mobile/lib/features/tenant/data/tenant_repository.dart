import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/network/api_client.dart';
import '../../../core/providers.dart';
import '../../../core/storage/prefs_keys.dart';
import 'tenant_config.dart';

class TenantRepository {
  TenantRepository(this._api, this._prefs);

  final ApiClient _api;
  final SharedPreferences _prefs;

  /// `GET /public/tenant-config?slug=`
  Future<TenantConfig> fetchBySlug(String slug) async {
    final json = await _api.get('/public/tenant-config', query: <String, dynamic>{'slug': slug}, auth: false);
    return _checked(TenantConfig.fromJson(json));
  }

  /// `GET /public/tenant-config?host=` - resolves a centre from the host of
  /// a portal link (white-label custom domains).
  Future<TenantConfig> fetchByHost(String host) async {
    final json = await _api.get('/public/tenant-config', query: <String, dynamic>{'host': host}, auth: false);
    return _checked(TenantConfig.fromJson(json));
  }

  TenantConfig _checked(TenantConfig config) {
    if (!config.isValid) {
      throw const ApiException(kind: ApiErrorKind.unknown, code: 'INVALID_TENANT_CONFIG', message: '');
    }
    return config;
  }

  /// The configuration saved on the last successful load, if any. Branding is
  /// public information, so it is kept in ordinary preferences.
  TenantConfig? readCached() {
    final raw = _prefs.getString(PrefsKeys.tenantConfigJson);
    if (raw == null || raw.isEmpty) return null;
    try {
      final config = TenantConfig.fromJson(jsonDecode(raw));
      return config.isValid ? config : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> writeCache(TenantConfig config) async {
    await _prefs.setString(PrefsKeys.tenantSlug, config.slug);
    await _prefs.setString(PrefsKeys.tenantConfigJson, jsonEncode(config.toJson()));
  }

  Future<void> clearCache() async {
    await _prefs.remove(PrefsKeys.tenantSlug);
    await _prefs.remove(PrefsKeys.tenantConfigJson);
  }
}

final tenantRepositoryProvider = Provider<TenantRepository>((ref) {
  return TenantRepository(ref.watch(apiClientProvider), ref.watch(sharedPreferencesProvider));
});
