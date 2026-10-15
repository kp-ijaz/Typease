import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/appointments/presentation/appointments_screen.dart';
import '../../features/appointments/presentation/book_appointment_screen.dart';
import '../../features/auth/application/bootstrap.dart';
import '../../features/auth/presentation/accept_invitation_screen.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/mfa_screen.dart';
import '../../features/auth/presentation/onboarding_screen.dart';
import '../../features/auth/presentation/otp_login_screen.dart';
import '../../features/auth/presentation/password_screens.dart';
import '../../features/auth/presentation/register_screen.dart';
import '../../features/auth/presentation/splash_screen.dart';
import '../../features/auth/presentation/verify_email_screen.dart';
import '../../features/catalogue/presentation/catalogue_screen.dart';
import '../../features/catalogue/presentation/service_details_screen.dart';
import '../../features/documents/presentation/camera_capture_screen.dart';
import '../../features/documents/presentation/document_upload_screen.dart';
import '../../features/finance/presentation/invoice_screen.dart';
import '../../features/finance/presentation/payments_screen.dart';
import '../../features/finance/presentation/quotation_screen.dart';
import '../../features/home/presentation/explore_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/home/presentation/home_shell.dart';
import '../../features/notifications/presentation/notifications_screen.dart';
import '../../features/profile/presentation/edit_profile_screen.dart';
import '../../features/profile/presentation/preferences_screens.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/profile/presentation/verify_phone_screen.dart';
import '../../features/reminders/presentation/reminders_screen.dart';
import '../../features/requests/presentation/request_details_screen.dart';
import '../../features/requests/presentation/request_history_screen.dart';
import '../../features/requests/presentation/request_wizard_screen.dart';
import '../../features/requests/presentation/status_timeline_screen.dart';
import '../../features/settings/presentation/notification_prefs_screen.dart';
import '../../features/settings/presentation/privacy_screen.dart';
import '../../features/settings/presentation/security_screens.dart';
import '../../features/settings/presentation/settings_screen.dart';
import '../../features/support/presentation/new_ticket_screen.dart';
import '../../features/support/presentation/support_screen.dart';
import '../../features/support/presentation/ticket_screen.dart';
import '../../features/tenant/presentation/centre_selection_screen.dart';
import '../../features/tracking/presentation/track_screen.dart';
import '../l10n/l10n_ext.dart';
import '../providers.dart';
import '../widgets/states.dart';
import 'redirect_logic.dart';
import 'routes.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Tells the router to run its redirect again.
class _RouterRefresh extends ChangeNotifier {
  void ping() => notifyListeners();
}

String _query(GoRouterState state, String name) => state.uri.queryParameters[name] ?? '';

String? _queryOrNull(GoRouterState state, String name) {
  final value = state.uri.queryParameters[name];
  return (value == null || value.isEmpty) ? null : value;
}

String _id(GoRouterState state) => state.pathParameters['id'] ?? '';

/// The router. Which screen is reachable is decided in one place:
/// [resolveRedirect], from the [AppGate] (start-up, onboarding, centre
/// selection, signed out / in).
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh();
  ref.listen<AppGate>(appGateProvider, (previous, next) => refresh.ping());
  ref.onDispose(refresh.dispose);

  final router = GoRouter(
    initialLocation: Routes.splash,
    refreshListenable: refresh,
    redirect: (context, state) {
      return resolveRedirect(
        gate: ref.read(appGateProvider),
        location: state.uri.path,
        tenantLocked: ref.read(appConfigProvider).isTenantLocked,
      );
    },
    errorBuilder: (context, state) => const _NotFoundScreen(),
    routes: <RouteBase>[
      // ---- start-up and signed-out screens
      GoRoute(path: Routes.splash, builder: (context, state) => const SplashScreen()),
      GoRoute(path: Routes.configError, builder: (context, state) => const ConfigErrorScreen()),
      GoRoute(path: Routes.onboarding, builder: (context, state) => const OnboardingScreen()),
      GoRoute(
        path: Routes.centre,
        builder: (context, state) => CentreSelectionScreen(toRegister: _query(state, 'next') == 'register'),
      ),
      GoRoute(path: Routes.login, builder: (context, state) => const LoginScreen()),
      GoRoute(path: Routes.otpLogin, builder: (context, state) => const OtpLoginScreen()),
      GoRoute(path: Routes.register, builder: (context, state) => const RegisterScreen()),
      GoRoute(
        path: Routes.verifyEmail,
        builder: (context, state) => VerifyEmailScreen(email: _query(state, 'email')),
      ),
      GoRoute(
        path: Routes.mfa,
        builder: (context, state) {
          final extra = state.extra;
          return MfaScreen(challengeToken: extra is String ? extra : '');
        },
      ),
      GoRoute(path: Routes.forgotPassword, builder: (context, state) => const ForgotPasswordScreen()),
      GoRoute(
        path: Routes.resetPassword,
        builder: (context, state) => ResetPasswordScreen(token: _query(state, 'token')),
      ),
      GoRoute(
        path: Routes.acceptInvitation,
        builder: (context, state) => AcceptInvitationScreen(token: _query(state, 'token')),
      ),

      // ---- guest pages (also reachable signed out)
      GoRoute(path: Routes.explore, builder: (context, state) => const ExploreScreen()),
      GoRoute(path: Routes.track, builder: (context, state) => const TrackScreen()),

      // ---- the four tabs
      ShellRoute(
        builder: (context, state, child) => HomeShell(location: state.uri.path, child: child),
        routes: <RouteBase>[
          GoRoute(path: Routes.home, builder: (context, state) => const HomeScreen()),
          GoRoute(path: Routes.requests, builder: (context, state) => const RequestHistoryScreen()),
          GoRoute(path: Routes.payments, builder: (context, state) => const PaymentsScreen()),
          GoRoute(path: Routes.profile, builder: (context, state) => const ProfileScreen()),
        ],
      ),

      // ---- full-screen pages (opened on top of the tabs)
      GoRoute(
        path: Routes.catalogue,
        builder: (context, state) => CatalogueScreen(
          initialCategory: _queryOrNull(state, 'category'),
          initialQuery: _queryOrNull(state, 'q'),
          renewalOf: _queryOrNull(state, 'renewalOf'),
        ),
      ),
      GoRoute(
        path: '/catalogue/service/:id',
        builder: (context, state) => ServiceDetailsScreen(serviceId: _id(state), renewalOf: _queryOrNull(state, 'renewalOf')),
      ),
      GoRoute(path: '/requests/:id', builder: (context, state) => RequestDetailsScreen(requestId: _id(state))),
      GoRoute(path: '/requests/:id/wizard', builder: (context, state) => RequestWizardScreen(requestId: _id(state))),
      GoRoute(path: '/requests/:id/timeline', builder: (context, state) => StatusTimelineScreen(requestId: _id(state))),
      GoRoute(
        path: '/requests/:id/upload',
        builder: (context, state) => DocumentUploadScreen(requestId: _id(state), checklistItemId: _queryOrNull(state, 'item')),
      ),
      GoRoute(path: Routes.capture, builder: (context, state) => const CameraCaptureScreen()),
      GoRoute(path: '/quotations/:id', builder: (context, state) => QuotationScreen(quotationId: _id(state))),
      GoRoute(path: '/invoices/:id', builder: (context, state) => InvoiceScreen(invoiceId: _id(state))),
      GoRoute(path: Routes.notifications, builder: (context, state) => const NotificationsScreen()),
      GoRoute(path: Routes.appointments, builder: (context, state) => const AppointmentsScreen()),
      GoRoute(
        path: Routes.bookAppointment,
        builder: (context, state) => BookAppointmentScreen(rescheduleId: _queryOrNull(state, 'reschedule')),
      ),
      GoRoute(path: Routes.support, builder: (context, state) => const SupportScreen()),
      GoRoute(
        path: Routes.newTicket,
        builder: (context, state) => NewTicketScreen(requestId: _queryOrNull(state, 'requestId')),
      ),
      GoRoute(path: '/support/ticket/:id', builder: (context, state) => TicketScreen(ticketId: _id(state))),
      GoRoute(path: Routes.reminders, builder: (context, state) => const RemindersScreen()),
      GoRoute(path: Routes.editProfile, builder: (context, state) => const EditProfileScreen()),
      GoRoute(path: Routes.verifyPhone, builder: (context, state) => const VerifyPhoneScreen()),
      GoRoute(path: Routes.consents, builder: (context, state) => const ConsentsScreen()),
      GoRoute(path: Routes.communication, builder: (context, state) => const CommunicationScreen()),
      GoRoute(path: Routes.settings, builder: (context, state) => const SettingsScreen()),
      GoRoute(path: Routes.sessions, builder: (context, state) => const SessionsScreen()),
      GoRoute(path: Routes.changePassword, builder: (context, state) => const ChangePasswordScreen()),
      GoRoute(path: Routes.notificationPrefs, builder: (context, state) => const NotificationPrefsScreen()),
      GoRoute(path: Routes.privacy, builder: (context, state) => const PrivacyScreen()),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});

class _NotFoundScreen extends StatelessWidget {
  const _NotFoundScreen();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('notFoundTitle'))),
      body: EmptyStateView(
        icon: PhosphorIconsRegular.compass,
        title: l10n.t('notFoundTitle'),
        message: l10n.t('notFoundBody'),
        action: FilledButton(onPressed: () => context.go(Routes.home), child: Text(l10n.t('notFoundHome'))),
      ),
    );
  }
}
