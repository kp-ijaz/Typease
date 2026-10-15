// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/routing/redirect_logic.dart';
import 'package:typease_customer/core/routing/routes.dart';

String? go(AppGate gate, String location, {bool locked = false}) {
  return resolveRedirect(gate: gate, location: location, tenantLocked: locked);
}

void main() {
  test('a release build without API_BASE_URL only shows the configuration error', () {
    expect(go(AppGate.configError, Routes.home), Routes.configError);
    expect(go(AppGate.configError, Routes.login), Routes.configError);
    expect(go(AppGate.configError, Routes.configError), isNull);
  });

  test('while starting (or after a failed start) everything waits on the splash screen', () {
    expect(go(AppGate.booting, Routes.home), Routes.splash);
    expect(go(AppGate.booting, Routes.splash), isNull);
    expect(go(AppGate.bootError, Routes.request('abc')), Routes.splash);
    expect(go(AppGate.bootError, Routes.splash), isNull);
  });

  test('first launch shows the introduction', () {
    expect(go(AppGate.needsOnboarding, Routes.splash), Routes.onboarding);
    expect(go(AppGate.needsOnboarding, Routes.onboarding), isNull);
  });

  test('without a centre a guest explores; signing in asks for the centre first', () {
    expect(go(AppGate.needsCentre, Routes.splash), Routes.explore);
    expect(go(AppGate.needsCentre, Routes.home), Routes.explore);
    expect(go(AppGate.needsCentre, Routes.catalogue), Routes.explore);
    expect(go(AppGate.needsCentre, Routes.explore), isNull);
    expect(go(AppGate.needsCentre, Routes.track), isNull);
    expect(go(AppGate.needsCentre, Routes.login), Routes.centre);
    expect(go(AppGate.needsCentre, Routes.register), Routes.centre);
    expect(go(AppGate.needsCentre, Routes.centre), isNull);
    expect(go(AppGate.needsCentre, Routes.acceptInvitation), isNull);
  });

  group('signed out', () {
    test('the sign-in family of screens is open', () {
      for (final route in <String>[
        Routes.login,
        Routes.otpLogin,
        Routes.register,
        Routes.verifyEmail,
        Routes.mfa,
        Routes.forgotPassword,
        Routes.resetPassword,
        Routes.acceptInvitation,
      ]) {
        expect(go(AppGate.signedOut, route), isNull, reason: route);
      }
    });

    test('everything else leads to sign-in', () {
      expect(go(AppGate.signedOut, Routes.home), Routes.login);
      expect(go(AppGate.signedOut, Routes.request('abc')), Routes.login);
      expect(go(AppGate.signedOut, Routes.settings), Routes.login);
      expect(go(AppGate.signedOut, Routes.splash), Routes.login);
      // "/login-something" is not the login route.
      expect(go(AppGate.signedOut, '/loginx'), Routes.login);
    });

    test('a guest can browse the showcase, the public catalogue and tracking', () {
      for (final route in <String>[Routes.explore, Routes.track, Routes.catalogue, Routes.service('abc')]) {
        expect(go(AppGate.signedOut, route), isNull, reason: route);
      }
      expect(go(AppGate.signedOut, Routes.payments), Routes.login);
      expect(go(AppGate.signedIn, Routes.explore), Routes.home);
    });

    test('centre selection is available unless the build is locked to one centre', () {
      expect(go(AppGate.signedOut, Routes.centre), isNull);
      expect(go(AppGate.signedOut, Routes.centre, locked: true), Routes.login);
    });
  });

  group('signed in', () {
    test('start-up and sign-in screens lead home', () {
      for (final route in <String>[
        '/',
        Routes.splash,
        Routes.onboarding,
        Routes.centre,
        Routes.login,
        Routes.otpLogin,
        Routes.register,
        Routes.mfa,
        Routes.forgotPassword,
      ]) {
        expect(go(AppGate.signedIn, route), Routes.home, reason: route);
      }
    });

    test('application screens stay where they are', () {
      for (final route in <String>[
        Routes.home,
        Routes.requests,
        Routes.request('abc'),
        Routes.requestWizard('abc'),
        Routes.requestTimeline('abc'),
        Routes.payments,
        Routes.invoice('abc'),
        Routes.profile,
        Routes.settings,
        Routes.notifications,
        Routes.bookAppointment,
      ]) {
        expect(go(AppGate.signedIn, route), isNull, reason: route);
      }
    });
  });
}
