import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/utils/money.dart';
import '../../../core/widgets/feedback.dart';
import '../../documents/presentation/document_actions.dart';
import '../../requests/application/requests_providers.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/finance_providers.dart';
import '../data/finance_models.dart';
import '../data/finance_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Reloads everything that shows money or a request status.
void refreshFinance(WidgetRef ref, {String? requestId, String? invoiceId, String? quotationId}) {
  ref.invalidate(quotationsProvider);
  ref.invalidate(invoicesProvider);
  ref.invalidate(paymentsProvider);
  if (quotationId != null) ref.invalidate(quotationProvider(quotationId));
  if (invoiceId != null) ref.invalidate(invoiceProvider(invoiceId));
  if (requestId != null) ref.invalidate(requestDetailProvider(requestId));
  ref.invalidate(actionRequestsProvider);
  ref.invalidate(activeRequestsProvider);
  ref.invalidate(requestCountsProvider);
  ref.invalidate(requestListProvider);
}

/// Approves a quotation after confirmation. Approval issues the invoice, so
/// the dialog says so. Returns the approval, or null when nothing was done.
Future<QuotationApproval?> approveQuotationFlow(
  BuildContext context,
  WidgetRef ref, {
  required String quotationId,
  required String total,
  required String currency,
  String? requestId,
}) async {
  final l10n = context.l10n;
  final confirmed = await showConfirmDialog(
    context,
    title: l10n.t('quotationApproveTitle'),
    message: l10n.t('quotationApproveBody', <String, Object?>{'amount': Money.format(total, currency)}),
    confirmLabel: l10n.t('quotationApprove'),
  );
  if (!confirmed) return null;
  try {
    final approval = await ref.read(financeRepositoryProvider).approveQuotation(quotationId);
    // `ref` belongs to the calling widget and must not be used once it is gone.
    if (context.mounted) {
      refreshFinance(ref, requestId: requestId, quotationId: quotationId);
      showMessage(context, l10n.t('quotationApproved'));
    }
    return approval;
  } catch (error) {
    if (context.mounted) showError(context, error);
    return null;
  }
}

/// Rejects a quotation; a reason is required. Returns true when rejected.
Future<bool> rejectQuotationFlow(BuildContext context, WidgetRef ref, {required String quotationId, String? requestId}) async {
  final l10n = context.l10n;
  final reason = await showTextInputDialog(
    context,
    title: l10n.t('quotationRejectTitle'),
    message: l10n.t('quotationRejectBody'),
    fieldLabel: l10n.t('quotationRejectReason'),
    confirmLabel: l10n.t('quotationReject'),
    minLength: 3,
    destructive: true,
  );
  if (reason == null) return false;
  try {
    await ref.read(financeRepositoryProvider).rejectQuotation(quotationId, reason);
    if (context.mounted) {
      refreshFinance(ref, requestId: requestId, quotationId: quotationId);
      showMessage(context, l10n.t('quotationRejected'));
    }
    return true;
  } catch (error) {
    if (context.mounted) showError(context, error);
    return false;
  }
}

/// What happened when the customer tapped "Pay now".
enum PaymentOutcome {
  /// The gateway checkout was opened in the browser; the result arrives later.
  checkoutOpened,

  /// A test payment was completed or failed at the sandbox gateway.
  sandboxFinished,

  /// The centre has no online payment; the customer was told how to pay.
  notConfigured,

  /// Nothing was started.
  cancelled,
}

/// "Pay now": asks the API for a checkout session and opens it.
///
/// Nothing is marked as paid by the app. The invoice changes only when the
/// gateway confirms the payment to the server; the caller refreshes the
/// invoice when the customer comes back to the app.
Future<PaymentOutcome> payInvoiceFlow(BuildContext context, WidgetRef ref, Invoice invoice) async {
  final l10n = context.l10n;
  final repository = ref.read(financeRepositoryProvider);
  final config = ref.read(appConfigProvider);
  final tenant = ref.read(tenantControllerProvider);

  // The API only accepts return addresses on the centre's own web portal.
  String? returnUrl;
  if (config.portalBaseUrl.isNotEmpty) {
    final params = <String, String>{'invoice': invoice.id};
    if (tenant != null) params['tenant'] = tenant.slug;
    returnUrl = Uri.parse('${config.portalBaseUrl}/payments/return').replace(queryParameters: params).toString();
  }

  PaymentStart start;
  try {
    try {
      start = await repository.payInvoice(invoice.id, returnUrl: returnUrl);
    } on ApiException catch (error) {
      if (error.code != 'INVALID_RETURN_URL' || returnUrl == null) rethrow;
      // The configured portal address is not registered for this centre:
      // carry on without it (the app refreshes when it is opened again).
      start = await repository.payInvoice(invoice.id);
    }
  } on ApiException catch (error) {
    if (!context.mounted) return PaymentOutcome.cancelled;
    if (error.code == 'INTEGRATION_NOT_CONFIGURED') {
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          icon: const Icon(PhosphorIconsRegular.storefront),
          title: Text(l10n.t('paymentNotConfiguredTitle')),
          content: Text(
            l10n.t('paymentNotConfiguredBody', <String, Object?>{'centre': tenant?.displayName(l10n.languageCode) ?? ''}),
          ),
          actions: <Widget>[
            FilledButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(l10n.t('commonOk'))),
          ],
        ),
      );
      return PaymentOutcome.notConfigured;
    }
    showError(context, error);
    return PaymentOutcome.cancelled;
  } catch (error) {
    if (context.mounted) showError(context, error);
    return PaymentOutcome.cancelled;
  }

  if (!context.mounted) return PaymentOutcome.cancelled;

  if (start.isSandbox) {
    // Development only: the test gateway has no page of its own.
    final choice = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(PhosphorIconsRegular.flask),
        title: Text(l10n.t('paymentSandboxTitle')),
        content: Text(l10n.t('paymentSandboxBody', <String, Object?>{'amount': Money.format(start.amount, start.currency)})),
        actions: <Widget>[
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(l10n.t('commonCancel'))),
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(l10n.t('paymentSandboxFail'))),
          FilledButton(onPressed: () => Navigator.of(dialogContext).pop(true), child: Text(l10n.t('paymentSandboxComplete'))),
        ],
      ),
    );
    if (choice == null) return PaymentOutcome.cancelled;
    try {
      await repository.finishSandboxPayment(start, succeed: choice);
    } catch (error) {
      if (context.mounted) showError(context, error);
    }
    if (context.mounted) refreshFinance(ref, requestId: invoice.requestId, invoiceId: invoice.id);
    return PaymentOutcome.sandboxFinished;
  }

  final opened = await openExternalUrl(start.checkoutUrl);
  if (!opened) {
    if (context.mounted) showMessage(context, l10n.t('paymentCannotOpen'), isError: true);
    return PaymentOutcome.cancelled;
  }
  return PaymentOutcome.checkoutOpened;
}
