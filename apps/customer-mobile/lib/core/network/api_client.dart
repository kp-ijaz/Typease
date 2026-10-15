import 'package:dio/dio.dart';

import '../errors/api_exception.dart';
import '../utils/json.dart';
import 'session_manager.dart';
import 'token_refresher.dart';

/// Marks a request that must be sent without a bearer token and must never
/// trigger a token refresh (sign-in, registration, public endpoints).
const String kSkipAuth = 'skipAuth';
const String _kRetried = 'retried';

/// The one HTTP client of the app.
///
/// Responsibilities:
///  * headers: `Authorization`, `X-Client-App: mobile`, `Accept-Language`,
///    `X-Tenant-Host` (white-label builds);
///  * single-flight token refresh on 401 and replay of the failed request;
///  * session expiry: tells [SessionManager], which returns the user to sign-in;
///  * mapping of every failure to a typed [ApiException].
class ApiClient {
  ApiClient({
    required String baseUrl,
    required SessionManager session,
    required String Function() languageCode,
    String tenantHost = '',
    HttpClientAdapter? adapter,
  })  : _session = session,
        _languageCode = languageCode,
        _tenantHost = tenantHost {
    final options = BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 15),
      sendTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      contentType: Headers.jsonContentType,
      responseType: ResponseType.json,
    );
    _dio = Dio(options);
    // The refresh call uses its own client without interceptors, so that it
    // can never recurse into itself.
    _plain = Dio(options.copyWith());
    if (adapter != null) {
      _dio.httpClientAdapter = adapter;
      _plain.httpClientAdapter = adapter;
    }
    _refresher = TokenRefresher(_performRefresh);
    _dio.interceptors.add(_AuthInterceptor(this));
  }

  final SessionManager _session;
  final String Function() _languageCode;
  final String _tenantHost;
  late final Dio _dio;
  late final Dio _plain;
  late final TokenRefresher _refresher;

  SessionManager get session => _session;

  // ------------------------------------------------------------------ verbs

  Future<dynamic> get(String path, {Map<String, dynamic>? query, bool auth = true}) {
    return _send('GET', path, query: query, auth: auth);
  }

  Future<dynamic> post(String path, {Object? body, Map<String, dynamic>? query, bool auth = true}) {
    return _send('POST', path, body: body, query: query, auth: auth);
  }

  Future<dynamic> put(String path, {Object? body, bool auth = true}) {
    return _send('PUT', path, body: body, auth: auth);
  }

  Future<dynamic> patch(String path, {Object? body, bool auth = true}) {
    return _send('PATCH', path, body: body, auth: auth);
  }

  Future<dynamic> delete(String path, {Object? body, bool auth = true}) {
    return _send('DELETE', path, body: body, auth: auth);
  }

  /// Renews the access token with the stored refresh token (single-flight).
  /// Returns null when the session is gone; throws [ApiException] when the
  /// server could not be reached (the session is then kept).
  Future<String?> refreshAccessToken() async {
    try {
      return await _refresher.refresh();
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }

  Future<dynamic> _send(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    required bool auth,
  }) async {
    try {
      final response = await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: _clean(query),
        options: Options(method: method, extra: <String, dynamic>{kSkipAuth: !auth}),
      );
      return response.data;
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }

  /// Drops null and empty values so they are not sent as `?q=&status=`.
  static Map<String, dynamic>? _clean(Map<String, dynamic>? query) {
    if (query == null) return null;
    final out = <String, dynamic>{};
    query.forEach((key, value) {
      if (value == null) return;
      if (value is String && value.isEmpty) return;
      out[key] = value;
    });
    return out;
  }

  Map<String, String> _commonHeaders() {
    final headers = <String, String>{
      'X-Client-App': 'mobile',
      'Accept-Language': _languageCode(),
    };
    if (_tenantHost.isNotEmpty) headers['X-Tenant-Host'] = _tenantHost;
    return headers;
  }

  /// The single place where `POST /auth/refresh` is called.
  Future<String?> _performRefresh() async {
    final refreshToken = await _session.readRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      await _session.expire();
      return null;
    }
    try {
      final response = await _plain.post<dynamic>(
        '/auth/refresh',
        data: <String, dynamic>{'refreshToken': refreshToken, 'app': 'mobile'},
        options: Options(headers: _commonHeaders()),
      );
      final payload = asMap(response.data);
      final access = asStringOrNull(payload['accessToken']);
      final nextRefresh = asStringOrNull(payload['refreshToken']);
      if (access == null || access.isEmpty || nextRefresh == null || nextRefresh.isEmpty) {
        await _session.expire();
        return null;
      }
      await _session.setTokens(
        accessToken: access,
        refreshToken: nextRefresh,
        expiresInSeconds: asIntOrNull(payload['expiresIn']),
      );
      _session.notifyRefreshed(payload);
      return access;
    } on DioException catch (error) {
      final status = error.response?.statusCode;
      if (status == 400 || status == 401 || status == 403) {
        // The refresh token is unknown, expired, revoked or was used before.
        await _session.expire();
        return null;
      }
      // Offline, time-out or a server problem: keep the session and let the
      // caller show a connection message.
      rethrow;
    }
  }
}

class _AuthInterceptor extends Interceptor {
  _AuthInterceptor(this._client);

  final ApiClient _client;

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    options.headers.addAll(_client._commonHeaders());
    final skipAuth = options.extra[kSkipAuth] == true;
    if (!skipAuth) {
      final session = _client._session;
      String? token = session.accessToken;
      if (session.needsRefresh && options.extra[_kRetried] != true) {
        try {
          token = await _client._refresher.refresh();
        } on DioException catch (error) {
          handler.reject(error.copyWith(requestOptions: options));
          return;
        }
      }
      if (token != null && token.isNotEmpty) {
        options.headers['Authorization'] = 'Bearer $token';
      }
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;
    final status = err.response?.statusCode;
    final skipAuth = options.extra[kSkipAuth] == true;
    final alreadyRetried = options.extra[_kRetried] == true;
    if (status != 401 || skipAuth || alreadyRetried) {
      handler.next(err);
      return;
    }

    final session = _client._session;
    final code = asStringOrNull(asMap(err.response?.data)['code']);
    if (code == 'SESSION_EXPIRED') {
      // The server has already ended the session; a refresh cannot help.
      await session.expire();
      handler.next(err);
      return;
    }

    try {
      final sent = options.headers['Authorization'];
      final current = session.accessToken;
      String? token;
      if (current != null && sent != 'Bearer $current') {
        // Another request refreshed the token while this one was in flight.
        token = current;
      } else {
        token = await _client._refresher.refresh();
      }
      if (token == null || token.isEmpty) {
        handler.next(err);
        return;
      }
      options.extra[_kRetried] = true;
      options.headers['Authorization'] = 'Bearer $token';
      final response = await _client._dio.fetch<dynamic>(options);
      handler.resolve(response);
    } on DioException catch (error) {
      handler.next(error);
    } catch (_) {
      handler.next(err);
    }
  }
}
