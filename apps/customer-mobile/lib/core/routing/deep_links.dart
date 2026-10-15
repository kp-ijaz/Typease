import 'routes.dart';

enum DeepLinkKind {
  /// Select a centre (`typease://centre/<slug>` or a portal link with `?tenant=`).
  centre,
  request,
  newRequest,
  quotation,
  invoice,
  payments,
  ticket,
  appointments,
  notifications,
  reminders,
  verifyEmail,
  resetPassword,
  acceptInvitation,
}

/// What an incoming link (or a tapped push notification) asks the app to do.
class DeepLinkTarget {
  const DeepLinkTarget({required this.kind, this.tenantSlug, this.tenantHost, this.id, this.token, this.renewalOf});

  final DeepLinkKind kind;

  /// Centre named by the link (`?tenant=` or `centre/<slug>`), if any.
  final String? tenantSlug;

  /// Host of an https portal link without `?tenant=`: the centre is resolved
  /// from the host (white-label custom domain).
  final String? tenantHost;
  final String? id;
  final String? token;
  final String? renewalOf;

  /// True for links that only make sense when signed in.
  bool get requiresSession {
    switch (kind) {
      case DeepLinkKind.centre:
      case DeepLinkKind.verifyEmail:
      case DeepLinkKind.resetPassword:
      case DeepLinkKind.acceptInvitation:
        return false;
      case DeepLinkKind.request:
      case DeepLinkKind.newRequest:
      case DeepLinkKind.quotation:
      case DeepLinkKind.invoice:
      case DeepLinkKind.payments:
      case DeepLinkKind.ticket:
      case DeepLinkKind.appointments:
      case DeepLinkKind.notifications:
      case DeepLinkKind.reminders:
        return true;
    }
  }

  /// The in-app route for this target, or null when it is handled without
  /// navigation (centre selection, email verification).
  String? get location {
    final target = id;
    final secret = token;
    switch (kind) {
      case DeepLinkKind.centre:
      case DeepLinkKind.verifyEmail:
        return null;
      case DeepLinkKind.request:
        return target == null ? Routes.requests : Routes.request(target);
      case DeepLinkKind.newRequest:
        return Routes.catalogueWith(renewalOf: renewalOf);
      case DeepLinkKind.quotation:
        return target == null ? Routes.payments : Routes.quotation(target);
      case DeepLinkKind.invoice:
        return target == null ? Routes.payments : Routes.invoice(target);
      case DeepLinkKind.payments:
        return Routes.payments;
      case DeepLinkKind.ticket:
        return target == null ? Routes.support : Routes.ticket(target);
      case DeepLinkKind.appointments:
        return Routes.appointments;
      case DeepLinkKind.notifications:
        return Routes.notifications;
      case DeepLinkKind.reminders:
        return Routes.reminders;
      case DeepLinkKind.resetPassword:
        return secret == null ? Routes.forgotPassword : Routes.resetPasswordWith(secret);
      case DeepLinkKind.acceptInvitation:
        return secret == null ? null : Routes.acceptInvitationWith(secret);
    }
  }

  /// Maps the `relatedType` / `relatedId` pair of a notification.
  static DeepLinkTarget? fromRelated(String? relatedType, String? relatedId) {
    if (relatedType == null || relatedType.isEmpty) return null;
    final id = (relatedId == null || relatedId.isEmpty) ? null : relatedId;
    switch (relatedType) {
      case 'ServiceRequest':
        return DeepLinkTarget(kind: DeepLinkKind.request, id: id);
      case 'Quotation':
        return DeepLinkTarget(kind: DeepLinkKind.quotation, id: id);
      case 'Invoice':
        return DeepLinkTarget(kind: DeepLinkKind.invoice, id: id);
      case 'Payment':
        return const DeepLinkTarget(kind: DeepLinkKind.payments);
      case 'Appointment':
        return const DeepLinkTarget(kind: DeepLinkKind.appointments);
      case 'SupportTicket':
        return DeepLinkTarget(kind: DeepLinkKind.ticket, id: id);
      case 'ReminderSchedule':
        return const DeepLinkTarget(kind: DeepLinkKind.reminders);
      default:
        return null;
    }
  }
}

/// Turns a URI into a [DeepLinkTarget]. Pure and unit-tested.
///
/// Accepted forms:
///  * custom scheme: `typease://centre/<slug>`, `typease://requests/<id>`,
///    `typease://verify-email?token=...`;
///  * portal links: `https://<portal-host>/requests/<id>?tenant=<slug>` and the
///    other paths the API puts into emails and notifications.
class DeepLinkParser {
  const DeepLinkParser({required this.scheme, this.allowedHosts = const <String>[]});

  final String scheme;

  /// When not empty, https links are only accepted from these hosts.
  final List<String> allowedHosts;

  static final RegExp _slug = RegExp(r'^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$');
  static final RegExp _id = RegExp(r'^[0-9a-fA-F-]{8,64}$');

  DeepLinkTarget? parse(Uri uri) {
    final linkScheme = uri.scheme.toLowerCase();
    final List<String> segments;
    String? host;
    if (linkScheme == scheme) {
      // typease://requests/<id>  ->  host "requests", path "/<id>"
      segments = <String>[
        if (uri.host.isNotEmpty) uri.host.toLowerCase(),
        ...uri.pathSegments.where((s) => s.isNotEmpty),
      ];
    } else if (linkScheme == 'https' || linkScheme == 'http') {
      final linkHost = uri.host.toLowerCase();
      if (allowedHosts.isNotEmpty && !allowedHosts.contains(linkHost)) return null;
      host = linkHost;
      segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
    } else {
      return null;
    }

    final query = uri.queryParameters;
    final tenantParam = query['tenant']?.trim().toLowerCase();
    final tenantSlug = (tenantParam != null && _slug.hasMatch(tenantParam)) ? tenantParam : null;
    // Without ?tenant= an https link identifies the centre by its host.
    final tenantHost = tenantSlug == null ? host : null;

    DeepLinkTarget build(DeepLinkKind kind, {String? id, String? token, String? renewalOf, String? slug}) {
      return DeepLinkTarget(
        kind: kind,
        tenantSlug: slug ?? tenantSlug,
        tenantHost: tenantHost,
        id: id,
        token: token,
        renewalOf: renewalOf,
      );
    }

    String? idAt(int index) {
      if (segments.length <= index) return null;
      final value = segments[index];
      return _id.hasMatch(value) ? value : null;
    }

    String? tokenParam() {
      final value = query['token'];
      return (value == null || value.length < 10) ? null : value;
    }

    if (segments.isEmpty) {
      return (tenantSlug != null || tenantHost != null) ? build(DeepLinkKind.centre) : null;
    }

    switch (segments.first) {
      case 'centre':
      case 'center':
        if (segments.length < 2) return null;
        final slug = segments[1].toLowerCase();
        return _slug.hasMatch(slug) ? build(DeepLinkKind.centre, slug: slug) : null;
      case 'requests':
      case 'request':
        if (segments.length >= 2 && segments[1] == 'new') {
          final renewal = query['renewalOf'];
          return build(DeepLinkKind.newRequest, renewalOf: (renewal != null && _id.hasMatch(renewal)) ? renewal : null);
        }
        return build(DeepLinkKind.request, id: idAt(1));
      case 'quotations':
        return build(DeepLinkKind.quotation, id: idAt(1));
      case 'invoices':
        return build(DeepLinkKind.invoice, id: idAt(1));
      case 'payments':
        if (segments.length >= 2 && segments[1] == 'return') {
          final invoice = query['invoice'];
          if (invoice != null && _id.hasMatch(invoice)) return build(DeepLinkKind.invoice, id: invoice);
        }
        return build(DeepLinkKind.payments);
      case 'support':
      case 'tickets':
        return build(DeepLinkKind.ticket, id: idAt(1));
      case 'appointments':
        return build(DeepLinkKind.appointments);
      case 'notifications':
        return build(DeepLinkKind.notifications);
      case 'reminders':
        return build(DeepLinkKind.reminders);
      case 'verify-email':
        final token = tokenParam();
        return token == null ? null : build(DeepLinkKind.verifyEmail, token: token);
      case 'reset-password':
        final token = tokenParam();
        return token == null ? null : build(DeepLinkKind.resetPassword, token: token);
      case 'accept-invitation':
        final token = tokenParam();
        return token == null ? null : build(DeepLinkKind.acceptInvitation, token: token);
      default:
        return (tenantSlug != null || tenantHost != null) ? build(DeepLinkKind.centre) : null;
    }
  }
}
