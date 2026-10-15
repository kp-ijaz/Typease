import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers.dart';
import '../../../core/routing/redirect_logic.dart';
import '../../settings/application/settings_controller.dart';
import '../../tenant/application/tenant_controller.dart';
import 'auth_controller.dart';

/// Start-up work: load the centre configuration and restore the session.
///
/// Completes normally when the app can proceed (signed in or not). Fails with
/// an `ApiException` when the server could not be reached and nothing usable
/// is cached; the splash screen then offers "Try again"
/// (`ref.invalidate(bootstrapProvider)`).
final bootstrapProvider = FutureProvider<void>((ref) async {
  // Let provider initialisation finish before other providers are modified.
  await Future<void>.delayed(Duration.zero);
  final config = ref.read(appConfigProvider);
  if (!config.isConfigured) return;
  await ref.read(tenantControllerProvider.notifier).initialise();
  await ref.read(authControllerProvider.notifier).restore();
});

/// The current gate, derived from configuration, start-up, preferences,
/// centre selection and sign-in state.
final appGateProvider = Provider<AppGate>((ref) {
  final config = ref.watch(appConfigProvider);
  if (!config.isConfigured) return AppGate.configError;
  final boot = ref.watch(bootstrapProvider);
  if (boot.isLoading) return AppGate.booting;
  if (boot.hasError) return AppGate.bootError;
  final preferences = ref.watch(settingsControllerProvider);
  if (!preferences.onboardingSeen) return AppGate.needsOnboarding;
  final tenant = ref.watch(tenantControllerProvider);
  final auth = ref.watch(authControllerProvider);
  if (auth.isSignedIn) return AppGate.signedIn;
  if (tenant == null) return AppGate.needsCentre;
  return AppGate.signedOut;
});
