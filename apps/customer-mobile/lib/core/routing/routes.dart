/// Route paths. Parameters are filled in with the helper methods.
class Routes {
  const Routes._();

  static const String splash = '/splash';
  static const String configError = '/config-error';
  static const String onboarding = '/onboarding';
  static const String centre = '/centre';
  static const String login = '/login';
  static const String otpLogin = '/login/otp';
  static const String register = '/register';
  static const String verifyEmail = '/verify-email';
  static const String mfa = '/mfa';
  static const String forgotPassword = '/forgot-password';
  static const String resetPassword = '/reset-password';
  static const String acceptInvitation = '/accept-invitation';

  /// Guest pages: the centre's showcase and public request tracking.
  static const String explore = '/explore';
  static const String track = '/track';

  static const String home = '/home';
  static const String requests = '/requests';
  static const String payments = '/payments';
  static const String profile = '/profile';

  static const String catalogue = '/catalogue';
  static const String notifications = '/notifications';
  static const String appointments = '/appointments';
  static const String bookAppointment = '/appointments/book';
  static const String support = '/support';
  static const String newTicket = '/support/new';
  static const String reminders = '/reminders';
  static const String capture = '/capture';

  static const String editProfile = '/profile/edit';
  static const String verifyPhone = '/profile/verify-phone';
  static const String consents = '/profile/consents';
  static const String communication = '/profile/communication';

  static const String settings = '/settings';
  static const String sessions = '/settings/sessions';
  static const String changePassword = '/settings/change-password';
  static const String privacy = '/settings/privacy';
  static const String notificationPrefs = '/settings/notifications';

  static String service(String id, {String? renewalOf}) {
    final base = '/catalogue/service/$id';
    return renewalOf == null || renewalOf.isEmpty ? base : '$base?renewalOf=${Uri.encodeQueryComponent(renewalOf)}';
  }

  static String catalogueWith({String? category, String? renewalOf}) {
    final params = <String, String>{};
    if (category != null && category.isNotEmpty) params['category'] = category;
    if (renewalOf != null && renewalOf.isNotEmpty) params['renewalOf'] = renewalOf;
    if (params.isEmpty) return catalogue;
    return Uri(path: catalogue, queryParameters: params).toString();
  }

  static String request(String id) => '/requests/$id';
  static String requestWizard(String id) => '/requests/$id/wizard';
  static String requestTimeline(String id) => '/requests/$id/timeline';

  static String requestUpload(String id, {String? checklistItemId}) {
    final base = '/requests/$id/upload';
    return checklistItemId == null ? base : '$base?item=${Uri.encodeQueryComponent(checklistItemId)}';
  }

  static String quotation(String id) => '/quotations/$id';
  static String invoice(String id) => '/invoices/$id';
  static String ticket(String id) => '/support/ticket/$id';

  static String newTicketFor(String? requestId) {
    return requestId == null ? newTicket : '$newTicket?requestId=${Uri.encodeQueryComponent(requestId)}';
  }

  static String rescheduleAppointment(String id) => '$bookAppointment?reschedule=${Uri.encodeQueryComponent(id)}';

  /// Centre selection on the way to signing in (or, with [register], to
  /// creating an account): guests are only asked for the centre then.
  static String centreFor({bool register = false}) => register ? '$centre?next=register' : centre;

  static String verifyEmailFor(String email) => '$verifyEmail?email=${Uri.encodeQueryComponent(email)}';

  static String resetPasswordWith(String token) => '$resetPassword?token=${Uri.encodeQueryComponent(token)}';

  static String acceptInvitationWith(String token) => '$acceptInvitation?token=${Uri.encodeQueryComponent(token)}';
}
