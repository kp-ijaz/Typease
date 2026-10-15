import 'routes.dart';

/// Where the app is in its start-up and sign-in life cycle.
enum AppGate {
  /// A release build without `API_BASE_URL`.
  configError,

  /// Restoring the centre configuration and the session.
  booting,

  /// Start-up failed (no connection); the splash screen offers "Try again".
  bootError,

  /// First launch: the introduction has not been shown yet.
  needsOnboarding,

  /// No centre selected: a guest under the TypEase brand.
  needsCentre,

  signedOut,
  signedIn,
}

const List<String> _signedOutRoutes = <String>[
  Routes.login,
  Routes.register,
  Routes.verifyEmail,
  Routes.mfa,
  Routes.forgotPassword,
  Routes.resetPassword,
  Routes.acceptInvitation,
];

/// What a guest (centre chosen, not signed in) may look at: the centre's
/// showcase, the public catalogue and public tracking.
const List<String> _guestRoutes = <String>[Routes.explore, Routes.track, Routes.catalogue];

bool _matches(String location, String route) => location == route || location.startsWith('$route/');

/// The redirect rule of the router as a pure function (unit-tested).
/// Returns the path to go to instead of [location], or null to stay.
String? resolveRedirect({required AppGate gate, required String location, required bool tenantLocked}) {
  switch (gate) {
    case AppGate.configError:
      return location == Routes.configError ? null : Routes.configError;
    case AppGate.booting:
    case AppGate.bootError:
      return location == Routes.splash ? null : Routes.splash;
    case AppGate.needsOnboarding:
      return location == Routes.onboarding ? null : Routes.onboarding;
    case AppGate.needsCentre:
      // A guest browses under the TypEase brand; the centre is asked for
      // only on the way to signing in or registering.
      if (location == Routes.centre ||
          location == Routes.acceptInvitation ||
          location == Routes.explore ||
          location == Routes.track) {
        return null;
      }
      for (final route in _signedOutRoutes) {
        if (_matches(location, route)) return Routes.centre;
      }
      return Routes.explore;
    case AppGate.signedOut:
      if (location == Routes.centre) return tenantLocked ? Routes.login : null;
      for (final route in <String>[..._signedOutRoutes, ..._guestRoutes]) {
        if (_matches(location, route)) return null;
      }
      return Routes.login;
    case AppGate.signedIn:
      if (location == Routes.splash ||
          location == Routes.configError ||
          location == Routes.onboarding ||
          location == Routes.centre ||
          location == Routes.explore ||
          location == '/') {
        return Routes.home;
      }
      for (final route in _signedOutRoutes) {
        if (_matches(location, route)) return Routes.home;
      }
      return null;
  }
}
