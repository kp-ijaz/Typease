import '../storage/token_store.dart';
import '../utils/json.dart';

/// Holds the tokens of the signed-in user.
///
/// * access token: memory only, sent as `Authorization: Bearer ...`;
/// * refresh token: platform keystore only (never shared_preferences, never logs).
class SessionManager {
  SessionManager(this._store);

  final TokenStore _store;

  String? _accessToken;
  DateTime? _accessTokenExpiresAt;
  bool _active = false;

  /// Called when the server no longer accepts the session.
  void Function()? onExpired;

  /// Called with the refresh response (`{ accessToken, session, ... }`) after
  /// a successful token refresh.
  void Function(JsonMap payload)? onRefreshed;

  String? get accessToken => _accessToken;

  /// True between sign-in (or a successful restore) and sign-out / expiry.
  bool get isActive => _active;

  /// True when there is no usable access token and one should be fetched
  /// before sending an authenticated request.
  bool get needsRefresh {
    if (!_active) return false;
    final token = _accessToken;
    final expiresAt = _accessTokenExpiresAt;
    if (token == null) return true;
    if (expiresAt == null) return false;
    return !DateTime.now().isBefore(expiresAt);
  }

  Future<String?> readRefreshToken() => _store.readRefreshToken();

  /// Marks the session as active without an access token (used on start when
  /// a refresh token was found in the keystore).
  void markRestorable() {
    _active = true;
  }

  Future<void> setTokens({required String accessToken, required String refreshToken, int? expiresInSeconds}) async {
    _accessToken = accessToken;
    _active = true;
    if (expiresInSeconds != null && expiresInSeconds > 0) {
      // Refresh a little early so a request is not sent with a token that
      // expires while it is on its way.
      final seconds = expiresInSeconds > 60 ? expiresInSeconds - 30 : expiresInSeconds;
      _accessTokenExpiresAt = DateTime.now().add(Duration(seconds: seconds));
    } else {
      _accessTokenExpiresAt = null;
    }
    await _store.writeRefreshToken(refreshToken);
  }

  void notifyRefreshed(JsonMap payload) {
    final callback = onRefreshed;
    if (callback != null) callback(payload);
  }

  /// Sign-out by the user: forget everything locally.
  Future<void> clear() async {
    _accessToken = null;
    _accessTokenExpiresAt = null;
    _active = false;
    await _store.clear();
  }

  /// The server rejected the session: forget it and tell the app.
  Future<void> expire() async {
    final wasActive = _active;
    await clear();
    final callback = onExpired;
    if (wasActive && callback != null) callback();
  }
}
