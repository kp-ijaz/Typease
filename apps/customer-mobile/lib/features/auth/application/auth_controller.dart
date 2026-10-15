import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/providers.dart';
import '../../../core/storage/prefs_keys.dart';
import '../../../core/utils/json.dart';
import '../../notifications/application/push_controller.dart';
import '../../tenant/application/tenant_controller.dart';
import '../data/auth_models.dart';
import '../data/auth_repository.dart';

enum AuthStatus { unknown, signedOut, signedIn }

@immutable
class AuthState {
  const AuthState({required this.status, this.session, this.sessionExpired = false});

  const AuthState.unknown() : this(status: AuthStatus.unknown);
  const AuthState.signedOut({bool expired = false}) : this(status: AuthStatus.signedOut, sessionExpired: expired);

  final AuthStatus status;
  final SessionInfo? session;

  /// True when the user was signed out because the server ended the session.
  /// The sign-in screen shows a message for it.
  final bool sessionExpired;

  bool get isSignedIn => status == AuthStatus.signedIn && session != null;
}

/// Thrown when a successful sign-in cannot be used by this app.
class SignInRejected implements Exception {
  const SignInRejected(this.reasonKey);

  /// Localisation key of the explanation.
  final String reasonKey;
}

/// Owns "who is signed in". Tokens themselves live in the SessionManager.
class AuthController extends Notifier<AuthState> {
  @override
  AuthState build() {
    final manager = ref.watch(sessionManagerProvider);
    manager.onExpired = _onSessionExpired;
    manager.onRefreshed = _onTokensRefreshed;
    ref.onDispose(() {
      manager.onExpired = null;
      manager.onRefreshed = null;
    });
    return const AuthState.unknown();
  }

  void _onSessionExpired() {
    state = const AuthState.signedOut(expired: true);
  }

  void _onTokensRefreshed(JsonMap payload) {
    final session = asMapOrNull(payload['session']);
    if (session == null) return;
    state = AuthState(status: AuthStatus.signedIn, session: SessionInfo.fromJson(session));
  }

  /// Restores the previous session from the refresh token in the keystore.
  /// Throws [ApiException] when the server cannot be reached, so the splash
  /// screen can offer "Try again" instead of signing the user out.
  Future<void> restore() async {
    final manager = ref.read(sessionManagerProvider);
    final stored = await manager.readRefreshToken();
    if (stored == null || stored.isEmpty) {
      state = const AuthState.signedOut();
      return;
    }
    manager.markRestorable();
    // On success the state is set by _onTokensRefreshed; when the stored
    // token is no longer accepted, by _onSessionExpired.
    await ref.read(apiClientProvider).refreshAccessToken();
    if (state.status == AuthStatus.unknown) {
      state = const AuthState.signedOut();
    }
    // iOS keeps the keychain (the session) when the app is reinstalled, but
    // not the stored centre: load the session's branding as sign-in does.
    final slug = state.session?.tenant?.slug ?? '';
    if (state.isSignedIn && slug.isNotEmpty && ref.read(tenantControllerProvider)?.slug != slug) {
      try {
        await ref.read(tenantControllerProvider.notifier).ensure(slug);
      } catch (_) {
        // The default branding is used until the next start.
      }
    }
  }

  /// Stores the tokens of a completed sign-in and marks the user as signed in.
  Future<void> acceptLogin(LoginResult result) async {
    final session = result.session;
    final access = result.accessToken;
    final refresh = result.refreshToken;
    if (!result.hasTokens || session == null || access == null || refresh == null) {
      throw const ApiException(kind: ApiErrorKind.unknown, code: 'INCOMPLETE_LOGIN', message: '');
    }
    final manager = ref.read(sessionManagerProvider);
    if (!session.isPortalMember) {
      // Staff accounts are for the centre web application. End the session
      // that was just created so it does not linger on the server.
      try {
        await ref.read(authRepositoryProvider).logout(refresh);
      } catch (_) {
        // Best effort.
      }
      throw const SignInRejected('loginStaffNotSupported');
    }
    await manager.setTokens(accessToken: access, refreshToken: refresh, expiresInSeconds: result.expiresIn);
    final slug = session.tenant?.slug ?? '';
    try {
      await ref.read(tenantControllerProvider.notifier).ensure(slug);
    } catch (_) {
      // The branding of the centre could not be loaded right now; the user is
      // signed in all the same and the cached / default branding is used.
    }
    final prefs = ref.read(sharedPreferencesProvider);
    await prefs.setString(PrefsKeys.lastSignInEmail, session.user.email);
    await prefs.setString(PrefsKeys.lastSignInName, session.user.firstName);
    state = AuthState(status: AuthStatus.signedIn, session: session);
  }

  /// Reloads the session (after verifying the phone, changing the name, ...).
  Future<void> reloadSession() async {
    if (!state.isSignedIn) return;
    final session = await ref.read(authRepositoryProvider).me();
    state = AuthState(status: AuthStatus.signedIn, session: session);
  }

  /// Signs out on this device and ends the session on the server.
  Future<void> signOut() async {
    final manager = ref.read(sessionManagerProvider);
    // The push token is removed first, while the session can still authorise it.
    await ref.read(pushControllerProvider.notifier).unregisterDevice();
    final refresh = await manager.readRefreshToken();
    if (refresh != null && refresh.isNotEmpty) {
      try {
        await ref.read(authRepositoryProvider).logout(refresh);
      } catch (_) {
        // Offline: the local session is removed regardless; the server-side
        // session ends when its refresh token expires.
      }
    }
    await manager.clear();
    state = const AuthState.signedOut();
  }

  /// Removes the "your session has ended" notice once it has been shown.
  void acknowledgeExpiry() {
    if (state.status == AuthStatus.signedOut && state.sessionExpired) {
      state = const AuthState.signedOut();
    }
  }
}

final authControllerProvider = NotifierProvider<AuthController, AuthState>(AuthController.new);

/// The signed-in session, or null.
final sessionProvider = Provider<SessionInfo?>((ref) => ref.watch(authControllerProvider).session);
