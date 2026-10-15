// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/routing/deep_links.dart';
import 'package:typease_customer/core/routing/routes.dart';

const String _requestId = '3c3817bd-7972-49ff-840d-6bd2c1574c6c';
const String _invoiceId = '23391776-4ad3-473e-8750-aed5a628f59f';
const String _token = 'abcdefghijklmnopqrstuvwxyz012345';

void main() {
  const parser = DeepLinkParser(scheme: 'typease');

  DeepLinkTarget? parse(String link) => parser.parse(Uri.parse(link));

  group('centre selection', () {
    test('typease://centre/<slug>', () {
      final target = parse('typease://centre/mobile-fixture')!;
      expect(target.kind, DeepLinkKind.centre);
      expect(target.tenantSlug, 'mobile-fixture');
      expect(target.tenantHost, isNull);
      expect(target.requiresSession, isFalse);
      expect(target.location, isNull);
    });

    test('the slug is lower-cased and must be a valid centre code', () {
      expect(parse('typease://centre/Mobile-Fixture')!.tenantSlug, 'mobile-fixture');
      expect(parse('typease://centre/ab'), isNull);
      expect(parse('typease://centre/-bad-'), isNull);
      expect(parse('typease://centre/has%20space'), isNull);
      expect(parse('typease://centre'), isNull);
    });

    test('a portal link with ?tenant= selects the centre', () {
      final target = parse('https://portal.typease.ae/?tenant=mobile-fixture')!;
      expect(target.kind, DeepLinkKind.centre);
      expect(target.tenantSlug, 'mobile-fixture');
      expect(target.tenantHost, isNull);
    });

    test('a portal link without ?tenant= identifies the centre by its host', () {
      final target = parse('https://docs.alnoor-typing.ae/')!;
      expect(target.kind, DeepLinkKind.centre);
      expect(target.tenantSlug, isNull);
      expect(target.tenantHost, 'docs.alnoor-typing.ae');
    });

    test('an unknown portal path still selects the centre', () {
      final target = parse('https://portal.typease.ae/some/new/page?tenant=mobile-fixture')!;
      expect(target.kind, DeepLinkKind.centre);
      expect(target.tenantSlug, 'mobile-fixture');
    });
  });

  group('content links', () {
    test('request by id (custom scheme and portal link)', () {
      final custom = parse('typease://requests/$_requestId')!;
      expect(custom.kind, DeepLinkKind.request);
      expect(custom.id, _requestId);
      expect(custom.requiresSession, isTrue);
      expect(custom.location, Routes.request(_requestId));

      final portal = parse('https://portal.typease.ae/requests/$_requestId?tenant=mobile-fixture')!;
      expect(portal.kind, DeepLinkKind.request);
      expect(portal.id, _requestId);
      expect(portal.tenantSlug, 'mobile-fixture');
      expect(portal.location, '/requests/$_requestId');
    });

    test('a request link without a usable id opens the list', () {
      final target = parse('typease://requests/not-an-id!')!;
      expect(target.kind, DeepLinkKind.request);
      expect(target.id, isNull);
      expect(target.location, Routes.requests);
    });

    test('renewal link from a reminder', () {
      final target = parse('https://portal.typease.ae/requests/new?renewalOf=$_requestId&tenant=mobile-fixture')!;
      expect(target.kind, DeepLinkKind.newRequest);
      expect(target.renewalOf, _requestId);
      expect(target.location, '/catalogue?renewalOf=$_requestId');
      // Without (or with a malformed) renewalOf the catalogue opens normally.
      expect(parse('typease://requests/new')!.location, Routes.catalogue);
      expect(parse('typease://requests/new?renewalOf=not-valid')!.renewalOf, isNull);
    });

    test('quotation, invoice, ticket and the list screens', () {
      expect(parse('typease://quotations/$_invoiceId')!.location, Routes.quotation(_invoiceId));
      expect(parse('typease://invoices/$_invoiceId')!.location, Routes.invoice(_invoiceId));
      expect(parse('typease://invoices')!.location, Routes.payments);
      expect(parse('typease://payments')!.location, Routes.payments);
      expect(parse('typease://support/$_requestId')!.location, Routes.ticket(_requestId));
      expect(parse('typease://support')!.location, Routes.support);
      expect(parse('typease://appointments')!.location, Routes.appointments);
      expect(parse('typease://notifications')!.location, Routes.notifications);
      expect(parse('typease://reminders')!.location, Routes.reminders);
    });

    test('the return address of an online payment opens the invoice', () {
      final target = parse('https://portal.typease.ae/payments/return?invoice=$_invoiceId&tenant=mobile-fixture')!;
      expect(target.kind, DeepLinkKind.invoice);
      expect(target.id, _invoiceId);
      expect(parse('https://portal.typease.ae/payments/return?tenant=mobile-fixture')!.kind, DeepLinkKind.payments);
    });
  });

  group('account links from emails', () {
    test('verify email, reset password and invitation carry their token', () {
      final verify = parse('https://portal.typease.ae/verify-email?token=$_token&tenant=mobile-fixture')!;
      expect(verify.kind, DeepLinkKind.verifyEmail);
      expect(verify.token, _token);
      expect(verify.requiresSession, isFalse);
      expect(verify.location, isNull);

      final reset = parse('typease://reset-password?token=$_token')!;
      expect(reset.kind, DeepLinkKind.resetPassword);
      expect(reset.location, '/reset-password?token=$_token');
      expect(reset.requiresSession, isFalse);

      final invitation = parse('typease://accept-invitation?token=$_token')!;
      expect(invitation.kind, DeepLinkKind.acceptInvitation);
      expect(invitation.location, '/accept-invitation?token=$_token');
    });

    test('a link without a plausible token is ignored', () {
      expect(parse('typease://verify-email'), isNull);
      expect(parse('typease://reset-password?token=short'), isNull);
      expect(parse('typease://accept-invitation?token='), isNull);
    });
  });

  group('what is not accepted', () {
    test('other schemes and unknown custom-scheme paths', () {
      expect(parse('mailto:someone@example.com'), isNull);
      expect(parse('otherapp://requests/$_requestId'), isNull);
      expect(parse('typease://something-else'), isNull);
    });

    test('https links are limited to the configured hosts when a list is given', () {
      const strict = DeepLinkParser(scheme: 'typease', allowedHosts: <String>['portal.typease.ae']);
      expect(strict.parse(Uri.parse('https://portal.typease.ae/requests/$_requestId?tenant=mobile-fixture')), isNotNull);
      expect(strict.parse(Uri.parse('https://evil.example/requests/$_requestId?tenant=mobile-fixture')), isNull);
      // The custom scheme is not affected by the host list.
      expect(strict.parse(Uri.parse('typease://requests/$_requestId')), isNotNull);
    });

    test('a white-label build can use its own scheme', () {
      const custom = DeepLinkParser(scheme: 'alnoor');
      expect(custom.parse(Uri.parse('alnoor://requests/$_requestId'))!.id, _requestId);
      expect(custom.parse(Uri.parse('typease://requests/$_requestId')), isNull);
    });
  });

  group('notification targets (relatedType / relatedId)', () {
    test('maps the entity types the API uses', () {
      expect(DeepLinkTarget.fromRelated('ServiceRequest', _requestId)!.location, Routes.request(_requestId));
      expect(DeepLinkTarget.fromRelated('Quotation', _invoiceId)!.location, Routes.quotation(_invoiceId));
      expect(DeepLinkTarget.fromRelated('Invoice', _invoiceId)!.location, Routes.invoice(_invoiceId));
      expect(DeepLinkTarget.fromRelated('Payment', 'x')!.location, Routes.payments);
      expect(DeepLinkTarget.fromRelated('Appointment', 'x')!.location, Routes.appointments);
      expect(DeepLinkTarget.fromRelated('SupportTicket', _requestId)!.location, Routes.ticket(_requestId));
      expect(DeepLinkTarget.fromRelated('ReminderSchedule', 'x')!.location, Routes.reminders);
    });

    test('unknown or missing types have no target', () {
      expect(DeepLinkTarget.fromRelated(null, null), isNull);
      expect(DeepLinkTarget.fromRelated('', 'x'), isNull);
      expect(DeepLinkTarget.fromRelated('SomethingNew', 'x'), isNull);
      // Known type without an id: the list screen.
      expect(DeepLinkTarget.fromRelated('ServiceRequest', null)!.location, Routes.requests);
    });
  });
}
