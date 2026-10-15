// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:typease_customer/core/config/app_config.dart';
import 'package:typease_customer/core/network/api_client.dart';
import 'package:typease_customer/core/providers.dart';
import 'package:typease_customer/core/storage/prefs_keys.dart';
import 'package:typease_customer/core/storage/token_store.dart';
import 'package:typease_customer/features/auth/presentation/login_screen.dart';

import '../support/fake_adapter.dart';
import '../support/fixtures.dart';
import '../support/test_app.dart';

const AppConfig _config = AppConfig(
  apiBaseUrl: 'https://api.example.test/api/v1',
  tenantSlug: '',
  tenantHost: '',
  portalBaseUrl: '',
  deepLinkScheme: 'typease',
  deepLinkHosts: <String>[],
  flavor: 'test',
  firebaseEnabled: false,
  firebaseApiKey: '',
  firebaseAppId: '',
  firebaseMessagingSenderId: '',
  firebaseProjectId: '',
);

const Key _email = Key('login-email');
const Key _password = Key('login-password');
const Key _submit = Key('login-submit');

/// Shows the sign-in screen for the fixture centre. The network is replaced
/// by [handler]; the returned adapter records what was sent.
Future<FakeAdapter> pumpLogin(
  WidgetTester tester, {
  required FutureOr<FakeResponse> Function(RecordedRequest request) handler,
  String language = 'en',
  Map<String, Object> remembered = const <String, Object>{},
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    // The centre was selected before: its public configuration is cached.
    PrefsKeys.tenantConfigJson: jsonEncode(fixture('tenant_config')),
    PrefsKeys.languageCode: language,
    PrefsKeys.onboardingSeen: true,
    ...remembered,
  });
  final preferences = await SharedPreferences.getInstance();
  final adapter = FakeAdapter(handler);

  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[
        sharedPreferencesProvider.overrideWithValue(preferences),
        appConfigProvider.overrideWithValue(_config),
        tokenStoreProvider.overrideWithValue(MemoryTokenStore()),
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            baseUrl: _config.apiBaseUrl,
            session: ref.watch(sessionManagerProvider),
            languageCode: () => language,
            adapter: adapter,
          ),
        ),
      ],
      child: testApp(const LoginScreen(), languageCode: language),
    ),
  );
  // The localisation delegates load asynchronously.
  await tester.pump();
  await tester.pump();
  return adapter;
}

Future<void> tapSubmit(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(_submit));
  await tester.tap(find.byKey(_submit));
  // Let the (fake) request finish and the screen rebuild.
  await tester.pump(const Duration(milliseconds: 200));
  await tester.pump();
}

FakeResponse _unexpected(RecordedRequest request) {
  fail('No request expected, but ${request.method} ${request.path} was sent');
}

void main() {
  testWidgets('a returning user is greeted by name with the email filled in', (tester) async {
    await pumpLogin(
      tester,
      handler: _unexpected,
      remembered: <String, Object>{PrefsKeys.lastSignInEmail: 'fatima@mobile-fixture.test', PrefsKeys.lastSignInName: 'Fatima'},
    );
    expect(find.text('fatima@mobile-fixture.test'), findsOneWidget);
    expect(find.text('WELCOME BACK, FATIMA'), findsOneWidget);
  });

  testWidgets('shows the centre it signs in to', (tester) async {
    await pumpLogin(tester, handler: _unexpected);

    expect(find.text('Sign in to your account at Mobile Fixture Typing.'), findsOneWidget);
    expect(find.byKey(_email), findsOneWidget);
    expect(find.byKey(_password), findsOneWidget);
    expect(find.byKey(_submit), findsOneWidget);
    // No error is shown before the user did anything.
    expect(find.text('Enter your email address.'), findsNothing);
  });

  testWidgets('an empty form shows a message at each field and sends nothing', (tester) async {
    final adapter = await pumpLogin(tester, handler: _unexpected);

    await tapSubmit(tester);

    expect(find.text('Enter your email address.'), findsOneWidget);
    expect(find.text('Enter your password.'), findsOneWidget);
    expect(adapter.requests, isEmpty);
  });

  testWidgets('an invalid email is explained, the input is kept and nothing is sent', (tester) async {
    final adapter = await pumpLogin(tester, handler: _unexpected);

    await tester.enterText(find.byKey(_email), 'fatima-at-example');
    await tester.enterText(find.byKey(_password), 'Customer1234');
    await tapSubmit(tester);

    expect(find.text('Enter a valid email address, for example name@example.com.'), findsOneWidget);
    expect(find.text('Enter your password.'), findsNothing);
    expect(find.text('fatima-at-example'), findsOneWidget);
    expect(adapter.requests, isEmpty);
  });

  testWidgets('a rejected sign-in shows the server message and keeps what was typed', (tester) async {
    final adapter = await pumpLogin(
      tester,
      handler: (request) => FakeResponse(401, fixture('error_login')),
    );

    await tester.enterText(find.byKey(_email), 'Fatima@Mobile-Fixture.test');
    await tester.enterText(find.byKey(_password), 'WrongPassword1');
    await tapSubmit(tester);

    expect(find.text('The email or password is incorrect.'), findsOneWidget);
    expect(find.text('Fatima@Mobile-Fixture.test'), findsOneWidget);
    expect(find.text('WrongPassword1'), findsOneWidget);

    // Exactly one call, as a mobile client of the selected centre, without a token.
    final request = adapter.requests.single;
    expect(request.method, 'POST');
    expect(request.path, endsWith('/auth/login'));
    expect(request.header('X-Client-App'), 'mobile');
    expect(request.header('Accept-Language'), 'en');
    expect(request.authorization, isNull);
    final body = request.data! as Map<String, dynamic>;
    expect(body['email'], 'fatima@mobile-fixture.test');
    expect(body['password'], 'WrongPassword1');
    expect(body['app'], 'mobile');
    expect(body['tenantSlug'], 'mobile-fixture');

    // The button is usable again.
    final button = tester.widget<FilledButton>(find.descendant(of: find.byKey(_submit), matching: find.byType(FilledButton)));
    expect(button.onPressed, isNotNull);
  });

  testWidgets('field errors from the API are shown at the fields', (tester) async {
    await pumpLogin(
      tester,
      handler: (request) => FakeResponse(400, fixture('error_validation')),
    );

    await tester.enterText(find.byKey(_email), 'fatima@mobile-fixture.test');
    await tester.enterText(find.byKey(_password), 'short');
    await tapSubmit(tester);

    expect(find.text('Invalid email'), findsOneWidget);
    expect(find.text('Use at least 10 characters'), findsOneWidget);
    // The general message is not repeated when the fields explain the problem.
    expect(find.text('Please check the highlighted fields.'), findsNothing);
    expect(find.text('fatima@mobile-fixture.test'), findsOneWidget);
  });

  testWidgets('no connection: a plain explanation instead of a technical error', (tester) async {
    await pumpLogin(tester, handler: (request) => offline());

    await tester.enterText(find.byKey(_email), 'fatima@mobile-fixture.test');
    await tester.enterText(find.byKey(_password), 'Customer1234');
    await tapSubmit(tester);

    expect(find.text(arbMessages('en')['errorNoConnection']!), findsOneWidget);
    expect(find.textContaining('SocketException'), findsNothing);
    expect(find.text('fatima@mobile-fixture.test'), findsOneWidget);
  });

  testWidgets('Arabic: right-to-left layout, Arabic messages, email typed left-to-right', (tester) async {
    final adapter = await pumpLogin(tester, handler: _unexpected, language: 'ar');

    expect(Directionality.of(tester.element(find.byType(LoginScreen))), TextDirection.rtl);
    // Screen title and the primary button.
    expect(find.text('تسجيل الدخول'), findsNWidgets(2));

    await tapSubmit(tester);

    expect(find.text('أدخل بريدك الإلكتروني.'), findsOneWidget);
    expect(find.text('أدخل كلمة المرور.'), findsOneWidget);
    expect(adapter.requests, isEmpty);

    final emailInput = tester.widget<EditableText>(
      find.descendant(of: find.byKey(_email), matching: find.byType(EditableText)),
    );
    expect(emailInput.textDirection, TextDirection.ltr);
  });
}
