/// Makes token refresh single-flight.
///
/// Refresh tokens rotate on every use, and presenting an already-used token
/// revokes the whole session on the server. When several requests fail with
/// 401 at the same moment, exactly ONE refresh call may be sent; every waiting
/// request receives the result of that call.
class TokenRefresher {
  TokenRefresher(this._performRefresh);

  /// Performs the refresh and returns the new access token, or null when the
  /// session could not be renewed (the user has to sign in again). May throw
  /// for transport failures, in which case the session is left untouched.
  final Future<String?> Function() _performRefresh;

  Future<String?>? _inFlight;

  bool get isRefreshing => _inFlight != null;

  Future<String?> refresh() {
    final running = _inFlight;
    if (running != null) return running;
    final future = _run();
    _inFlight = future;
    return future;
  }

  Future<String?> _run() async {
    try {
      return await _performRefresh();
    } finally {
      _inFlight = null;
    }
  }
}
