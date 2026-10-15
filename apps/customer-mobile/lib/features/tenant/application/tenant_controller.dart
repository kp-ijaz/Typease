import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/providers.dart';
import '../../settings/application/settings_controller.dart';
import '../data/tenant_config.dart';
import '../data/tenant_repository.dart';

/// The centre the app is currently showing, or null before one is chosen.
///
/// The configuration is resolved from the server (never compiled in), cached
/// for the next start, and refreshed on every start.
class TenantController extends Notifier<TenantConfig?> {
  @override
  TenantConfig? build() {
    final config = ref.watch(appConfigProvider);
    final cached = ref.watch(tenantRepositoryProvider).readCached();
    if (cached == null) return null;
    // A locked build only ever shows its own centre.
    if (config.isTenantLocked && cached.slug != config.tenantSlug) return null;
    return cached;
  }

  bool get isLocked => ref.read(appConfigProvider).isTenantLocked;

  /// Called once on start. Loads the locked centre when nothing is cached yet
  /// and refreshes a cached configuration in the background.
  Future<void> initialise() async {
    final config = ref.read(appConfigProvider);
    final current = state;
    final slug = config.isTenantLocked ? config.tenantSlug : current?.slug;
    if (slug == null || slug.isEmpty) return;
    if (current != null) {
      _applyDefaults(current);
      unawaited(_refreshQuietly(slug));
      return;
    }
    await select(slug);
  }

  /// Verifies [slug] with the server and makes that centre the current one.
  /// Throws [ApiException] (404 `NOT_FOUND` for an unknown code).
  Future<TenantConfig> select(String slug) async {
    final config = ref.read(appConfigProvider);
    final normalised = slug.trim().toLowerCase();
    if (config.isTenantLocked && normalised != config.tenantSlug) {
      throw const ApiException(kind: ApiErrorKind.forbidden, code: 'TENANT_LOCKED', message: '');
    }
    final fetched = await ref.read(tenantRepositoryProvider).fetchBySlug(normalised);
    await _store(fetched);
    return fetched;
  }

  /// Resolves the centre behind a portal host (custom domain link).
  Future<TenantConfig> selectByHost(String host) async {
    final config = ref.read(appConfigProvider);
    final fetched = await ref.read(tenantRepositoryProvider).fetchByHost(host);
    if (config.isTenantLocked && fetched.slug != config.tenantSlug) {
      throw const ApiException(kind: ApiErrorKind.forbidden, code: 'TENANT_LOCKED', message: '');
    }
    await _store(fetched);
    return fetched;
  }

  /// Makes sure the current centre is [slug] (used after sign-in through an
  /// invitation, where the session tells which centre it belongs to).
  Future<void> ensure(String slug) async {
    if (slug.isEmpty || state?.slug == slug) return;
    await select(slug);
  }

  /// Forgets the selected centre ("Switch centre"). Not available in locked builds.
  Future<void> clear() async {
    if (isLocked) return;
    await ref.read(tenantRepositoryProvider).clearCache();
    state = null;
  }

  Future<void> _store(TenantConfig config) async {
    await ref.read(tenantRepositoryProvider).writeCache(config);
    state = config;
    _applyDefaults(config);
  }

  void _applyDefaults(TenantConfig config) {
    ref.read(settingsControllerProvider.notifier).applyTenantDefaultLanguage(config.defaultLanguage);
  }

  Future<void> _refreshQuietly(String slug) async {
    try {
      final fresh = await ref.read(tenantRepositoryProvider).fetchBySlug(slug);
      await _store(fresh);
    } on ApiException catch (error) {
      // The centre no longer exists: ask the user to choose again (unless the
      // build is locked, in which case the cached branding stays).
      if (error.statusCode == 404 && !isLocked) {
        await clear();
      }
    } catch (_) {
      // Offline or similar: keep the cached configuration.
    }
  }
}

final tenantControllerProvider = NotifierProvider<TenantController, TenantConfig?>(TenantController.new);
