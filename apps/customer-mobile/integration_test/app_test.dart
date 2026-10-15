// NOT YET EXECUTED: written without a Dart SDK or a device (see README.md, "Verification status").
//
// Happy-path skeleton against a LOCAL TypEase API. It drives the real app
// (real HTTP, real secure storage) on an emulator, simulator or device.
//
// Prerequisites
//   1. The API runs on the development machine (default port 4000) with a
//      centre and a customer account whose email is verified and that has NO
//      authenticator (MFA) enabled.
//   2. `tool/bootstrap.sh` was run once (it creates the android/ and ios/ folders).
//
// Run (Android emulator; use http://localhost:4000/api/v1 on the iOS simulator):
//
//   flutter test integration_test/app_test.dart -d <device-id> \
//     --dart-define=API_BASE_URL=http://10.0.2.2:4000/api/v1 \
//     --dart-define=IT_CENTRE=<centre-code> \
//     --dart-define=IT_EMAIL=<customer-email> \
//     --dart-define=IT_PASSWORD=<customer-password>
//
// Optional: `--dart-define=IT_CREATE_DRAFT=true` also starts a request for the
// first service of the catalogue and saves it as a draft. This WRITES data
// (one draft request) to the API's database; leave it off for a read-only run.
//
// The test is skipped when the three IT_* values are missing, so a plain
// `flutter test integration_test` does not fail on a machine without an API.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:typease_customer/main.dart' as app;

const String _centre = String.fromEnvironment('IT_CENTRE');
const String _email = String.fromEnvironment('IT_EMAIL');
const String _password = String.fromEnvironment('IT_PASSWORD');
const bool _createDraft = bool.fromEnvironment('IT_CREATE_DRAFT');

bool _present(Finder finder) => finder.evaluate().isNotEmpty;

/// Pumps frames until [condition] holds. Network calls take real time here,
/// and screens with a progress indicator never "settle", so `pumpAndSettle`
/// is not used.
Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  required String waitingFor,
  Duration timeout = const Duration(seconds: 30),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('Timed out after ${timeout.inSeconds}s waiting for: $waitingFor');
    }
    await tester.pump(const Duration(milliseconds: 200));
  }
  // One more frame so that the found widget is laid out and hit-testable.
  await tester.pump(const Duration(milliseconds: 200));
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder.first);
  await tester.pump(const Duration(milliseconds: 100));
  await tester.tap(finder.first);
  await tester.pump(const Duration(milliseconds: 300));
}

final Finder _onboardingSkip = find.byKey(const Key('onboarding-skip'));
final Finder _centreCode = find.byKey(const Key('centre-code'));
final Finder _centreSubmit = find.byKey(const Key('centre-submit'));
final Finder _loginEmail = find.byKey(const Key('login-email'));
final Finder _loginPassword = find.byKey(const Key('login-password'));
final Finder _loginSubmit = find.byKey(const Key('login-submit'));
final Finder _navHome = find.byKey(const Key('nav-home'));
final Finder _navRequests = find.byKey(const Key('nav-requests'));
final Finder _navNew = find.byKey(const Key('nav-new'));
final Finder _navProfile = find.byKey(const Key('nav-profile'));
final Finder _serviceStart = find.byKey(const Key('service-start'));
final Finder _wizardNext = find.byKey(const Key('wizard-next'));
final Finder _wizardSubmit = find.byKey(const Key('wizard-submit'));
final Finder _wizardSaveDraft = find.byKey(const Key('wizard-save-draft'));

/// Any tile of the catalogue list (their keys are `service-<id>`).
final Finder _serviceTile = find.byWidgetPredicate((widget) {
  final key = widget.key;
  return key is ValueKey<String> && key.value.startsWith('service-') && key.value != 'service-start';
});

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final configured = _centre.isNotEmpty && _email.isNotEmpty && _password.isNotEmpty;

  testWidgets(
    'first launch -> choose centre -> sign in -> home -> catalogue -> service details',
    (tester) async {
      await app.main();

      // The app starts on the splash screen and moves on by itself. Depending
      // on what an earlier run left on the device it lands on the
      // introduction, the centre selection, sign-in or (still signed in) home.
      await _pumpUntil(
        tester,
        () => _present(_onboardingSkip) || _present(_centreCode) || _present(_loginEmail) || _present(_navHome),
        waitingFor: 'the first screen after the splash screen (is the API reachable at API_BASE_URL?)',
        timeout: const Duration(seconds: 45),
      );

      if (_present(_onboardingSkip)) {
        await _tap(tester, _onboardingSkip);
        await _pumpUntil(
          tester,
          () => _present(_centreCode) || _present(_loginEmail) || _present(_navHome),
          waitingFor: 'centre selection after the introduction',
        );
      }

      if (_present(_centreCode)) {
        await tester.enterText(_centreCode, _centre);
        await _tap(tester, _centreSubmit);
        await _pumpUntil(tester, () => _present(_loginEmail), waitingFor: 'the sign-in screen (is IT_CENTRE a valid centre code?)');
      }

      if (_present(_loginEmail)) {
        await tester.enterText(_loginEmail, _email);
        await tester.enterText(_loginPassword, _password);
        await _tap(tester, _loginSubmit);
        await _pumpUntil(
          tester,
          () => _present(_navHome),
          waitingFor: 'the home screen after signing in (check IT_EMAIL / IT_PASSWORD; the account must not use MFA)',
        );
      }

      // Home: the five destinations of the bottom bar.
      expect(_navHome, findsOneWidget);
      expect(_navRequests, findsOneWidget);
      expect(_navNew, findsOneWidget);
      expect(_navProfile, findsOneWidget);

      // "+" opens the catalogue of the centre.
      await _tap(tester, _navNew);
      await _pumpUntil(tester, () => _present(_serviceTile), waitingFor: 'services in the catalogue (does the centre have online services?)');

      // Service details with the start button.
      await _tap(tester, _serviceTile);
      await _pumpUntil(tester, () => _present(_serviceStart), waitingFor: 'the service details screen');

      if (!_createDraft) return;

      // Start a request. When an unfinished draft of the same service exists
      // the app asks whether to continue it; the confirming button is the
      // only FilledButton of the dialog.
      await _tap(tester, _serviceStart);
      await _pumpUntil(
        tester,
        () => _present(_wizardNext) || _present(_wizardSubmit) || _present(find.byType(AlertDialog)),
        waitingFor: 'the request wizard',
      );
      if (_present(find.byType(AlertDialog))) {
        await _tap(tester, find.descendant(of: find.byType(AlertDialog), matching: find.byType(FilledButton)));
        await _pumpUntil(tester, () => _present(_wizardNext) || _present(_wizardSubmit), waitingFor: 'the request wizard after the dialog');
      }

      // Leave the wizard: the draft is kept on the server.
      await _tap(tester, _wizardSaveDraft);
      await _pumpUntil(tester, () => !_present(_wizardSaveDraft), waitingFor: 'the wizard to close');

      // Back to the tabs (service details and catalogue were pushed on top).
      final navigator = tester.state<NavigatorState>(find.byType(Navigator).first);
      while (!_present(_navRequests) && navigator.canPop()) {
        navigator.pop();
        await tester.pump(const Duration(milliseconds: 400));
      }
      await _pumpUntil(tester, () => _present(_navRequests), waitingFor: 'the bottom bar');

      // The draft is listed under "My requests".
      await _tap(tester, _navRequests);
      await _pumpUntil(tester, () => _present(find.textContaining('TE-')), waitingFor: 'the request list with at least one request number');
    },
    skip: !configured,
  );
}
