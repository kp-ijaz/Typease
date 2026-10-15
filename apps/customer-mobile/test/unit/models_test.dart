// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
//
// Every fixture read here is a real response captured from the local TypEase
// API (test/fixtures/README.md). The expectations are the values in those files.
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/network/page.dart';
import 'package:typease_customer/features/appointments/data/appointment_models.dart';
import 'package:typease_customer/features/auth/data/auth_models.dart';
import 'package:typease_customer/features/catalogue/data/catalogue_models.dart';
import 'package:typease_customer/features/documents/data/document_models.dart';
import 'package:typease_customer/features/finance/data/finance_models.dart';
import 'package:typease_customer/features/notifications/data/notification_models.dart';
import 'package:typease_customer/features/profile/data/profile_models.dart';
import 'package:typease_customer/features/reminders/data/reminder_models.dart';
import 'package:typease_customer/features/requests/data/form_schema.dart';
import 'package:typease_customer/features/requests/data/request_models.dart';
import 'package:typease_customer/features/support/data/support_models.dart';
import 'package:typease_customer/features/tenant/data/tenant_config.dart';

import '../support/fixtures.dart';

void main() {
  group('auth', () {
    test('a mobile sign-in carries both tokens and the session', () {
      final result = LoginResult.fromJson(fixture('login'));

      expect(result.status, LoginStatus.ok);
      expect(result.accessToken, 'header.payload.signature');
      expect(result.refreshToken, hasLength(64));
      expect(result.expiresIn, 900);
      expect(result.hasTokens, isTrue);

      final session = result.session!;
      expect(session.user.email, 'fatima@mobile-fixture.test');
      expect(session.user.fullName, 'Fatima Al Mansoori');
      expect(session.user.phone, '+971501110002');
      expect(session.user.emailVerified, isTrue);
      expect(session.user.mfaEnabled, isFalse);
      expect(session.tenant?.slug, 'mobile-fixture');
      expect(session.tenant?.currency, 'AED');
      expect(session.membership?.kind, 'CUSTOMER');
      expect(session.membership?.customerId, 'd07e8204-075f-46c6-9073-7086af6edf0a');
      expect(session.isPortalMember, isTrue);
      expect(session.hasCustomerProfile, isTrue);
      expect(session.permissions, hasLength(7));
      expect(session.can('self.requests'), isTrue);
      expect(session.can('requests.manage'), isFalse);
    });

    test('MFA_REQUIRED carries only the challenge token', () {
      final result = LoginResult.fromJson(fixture('login_mfa_required'));

      expect(result.status, LoginStatus.mfaRequired);
      expect(result.challengeToken, startsWith('challenge-token-placeholder'));
      expect(result.hasTokens, isFalse);
      expect(result.session, isNull);
    });

    test('an unknown or broken sign-in response does not throw', () {
      expect(LoginResult.fromJson(<String, dynamic>{'status': 'SOMETHING_NEW'}).status, LoginStatus.unknown);
      expect(LoginResult.fromJson(null).status, LoginStatus.unknown);
      expect(LoginResult.fromJson('not json').hasTokens, isFalse);
      // "OK" without tokens is not a usable sign-in.
      expect(LoginResult.fromJson(<String, dynamic>{'status': 'OK'}).hasTokens, isFalse);
    });

    test('the refresh response has the same shape as a sign-in', () {
      final result = LoginResult.fromJson(fixture('refresh'));
      expect(result.hasTokens, isTrue);
      expect(result.session?.user.fullName, 'Fatima Al Mansoori');
    });

    test('sessions list', () {
      final sessions = (fixture('sessions') as List<dynamic>).map(AuthSession.fromJson).toList();
      expect(sessions, hasLength(1));
      expect(sessions.single.app, 'mobile');
      expect(sessions.single.deviceName, 'Pixel 8');
      expect(sessions.single.current, isTrue);
    });
  });

  group('tenant config', () {
    test('parses the public centre configuration', () {
      final config = TenantConfig.fromJson(fixture('tenant_config'));

      expect(config.isValid, isTrue);
      expect(config.slug, 'mobile-fixture');
      expect(config.name, 'Mobile Fixture Typing');
      expect(config.nameAr, isNull);
      expect(config.mode, 'TYPEASE');
      expect(config.isWhiteLabel, isFalse);
      expect(config.primaryHex, '#0B2240');
      expect(config.secondaryHex, '#0B7AD1');
      expect(config.accentHex, '#00A166');
      expect(config.currency, 'AED');
      expect(config.timezone, 'Asia/Dubai');
      expect(config.supportPhone, '+971501110001');
      expect(config.feature('selfRegistration'), isTrue);
      expect(config.feature('corporatePortal'), isFalse);
      expect(config.feature('doesNotExist'), isFalse);
      // No Arabic name: the English one is shown in Arabic too.
      expect(config.displayName('ar'), 'Mobile Fixture Typing');
    });

    test('survives the cache round trip (toJson -> fromJson)', () {
      final config = TenantConfig.fromJson(fixture('tenant_config'));
      final restored = TenantConfig.fromJson(config.toJson());

      expect(restored.tenantId, config.tenantId);
      expect(restored.slug, config.slug);
      expect(restored.primaryHex, config.primaryHex);
      expect(restored.secondaryHex, config.secondaryHex);
      expect(restored.accentHex, config.accentHex);
      expect(restored.features, config.features);
      expect(restored.supportEmail, config.supportEmail);
      expect(restored.isValid, isTrue);
    });

    test('an empty body is recognisably invalid', () {
      expect(TenantConfig.fromJson(<String, dynamic>{}).isValid, isFalse);
      expect(TenantConfig.fromJson(null).isValid, isFalse);
    });
  });

  group('catalogue', () {
    test('parses the public catalogue that guests see', () {
      final catalogue = Catalogue.fromJson(fixture('public_catalogue'));
      final service = catalogue.services.first;
      expect(service.name, 'Express typing desk (while you wait)');
      expect(service.onlineAvailable, isFalse);
      expect(service.requirements.single.label, 'Draft or handwritten notes');
      expect(service.requirements.single.isMandatory, isFalse);
      final price = service.price!;
      expect(price.serviceFee, '45.00');
      expect(price.taxAmount, '2.25');
      expect(price.total, '47.25');
      expect(price.containsEstimates, isTrue);
    });

    test('parses categories and services with decimal-string prices', () {
      final catalogue = Catalogue.fromJson(fixture('catalogue'));

      expect(catalogue.categories, hasLength(10));
      expect(catalogue.services, hasLength(11));
      expect(catalogue.usedCategories, hasLength(10));

      final typing = catalogue.categories.first;
      expect(typing.key, 'typing');
      expect(typing.nameAr, 'الطباعة والمستندات');
      expect(typing.icon, 'file-text');
      expect(typing.serviceCount, 2);

      final service = catalogue.services.first;
      expect(service.name, 'Tenancy contract typing');
      expect(service.categoryKey, 'typing');
      expect(service.complianceCapability, 'DOCUMENT_PREPARATION_ONLY');
      expect(service.estimatedProcessingHours, 2);
      expect(service.onlineAvailable, isTrue);
      // The list response has neither requirements nor the form.
      expect(service.requirements, isEmpty);
      expect(service.form, isNull);

      final price = service.price!;
      expect(price.currency, 'AED');
      expect(price.serviceFee, '75.00');
      expect(price.taxAmount, '3.75');
      expect(price.total, '78.75');
      expect(price.paymentPolicy, 'BEFORE_PROCESSING');
      expect(price.containsEstimates, isFalse);
      expect(price.components, hasLength(3));
      expect(price.components.first.component, 'SERVICE_FEE');
      expect(price.components.first.total, '78.75');
    });

    test('parses the service detail with requirements and the form', () {
      final service = CatalogueService.fromJson(fixture('service_detail'));

      expect(service.id, '604303c6-1c36-4072-a6a5-a9ffb38b995e');
      expect(service.nameAr, 'طباعة طلب تأشيرة (تجهيز المستندات)');
      expect(service.categoryKey, 'visa');
      expect(service.estimatedProcessingHours, 24);

      final price = service.price!;
      expect(price.serviceFee, '120.00');
      expect(price.governmentFeeEstimate, '350.00');
      expect(price.total, '476.00');
      expect(price.containsEstimates, isTrue);
      expect(price.dueBeforeProcessing, '476.00');
      expect(price.taxRatePercent, '5.00');
      expect(price.depositPercent, isNull);

      expect(service.requirements.map((r) => r.documentTypeKey), <String>['passport', 'photo', 'residence_visa']);
      expect(service.requirements.map((r) => r.isMandatory), <bool>[true, true, false]);
      expect(service.requirements.first.allowReuse, isTrue);

      final form = service.form!;
      expect(form.steps.map((s) => s.key), <String>['applicant', 'visa']);
      expect(form.steps.first.titleAr, 'مقدم الطلب');
      expect(form.fields, hasLength(9));

      final byKey = <String, FormFieldDef>{for (final field in form.fields) field.key: field};
      expect(byKey['applicantName']!.type, FormFieldType.text);
      expect(byKey['applicantName']!.maxLength, 160);
      expect(byKey['applicantName']!.prefillFrom, 'customer.fullName');
      expect(byKey['nationality']!.type, FormFieldType.country);
      expect(byKey['dateOfBirth']!.type, FormFieldType.date);
      expect(byKey['dateOfBirth']!.sensitive, isTrue);
      expect(byKey['mobile']!.type, FormFieldType.phone);
      expect(byKey['visaType']!.type, FormFieldType.select);
      expect(byKey['visaType']!.options, hasLength(4));
      expect(byKey['visaType']!.options.first.value, 'visit');
      expect(byKey['visaType']!.options.first.labelAr, 'زيارة');
      expect(byKey['sponsorType']!.type, FormFieldType.radio);
      expect(byKey['sponsorType']!.hasOptions, isTrue);
      expect(byKey['insideCountry']!.type, FormFieldType.checkbox);
      expect(byKey['insideCountry']!.isRequired, isFalse);

      final showIf = byKey['sponsorName']!.showIf!;
      expect(showIf.field, 'sponsorType');
      expect(showIf.values, <String>['family', 'company']);
    });

    test('a field type this version does not know becomes "unsupported" instead of failing', () {
      final field = FormFieldDef.fromJson(<String, dynamic>{'key': 'sig', 'type': 'signature', 'label': 'Signature'});
      expect(field.type, FormFieldType.unsupported);
      expect(field.key, 'sig');
    });
  });

  group('requests', () {
    test('list page with status labels and an external status', () {
      final page = Page<RequestSummary>.fromJson(fixture('requests_list'), RequestSummary.fromJson);

      expect(page.page, 1);
      expect(page.total, 3);
      expect(page.totalPages, 1);
      expect(page.hasMore, isFalse);
      expect(page.items.map((r) => r.requestNo), <String>['TE-000003', 'TE-000002', 'TE-000001']);

      final draft = page.items[0];
      expect(draft.isDraft, isTrue);
      expect(draft.needsCustomerAction, isTrue);
      expect(draft.statusLabel.en, 'Draft — not submitted yet');
      expect(draft.serviceName, 'Visa application typing (document preparation)');
      expect(draft.serviceNameAr, isNotNull);
      expect(draft.externalStatus, isNull);

      final external = page.items[1];
      expect(external.status, 'EXTERNAL_PROCESSING');
      expect(external.tone, 'info');
      expect(external.externalStatus!.status, 'Under process at the authority');
      expect(external.externalStatus!.source, 'STAFF_ENTERED');
      expect(external.externalStatus!.isVerifiedOfficial, isFalse);
      expect(external.externalStatus!.sourceLabel.en, 'Entered by staff (not verified by the authority)');
      expect(external.externalStatus!.sourceLabel.ar, 'أدخلها الموظف (غير مؤكدة من الجهة)');

      expect(page.items[2].isClosed, isTrue);
    });

    test('counts', () {
      final counts = RequestCounts.fromJson(fixture('request_counts'));
      expect(counts.open, 1);
      expect(counts.drafts, 1);
      expect(counts.completed, 1);
      expect(counts.count('EXTERNAL_PROCESSING'), 1);
      expect(counts.count('QUOTED'), 0);
      expect(counts.needingAction, 0);
    });

    test('a new draft (POST /requests) carries the documents that can be reused', () {
      final request = RequestDetail.fromJson(fixture('request_created'));

      expect(request.requestNo, 'TE-000003');
      expect(request.isDraft, isTrue);
      expect(request.version, 1);
      expect(request.tone, 'neutral');
      expect(request.serviceId, '604303c6-1c36-4072-a6a5-a9ffb38b995e');
      expect(request.branchName, 'Main Branch');
      expect(request.formSchema.fields, hasLength(9));
      expect(request.waitingOn, 'CUSTOMER');
      expect(request.nextStepText.ar, 'أكمل النموذج وأضف المستندات ثم أرسل الطلب.');

      expect(request.reuseCandidates, hasLength(2));
      expect(request.reuseCandidates.first.documentId, 'df45bae0-cecf-4674-b247-471606cbfbaa');
      expect(request.reuseCandidates.first.linked, isTrue);
      expect(request.reuseCandidates.first.expiryDate, '2030-01-01T00:00:00.000Z');

      // Two lines were filled from documents on file, one optional line is open.
      expect(request.checklist.map((c) => c.status), <String>['VERIFIED', 'VERIFIED', 'MISSING']);
      expect(request.checklist.where((c) => c.blocksSubmission), isEmpty);
    });

    test('the saved draft keeps instructions and has no tracking code', () {
      final request = RequestDetail.fromJson(fixture('request_draft'));
      expect(request.version, 2);
      expect(request.customerInstructions, 'Please prepare in Arabic.');
      expect(request.trackingCode, isNull);
      expect(request.reuseCandidates, isEmpty);
    });

    test('the submit response carries the tracking code', () {
      final request = RequestDetail.fromJson(fixture('request_submitted'));
      expect(request.status, 'UNDER_REVIEW');
      expect(request.trackingCode, 'ABCDE-FGHIJ');
      expect(request.submittedAt, '2026-10-08T22:45:31.633Z');
      expect(request.waitingOn, 'CENTRE');
      expect(request.checklist.map((c) => c.status), <String>['UPLOADED', 'UPLOADED', 'MISSING']);
    });

    test('a request that needs the customer: rejected document, blocked resubmit, messages', () {
      final request = RequestDetail.fromJson(fixture('request_awaiting_customer'));

      expect(request.awaitingCustomer, isTrue);
      expect(request.statusLabel.en, 'Action needed from you');
      expect(request.tone, 'warning');
      expect(request.version, 5);

      // Form values keep their JSON types.
      expect(request.formValues['applicantName'], 'Fatima Al Mansoori');
      expect(request.formValues['dateOfBirth'], '1988-07-15');
      expect(request.formValues['insideCountry'], isTrue);
      expect(request.formValues['nationality'], 'AE');

      expect(request.inputItems, hasLength(3));
      expect(request.completionItems, isEmpty);

      final passport = request.checklist[0];
      expect(passport.isLocked, isTrue);
      expect(passport.document!.verificationStatus, 'VERIFIED');
      expect(passport.document!.isAvailable, isTrue);
      expect(passport.document!.expiryDate, '2030-01-01T00:00:00.000Z');

      final photo = request.checklist[1];
      expect(photo.isRejected, isTrue);
      expect(photo.actionRequired, isTrue);
      expect(photo.note, 'The background is not white. Please upload a new photo.');
      expect(photo.blocksSubmission, isTrue);

      final optional = request.checklist[2];
      expect(optional.isMissing, isTrue);
      expect(optional.isMandatory, isFalse);
      expect(optional.blocksSubmission, isFalse);
      expect(optional.document, isNull);

      final resubmit = request.transitionTo('UNDER_REVIEW')!;
      expect(resubmit.enabled, isFalse);
      expect(resubmit.blockedCode, 'REJECTED_DOCUMENTS_PENDING');
      expect(resubmit.blockedMessage, isNotEmpty);
      final cancel = request.transitionTo('CANCELLED')!;
      expect(cancel.enabled, isTrue);
      expect(cancel.requiresReason, isTrue);
      expect(request.transitionTo('COMPLETED'), isNull);

      expect(request.otherActions, <String>['edit_fields', 'edit_details', 'upload_documents', 'resubmit', 'comment']);
      expect(request.can('upload_documents'), isTrue);
      expect(request.can('approve_quotation'), isFalse);

      expect(request.comments, hasLength(2));
      expect(request.comments[0].fromCentre, isFalse);
      expect(request.comments[1].fromCentre, isTrue);
      expect(request.comments[1].body, 'We will call you tomorrow morning.');

      expect(request.history.map((h) => h.status), <String>['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'AWAITING_CUSTOMER']);
      expect(request.history.last.message, startsWith('Please replace the following document'));

      expect(request.workflowSteps, hasLength(9));
      expect(request.workflowSteps.where((s) => s.current).single.key, 'verification');
      expect(request.workflowSteps.first.isDone, isTrue);

      expect(request.quotation, isNull);
      expect(request.invoices, isEmpty);
      expect(request.totalBalance, '0.00');
    });

    test('a quoted request refers to its quotation', () {
      final request = RequestDetail.fromJson(fixture('request_quoted'));
      expect(request.status, 'QUOTED');
      expect(request.quotation!.quotationNo, 'QUO-000001');
      expect(request.quotation!.status, 'SENT');
      expect(request.quotation!.total, '476.00');
      expect(request.quotation!.currency, 'AED');
      expect(request.currencyOr('USD'), 'AED');
      expect(request.invoices, isEmpty);
      expect(request.workflowSteps.where((s) => s.current).single.key, 'customer-approval');
    });

    test('a completed request: paid invoice and a completion document', () {
      final request = RequestDetail.fromJson(fixture('request_completed'));

      expect(request.isCompleted, isTrue);
      expect(request.isClosed, isTrue);
      expect(request.paymentStatus, 'PAID');
      expect(request.completedAt, '2026-10-08T22:46:50.727Z');
      expect(request.transitions, isEmpty);
      expect(request.history, hasLength(12));

      expect(request.invoices, hasLength(1));
      expect(request.invoices.single.invoiceNo, 'INV-000001');
      expect(request.invoices.single.status, 'PAID');
      expect(request.invoices.single.balanceDue, '0.00');
      expect(request.invoices.single.isPayable, isFalse);
      expect(request.totalInvoiced, '476.00');
      expect(request.totalPaid, '476.00');

      expect(request.completionItems, hasLength(1));
      expect(request.completionItems.single.documentTypeKey, 'completed_document');
      expect(request.workflowSteps.every((s) => s.isDone), isTrue);
    });

    test('an external status is parsed together with its source label', () {
      final request = RequestDetail.fromJson(fixture('request_external'));

      expect(request.status, 'EXTERNAL_PROCESSING');
      expect(request.waitingOn, 'AUTHORITY');

      final external = request.externalStatus!;
      expect(external.status, 'Under process at the authority');
      expect(external.source, 'STAFF_ENTERED');
      expect(external.sourceLabel.resolve('en'), 'Entered by staff (not verified by the authority)');
      expect(external.sourceLabel.resolve('ar'), 'أدخلها الموظف (غير مؤكدة من الجهة)');
      expect(external.at, '2026-10-08T22:48:21.528Z');

      final reference = request.externalReferences.single;
      expect(reference.channel, 'MANUAL_PORTAL');
      expect(reference.authorityName, 'GDRFA Dubai');
      expect(reference.referenceNo, 'GD-2026-000123');
      expect(reference.statusSource, 'STAFF_ENTERED');
      expect(reference.statusSourceLabel.en, 'Entered by staff (not verified by the authority)');
    });

    test('an external status without a label gets the standard wording - never "official" by default', () {
      final staff = ExternalStatus.fromJson(<String, dynamic>{'status': 'Approved', 'source': 'STAFF_ENTERED'})!;
      expect(staff.sourceLabel.en, 'Entered by staff (not verified by the authority)');

      final official = ExternalStatus.fromJson(<String, dynamic>{'status': 'Approved', 'source': 'VERIFIED_OFFICIAL'})!;
      expect(official.isVerifiedOfficial, isTrue);
      expect(official.sourceLabel.en, 'Verified via official integration');

      // A source this version does not know, or no source at all.
      final unknown = ExternalStatus.fromJson(<String, dynamic>{'status': 'Approved', 'source': 'SOMETHING_NEW'})!;
      expect(unknown.isVerifiedOfficial, isFalse);
      expect(unknown.sourceLabel.en, 'Entered by staff (not verified by the authority)');
      final missing = ExternalStatus.fromJson(<String, dynamic>{'status': 'Approved'})!;
      expect(missing.source, 'STAFF_ENTERED');

      expect(ExternalStatus.fromJson(null), isNull);
      expect(ExternalStatus.fromJson(<String, dynamic>{'source': 'STAFF_ENTERED'}), isNull);
    });

    test('status wording falls back to the built-in table', () {
      final summary = RequestSummary.fromJson(<String, dynamic>{'id': 'x', 'requestNo': 'TE-1', 'status': 'AWAITING_PAYMENT'});
      expect(summary.statusLabel.en, 'Payment required');
      expect(summary.statusLabel.ar, 'الدفع مطلوب');
      expect(summary.tone, 'warning');
      expect(RequestStatusMeta.of('BRAND_NEW_STATUS').label.en, 'BRAND NEW STATUS');
      expect(RequestStatusMeta.of('BRAND_NEW_STATUS').tone, 'neutral');
    });

    test('an empty or malformed body never throws', () {
      final request = RequestDetail.fromJson(<String, dynamic>{'checklist': 'oops', 'history': 7, 'form': <dynamic>[]});
      expect(request.id, '');
      expect(request.checklist, isEmpty);
      expect(request.history, isEmpty);
      expect(request.formSchema.isEmpty, isTrue);
      expect(request.version, 1);
      expect(RequestDetail.fromJson(null).status, '');
    });
  });

  group('documents', () {
    test('upload intent: where and how to send the bytes', () {
      final intent = UploadIntent.fromJson(fixture('upload_intent'));
      expect(intent.isValid, isTrue);
      expect(intent.documentId, 'df45bae0-cecf-4674-b247-471606cbfbaa');
      expect(intent.versionId, '2ed7344b-5505-4c81-8dd6-d71c979b66f1');
      expect(intent.method, 'PUT');
      expect(intent.url, 'http://localhost:4000/api/v1/storage/local/upload/signed-token-placeholder');
      expect(intent.headers, <String, String>{'Content-Type': 'image/png'});
      expect(UploadIntent.fromJson(<String, dynamic>{}).isValid, isFalse);
    });

    test('upload completion', () {
      final summary = UploadSummary.fromJson(fixture('upload_complete'));
      expect(summary.documentId, 'df45bae0-cecf-4674-b247-471606cbfbaa');
      expect(summary.status, 'PENDING_SCAN');
      expect(summary.filename, 'passport.png');
      expect(summary.scanStatus, 'PENDING');
    });

    test('documents list', () {
      final page = Page<DocumentItem>.fromJson(fixture('documents_list'), DocumentItem.fromJson);
      expect(page.total, 2);
      final photo = page.items.first;
      expect(photo.documentTypeKey, 'photo');
      expect(photo.title, 'Personal photo, white background');
      expect(photo.verificationStatus, 'UNVERIFIED');
      expect(photo.downloadable, isTrue);
      expect(photo.filename, 'photo.png');
      expect(photo.mime, 'image/png');
      expect(photo.sizeBytes, 97);
      expect(photo.isCompletionDocument, isFalse);
    });

    test('download link', () {
      final link = DownloadLink.fromJson(fixture('download_link'));
      expect(link.url, startsWith('http://localhost:4000/api/v1/storage/local/download/'));
      expect(link.filename, 'passport.png');
      expect(link.mime, 'image/png');
    });

    test('checklist assistant', () {
      final assist = ChecklistAssist.fromJson(fixture('checklist_assist'));
      expect(assist.items, hasLength(3));
      final passport = assist.forItem('117fcc77-97a6-419a-874a-09f1082f66ce')!;
      expect(passport.state, 'UNVERIFIED');
      expect(passport.daysToExpiry, 1181);
      expect(passport.hint, isNotEmpty);
      expect(assist.forItem('1c189e09-f65b-4e1a-853d-2a7892523d3c')!.state, 'MISSING');
      expect(assist.forItem('no-such-line'), isNull);
    });
  });

  group('finance', () {
    test('quotation with fee lines; amounts stay decimal strings', () {
      final quotation = Quotation.fromJson(fixture('quotation_detail'));

      expect(quotation.quotationNo, 'QUO-000001');
      expect(quotation.status, 'SENT');
      expect(quotation.expired, isFalse);
      expect(quotation.awaitingDecision, isTrue);
      expect(quotation.requestNo, 'TE-000001');
      expect(quotation.validUntil, '2026-10-22T22:45:50.449Z');
      expect(quotation.invoiceId, isNull);

      expect(quotation.totals.currency, 'AED');
      expect(quotation.totals.subtotalServiceFee, '120.00');
      expect(quotation.totals.subtotalGovernmentFee, '350.00');
      expect(quotation.totals.subtotalThirdParty, '0.00');
      expect(quotation.totals.taxTotal, '6.00');
      expect(quotation.totals.total, '476.00');

      expect(quotation.items, hasLength(2));
      final fee = quotation.items.first;
      expect(fee.component, 'SERVICE_FEE');
      expect(fee.unitAmount, '120.00');
      expect(fee.taxAmount, '6.00');
      expect(fee.lineTotal, '126.00');
      expect(fee.netAmount, '120.00');
    });

    test('quotations list (no lines in the list response)', () {
      final page = Page<Quotation>.fromJson(fixture('quotations_list'), Quotation.fromJson);
      expect(page.items.single.quotationNo, 'QUO-000001');
      expect(page.items.single.items, isEmpty);
      expect(page.items.single.totals.total, '476.00');
    });

    test('approving a quotation returns the invoice to pay', () {
      final approval = QuotationApproval.fromJson(fixture('quotation_approved'));
      expect(approval.quotation.status, 'APPROVED');
      expect(approval.quotation.awaitingDecision, isFalse);
      expect(approval.invoiceId, '23391776-4ad3-473e-8750-aed5a628f59f');
      expect(approval.invoiceNo, 'INV-000001');
    });

    test('an open invoice is payable', () {
      final invoice = Invoice.fromJson(fixture('invoice_detail'));
      expect(invoice.invoiceNo, 'INV-000001');
      expect(invoice.status, 'ISSUED');
      expect(invoice.totals.total, '476.00');
      expect(invoice.amountPaid, '0.00');
      expect(invoice.balanceDue, '476.00');
      expect(invoice.isPayable, isTrue);
      expect(invoice.overdue, isTrue);
      expect(invoice.items, hasLength(2));
      expect(invoice.payments, isEmpty);
      expect(invoice.requestNo, 'TE-000001');
      expect(invoice.quotationNo, 'QUO-000001');
    });

    test('a paid invoice lists its payment and is no longer payable', () {
      final invoice = Invoice.fromJson(fixture('invoice_paid'));
      expect(invoice.status, 'PAID');
      expect(invoice.balanceDue, '0.00');
      expect(invoice.isPayable, isFalse);
      final payment = invoice.payments.single;
      expect(payment.paymentNo, 'PAY-000001');
      expect(payment.receiptNo, 'RCT-000001');
      expect(payment.method, 'ONLINE_GATEWAY');
      expect(payment.status, 'COMPLETED');
      expect(payment.amount, '476.00');
      expect(payment.allocated, '476.00');
    });

    test('invoices and payments lists', () {
      final invoices = Page<Invoice>.fromJson(fixture('invoices_list'), Invoice.fromJson);
      expect(invoices.items.single.balanceDue, '476.00');
      expect(invoices.items.single.items, isEmpty);

      final payments = Page<Payment>.fromJson(fixture('payments_list'), Payment.fromJson);
      final payment = payments.items.single;
      expect(payment.paymentNo, 'PAY-000001');
      expect(payment.amount, '476.00');
      expect(payment.refundedAmount, '0.00');
      expect(payment.currency, 'AED');
      expect(payment.reference, 'INV-000001');
      expect(payment.status, 'COMPLETED');
    });

    test('starting an online payment returns the checkout page', () {
      final start = PaymentStart.fromJson(fixture('invoice_pay'));
      expect(start.paymentId, '375a3885-e69e-45cb-92af-8ce237797db2');
      expect(start.amount, '476.00');
      expect(start.currency, 'AED');
      expect(start.gateway, 'sandbox');
      expect(start.testMode, isTrue);
      expect(start.isSandbox, isTrue);
      expect(start.checkoutUrl, 'http://localhost:4000/api/v1/public/payments/sandbox/checkout/signed-token-placeholder');
    });
  });

  group('notifications', () {
    test('inbox page with the unread counter', () {
      final inbox = NotificationInbox.fromJson(fixture('notifications'));
      expect(inbox.items, hasLength(5));
      expect(inbox.unreadCount, 28);
      expect(inbox.page, 1);
      expect(inbox.totalPages, 6);
      expect(inbox.hasMore, isTrue);

      final first = inbox.items.first;
      expect(first.eventKey, 'request.created');
      expect(first.subject, 'Request TE-000003 received');
      expect(first.relatedType, 'ServiceRequest');
      expect(first.relatedId, '66977f7e-fad4-4183-921e-c40a9fa71f21');
      expect(first.isUnread, isTrue);
      expect(first.markedRead('2026-10-09T00:00:00.000Z').isUnread, isFalse);
    });

    test('preferences: group choice, then channel default', () {
      final prefs = NotificationPreferences.fromJson(fixture('notification_prefs_updated'));
      expect(prefs.channels, <String>['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH']);
      expect(prefs.groups, hasLength(9));
      expect(prefs.note, isNotEmpty);
      // Explicit choice.
      expect(prefs.isEnabled('PUSH', 'marketing'), isFalse);
      // Channel defaults (the API sends lower-case keys).
      expect(prefs.isEnabled('PUSH', 'requests'), isTrue);
      expect(prefs.isEnabled('EMAIL', 'marketing'), isTrue);
      expect(prefs.isEnabled('WHATSAPP', 'requests'), isFalse);
    });
  });

  group('appointments', () {
    test('a booked appointment keeps the centre-local date and time', () {
      final appointment = Appointment.fromJson(fixture('appointment'));
      expect(appointment.status, 'BOOKED');
      expect(appointment.isUpcoming, isTrue);
      expect(appointment.branchName, 'Main Branch');
      expect(appointment.localDate, '2026-10-12');
      expect(appointment.localTime, '09:00');
      expect(appointment.localEndTime, '09:30');
      expect(appointment.timezone, 'Asia/Dubai');
      expect(appointment.startsAt, '2026-10-12T05:00:00.000Z');
      expect(appointment.canCancel, isTrue);
      expect(appointment.canReschedule, isTrue);
    });

    test('list after a reschedule', () {
      final page = Page<Appointment>.fromJson(fixture('appointments_list'), Appointment.fromJson);
      expect(page.items.map((a) => a.status), <String>['BOOKED', 'RESCHEDULED']);
      expect(page.items[1].isUpcoming, isFalse);
      expect(page.items[1].canCancel, isFalse);
    });

    test('availability for one day', () {
      final availability = Availability.fromJson(fixture('availability'));
      expect(availability.date, '2026-10-12');
      expect(availability.closed, isFalse);
      expect(availability.bookableUntil, '2026-12-08');
      expect(availability.slots, hasLength(6));
      expect(availability.freeSlots, hasLength(6));
      expect(availability.slots.first.localStart, '09:00');
      expect(availability.slots.first.localEnd, '09:30');
      expect(availability.slots.first.remaining, 2);
      expect(availability.slots.first.startsAt, '2026-10-12T05:00:00.000Z');
    });
  });

  group('support', () {
    test('ticket with its conversation', () {
      final ticket = Ticket.fromJson(fixture('ticket_detail'));
      expect(ticket.ticketNo, 'TKT-000001');
      expect(ticket.subject, 'Where can I collect my documents?');
      expect(ticket.status, 'RESOLVED');
      expect(ticket.isOpen, isFalse);
      expect(ticket.canReply, isTrue);
      expect(ticket.canRate, isTrue);
      expect(ticket.rating, isNull);
      expect(ticket.requestNo, 'TE-000001');
      expect(ticket.resolutionSummary, 'Answered.');

      expect(ticket.messages, hasLength(3));
      expect(ticket.messages[0].fromSupport, isFalse);
      expect(ticket.messages[0].attachments.single.documentId, 'df45bae0-cecf-4674-b247-471606cbfbaa');
      expect(ticket.messages[1].fromSupport, isTrue);
      // Staff names are not disclosed to customers.
      expect(ticket.messages[1].authorName, isNull);
      expect(ticket.messages[1].body, 'Yes, any day between 9:00 and 18:00.');
    });

    test('tickets list', () {
      final page = Page<Ticket>.fromJson(fixture('tickets_list'), Ticket.fromJson);
      expect(page.items.single.ticketNo, 'TKT-000001');
      expect(page.items.single.messages, isEmpty);
    });
  });

  group('reminders', () {
    test('expiry reminder', () {
      final page = Page<ReminderItem>.fromJson(fixture('reminders'), ReminderItem.fromJson);
      final reminder = page.items.single;
      expect(reminder.documentTypeKey, 'passport');
      expect(reminder.documentTypeName, 'Passport');
      expect(reminder.documentTypeNameAr, 'جواز السفر');
      expect(reminder.expiryDate, '2030-01-01');
      expect(reminder.daysLeft, 1180);
      expect(reminder.status, 'ACTIVE');
      expect(reminder.nextReminderOn, '2029-10-03');
      expect(reminder.isExpired, isFalse);
      expect(reminder.renewalStarted, isFalse);
    });
  });

  group('profile and privacy', () {
    test('customer profile: identity numbers arrive masked or not at all', () {
      final profile = CustomerProfile.fromJson(fixture('me_customer'));
      expect(profile.customerNo, 'CUS-000001');
      expect(profile.fullName, 'Fatima Al Mansoori');
      expect(profile.fullNameAr, 'فاطمة المنصوري');
      expect(profile.email, 'fatima@mobile-fixture.test');
      expect(profile.address!.line1, 'Villa 12');
      expect(profile.address!.emirate, 'Dubai');
      expect(profile.address!.country, 'AE');
      expect(profile.address!.isEmpty, isFalse);
      expect(profile.communicationPrefs.email, isTrue);
      expect(profile.communicationPrefs.whatsapp, isFalse);
      expect(profile.communicationPrefs.valueOf('push'), isTrue);
      expect(profile.marketingOptIn, isFalse);
      expect(profile.hasEmiratesId, isFalse);
      expect(profile.emiratesIdMasked, isNull);
      expect(profile.hasPassport, isFalse);
    });

    test('consents', () {
      final body = fixture('me_consents') as Map<String, dynamic>;
      final consents = (body['consents'] as List<dynamic>).map(ConsentState.fromJson).toList();
      expect(consents.map((c) => c.purpose), <String>['SERVICE_PROCESSING', 'REMINDERS', 'MARKETING', 'AI_PROCESSING', 'DOCUMENT_REUSE', 'WHATSAPP']);
      expect(consents[0].isRequired, isTrue);
      expect(consents[0].granted, isTrue);
      expect(consents[0].lawfulBasis, 'CONTRACT');
      expect(consents[1].isRequired, isFalse);
      expect(consents[2].status, 'WITHDRAWN');
      expect(consents[2].granted, isFalse);
      expect(consents[3].status, 'NOT_SET');
    });

    test('privacy request', () {
      final request = PrivacyRequest.fromJson(fixture('privacy_request'));
      expect(request.type, 'EXPORT');
      expect(request.status, 'RECEIVED');
      expect(request.isOpen, isTrue);
      expect(request.details, 'Please send me a copy of my data.');
      expect(request.dueAt, '2026-11-07T22:47:37.406Z');
      expect(request.overdue, isFalse);
      expect(request.exportDocumentId, isNull);
    });
  });
}
