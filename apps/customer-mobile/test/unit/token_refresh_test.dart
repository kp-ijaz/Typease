// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/errors/api_exception.dart';
import 'package:typease_customer/core/network/api_client.dart';
import 'package:typease_customer/core/network/session_manager.dart';
import 'package:typease_customer/core/network/token_refresher.dart';
import 'package:typease_customer/core/storage/token_store.dart';

import '../support/fake_adapter.dart';
import '../support/fixtures.dart';

/// A fake TypEase API with rotating refresh tokens:
///  * `POST /auth/refresh` accepts only the CURRENT refresh token, answers with
///    a new pair and invalidates the old one;
///  * presenting an old refresh token ends the session (as the real API does);
///  * every other path needs the current access token, otherwise 401 `TOKEN_INVALID`.
class FakeTypEaseServer {
  String accessToken = 'access-1';
  String refreshToken = 'refresh-1';
  int generation = 1;
  bool sessionRevoked = false;
  bool refreshOffline = false;
  Duration refreshDelay = const Duration(milliseconds: 30);

  late final FakeAdapter adapter = FakeAdapter(_handle);

  Future<FakeResponse> _handle(RecordedRequest request) async {
    if (request.path.endsWith('/auth/refresh')) {
      // Give the other failed requests time to arrive while the refresh is running.
      await Future<void>.delayed(refreshDelay);
      if (refreshOffline) offline();
      final body = request.data;
      final presented = body is Map ? body['refreshToken'] : null;
      if (sessionRevoked || presented != refreshToken) {
        sessionRevoked = true;
        return FakeResponse(401, apiError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.'));
      }
      generation += 1;
      accessToken = 'access-$generation';
      refreshToken = 'refresh-$generation';
      // The real refresh response, with this server's tokens.
      final payload = Map<String, dynamic>.of(fixture('refresh') as Map<String, dynamic>);
      payload['accessToken'] = accessToken;
      payload['refreshToken'] = refreshToken;
      return FakeResponse(200, payload);
    }
    if (request.path.endsWith('/auth/login')) {
      return FakeResponse(401, apiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.'));
    }
    if (sessionRevoked) {
      return FakeResponse(401, apiError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.'));
    }
    if (request.authorization != 'Bearer $accessToken') {
      return FakeResponse(401, apiError(401, 'TOKEN_INVALID', 'Your session has expired. Please sign in again.'));
    }
    return FakeResponse(200, <String, dynamic>{'path': request.path, 'ok': true});
  }
}

class Harness {
  Harness({String? storedRefreshToken = 'refresh-1', String tenantHost = ''})
      : store = MemoryTokenStore(storedRefreshToken),
        server = FakeTypEaseServer() {
    session = SessionManager(store);
    session.onExpired = () => expiredCalls += 1;
    session.onRefreshed = (payload) => refreshedPayloads.add(payload);
    client = ApiClient(
      baseUrl: 'https://api.example.test/api/v1',
      session: session,
      languageCode: () => language,
      tenantHost: tenantHost,
      adapter: server.adapter,
    );
  }

  final MemoryTokenStore store;
  final FakeTypEaseServer server;
  late final SessionManager session;
  late final ApiClient client;
  String language = 'en';
  int expiredCalls = 0;
  final List<Map<String, dynamic>> refreshedPayloads = <Map<String, dynamic>>[];

  int get refreshCalls => server.adapter.count('POST', '/auth/refresh');
}

void main() {
  group('TokenRefresher', () {
    test('runs one refresh for any number of simultaneous callers', () async {
      var runs = 0;
      final gate = Completer<String?>();
      final refresher = TokenRefresher(() {
        runs += 1;
        return gate.future;
      });
      final first = refresher.refresh();
      final second = refresher.refresh();
      final third = refresher.refresh();
      expect(refresher.isRefreshing, isTrue);
      gate.complete('new-token');
      expect(await Future.wait(<Future<String?>>[first, second, third]), <String?>['new-token', 'new-token', 'new-token']);
      expect(runs, 1);
      expect(refresher.isRefreshing, isFalse);
    });

    test('starts a new refresh after the previous one finished', () async {
      var runs = 0;
      final refresher = TokenRefresher(() async {
        runs += 1;
        return 'token-$runs';
      });
      expect(await refresher.refresh(), 'token-1');
      expect(await refresher.refresh(), 'token-2');
    });

    test('a failed refresh is reported to every waiting caller and does not block the next one', () async {
      var runs = 0;
      final refresher = TokenRefresher(() async {
        runs += 1;
        if (runs == 1) throw StateError('offline');
        return 'token';
      });
      final first = refresher.refresh();
      final second = refresher.refresh();
      await expectLater(first, throwsStateError);
      await expectLater(second, throwsStateError);
      expect(await refresher.refresh(), 'token');
      expect(runs, 2);
    });
  });

  group('ApiClient token refresh', () {
    test('three requests failing with 401 at the same time cause exactly ONE refresh and are all replayed', () async {
      final h = Harness();
      // The device holds an access token the server no longer accepts.
      await h.session.setTokens(accessToken: 'stale-access', refreshToken: 'refresh-1', expiresInSeconds: 900);

      final results = await Future.wait(<Future<dynamic>>[
        h.client.get('/requests'),
        h.client.get('/me/notifications'),
        h.client.get('/invoices'),
      ]);

      expect(h.refreshCalls, 1, reason: 'refresh tokens rotate; a second refresh would present a used token');
      expect(results.map((r) => (r as Map)['ok']), <bool>[true, true, true]);
      expect(h.session.accessToken, 'access-2');
      expect(await h.store.readRefreshToken(), 'refresh-2');
      expect(h.expiredCalls, 0);
      expect(h.server.sessionRevoked, isFalse);
      // 3 rejected + 1 refresh + 3 replayed.
      expect(h.server.adapter.requests.length, 7);
      // The refresh response (with the session) is handed to the app.
      expect(h.refreshedPayloads.length, 1);
      expect(h.refreshedPayloads.single['session'], isA<Map<dynamic, dynamic>>());
    });

    test('the refresh call sends the stored token and app "mobile", without a bearer token', () async {
      final h = Harness();
      await h.session.setTokens(accessToken: 'stale-access', refreshToken: 'refresh-1');
      await h.client.get('/requests');
      final refresh = h.server.adapter.requests.firstWhere((r) => r.path.endsWith('/auth/refresh'));
      expect(refresh.data, <String, dynamic>{'refreshToken': 'refresh-1', 'app': 'mobile'});
      expect(refresh.authorization, isNull);
      expect(refresh.header('X-Client-App'), 'mobile');
    });

    test('a session restored from the keystore refreshes once before the first requests', () async {
      final h = Harness();
      h.session.markRestorable(); // refresh token in the keystore, no access token in memory

      await Future.wait(<Future<dynamic>>[h.client.get('/requests'), h.client.get('/catalogue')]);

      expect(h.refreshCalls, 1);
      // No request was sent without a token, so nothing had to be replayed.
      expect(h.server.adapter.requests.length, 3);
      expect(h.session.accessToken, 'access-2');
    });

    test('when the refresh token is no longer accepted the session ends and the user is told once', () async {
      final h = Harness(storedRefreshToken: 'refresh-0-already-used');
      await h.session.setTokens(accessToken: 'stale-access', refreshToken: 'refresh-0-already-used');

      final outcomes = await Future.wait(<Future<Object?>>[
        h.client.get('/requests').then<Object?>((v) => v, onError: (Object e) => e),
        h.client.get('/invoices').then<Object?>((v) => v, onError: (Object e) => e),
      ]);

      for (final outcome in outcomes) {
        expect(outcome, isA<ApiException>());
        expect((outcome as ApiException).kind, ApiErrorKind.unauthorized);
      }
      expect(h.refreshCalls, 1);
      expect(h.expiredCalls, 1);
      expect(h.session.isActive, isFalse);
      expect(h.session.accessToken, isNull);
      expect(await h.store.readRefreshToken(), isNull);
    });

    test('a refresh that fails because the device is offline keeps the session', () async {
      final h = Harness();
      await h.session.setTokens(accessToken: 'stale-access', refreshToken: 'refresh-1');
      h.server.refreshOffline = true;

      Object? error;
      try {
        await h.client.get('/requests');
      } catch (e) {
        error = e;
      }

      expect(error, isA<ApiException>());
      expect((error! as ApiException).isNetwork, isTrue);
      expect(h.expiredCalls, 0);
      expect(h.session.isActive, isTrue);
      expect(await h.store.readRefreshToken(), 'refresh-1');

      // Back online: the same refresh token still works.
      h.server.refreshOffline = false;
      final result = await h.client.get('/requests');
      expect((result as Map)['ok'], isTrue);
      expect(await h.store.readRefreshToken(), 'refresh-2');
    });

    test('SESSION_EXPIRED from the server ends the session without trying to refresh', () async {
      final h = Harness();
      await h.session.setTokens(accessToken: 'access-1', refreshToken: 'refresh-1');
      h.server.sessionRevoked = true;

      await expectLater(h.client.get('/requests'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'SESSION_EXPIRED')));

      expect(h.refreshCalls, 0);
      expect(h.expiredCalls, 1);
      expect(await h.store.readRefreshToken(), isNull);
    });

    test('a 401 on a public call (wrong password) is not a session problem', () async {
      final h = Harness(storedRefreshToken: null);

      await expectLater(
        h.client.post('/auth/login', body: <String, dynamic>{'email': 'a@b.test', 'password': 'x', 'app': 'mobile'}, auth: false),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'INVALID_CREDENTIALS')),
      );

      expect(h.refreshCalls, 0);
      expect(h.expiredCalls, 0);
      expect(h.server.adapter.requests.single.authorization, isNull);
    });

    test('a request is replayed at most once', () async {
      final h = Harness();
      await h.session.setTokens(accessToken: 'stale-access', refreshToken: 'refresh-1');
      // After the refresh the server "forgets" the new access token again.
      h.server.refreshDelay = Duration.zero;
      final original = h.server.adapter.handler;
      var rejectEverything = false;
      final adapter = FakeAdapter((request) async {
        final response = await original(request);
        if (request.path.endsWith('/auth/refresh')) {
          rejectEverything = true;
          return response;
        }
        if (rejectEverything) {
          return FakeResponse(401, apiError(401, 'TOKEN_INVALID', 'Your session has expired. Please sign in again.'));
        }
        return response;
      });
      final client = ApiClient(
        baseUrl: 'https://api.example.test/api/v1',
        session: h.session,
        languageCode: () => 'en',
        adapter: adapter,
      );

      await expectLater(client.get('/requests'), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'TOKEN_INVALID')));
      expect(adapter.count('POST', '/auth/refresh'), 1);
      // rejected, refresh, replay (rejected again) - and no further attempt.
      expect(adapter.requests.length, 3);
    });
  });

  group('ApiClient headers and errors', () {
    test('sends X-Client-App, Accept-Language, X-Tenant-Host and the bearer token', () async {
      final h = Harness(tenantHost: 'portal.example.ae');
      h.language = 'ar';
      await h.session.setTokens(accessToken: 'access-1', refreshToken: 'refresh-1');

      await h.client.get('/catalogue', query: <String, dynamic>{'q': 'visa', 'categoryKey': null, 'empty': ''});

      final request = h.server.adapter.requests.single;
      expect(request.header('X-Client-App'), 'mobile');
      expect(request.header('Accept-Language'), 'ar');
      expect(request.header('X-Tenant-Host'), 'portal.example.ae');
      expect(request.authorization, 'Bearer access-1');
    });

    test('maps the API error body to ApiException with field errors', () async {
      final adapter = FakeAdapter((request) => FakeResponse(400, fixture('error_validation')));
      final session = SessionManager(MemoryTokenStore());
      final client = ApiClient(baseUrl: 'https://api.example.test/api/v1', session: session, languageCode: () => 'en', adapter: adapter);

      ApiException? error;
      try {
        await client.post('/auth/register', body: <String, dynamic>{}, auth: false);
      } on ApiException catch (e) {
        error = e;
      }

      expect(error, isNotNull);
      expect(error!.statusCode, 400);
      expect(error.code, 'VALIDATION_FAILED');
      expect(error.kind, ApiErrorKind.validation);
      expect(error.message, 'Please check the highlighted fields.');
      expect(error.requestId, isNotEmpty);
      // Two messages exist for "password"; the first one is kept per field.
      expect(error.fieldErrorMap.keys.toSet(), <String>{'fullName', 'email', 'password', 'acceptTerms'});
      expect(error.fieldErrorMap['password'], 'Use at least 10 characters');
      expect(error.fieldErrors.length, 5);
    });

    test('maps a transport failure to a network error without a server message', () async {
      final adapter = FakeAdapter((request) => offline());
      final client = ApiClient(
        baseUrl: 'https://api.example.test/api/v1',
        session: SessionManager(MemoryTokenStore()),
        languageCode: () => 'en',
        adapter: adapter,
      );

      await expectLater(
        client.get('/public/tenant-config', query: <String, dynamic>{'slug': 'x'}, auth: false),
        throwsA(isA<ApiException>().having((e) => e.kind, 'kind', ApiErrorKind.network).having((e) => e.message, 'message', isEmpty)),
      );
    });
  });
}
