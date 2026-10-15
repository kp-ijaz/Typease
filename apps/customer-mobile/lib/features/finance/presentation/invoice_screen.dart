import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/utils/money.dart';
import '../../../core/widgets/money_text.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/finance_providers.dart';
import '../data/finance_models.dart';
import 'fee_breakdown.dart';
import 'finance_actions.dart';
import 'payments_screen.dart' show invoiceTone, paymentTone;
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Invoice detail: the fee breakdown (service fees, government fees,
/// third-party charges and tax kept apart), what was paid, what is still due,
/// and "Pay now".
///
/// Paying happens at the centre's payment gateway in the browser. The app
/// reloads the invoice when the customer returns (app resumed, or the portal
/// return link opening the app), because only the server knows whether the
/// gateway confirmed the payment.
class InvoiceScreen extends ConsumerStatefulWidget {
  const InvoiceScreen({super.key, required this.invoiceId});

  final String invoiceId;

  @override
  ConsumerState<InvoiceScreen> createState() => _InvoiceScreenState();
}

class _InvoiceScreenState extends ConsumerState<InvoiceScreen> with WidgetsBindingObserver {
  bool _paying = false;

  /// True after the checkout was opened, until the invoice was reloaded.
  bool _awaitingGateway = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _awaitingGateway) {
      _refresh();
    }
  }

  Future<void> _refresh() async {
    final current = ref.read(invoiceProvider(widget.invoiceId)).valueOrNull;
    refreshFinance(ref, requestId: current?.requestId, invoiceId: widget.invoiceId);
    try {
      final fresh = await ref.read(invoiceProvider(widget.invoiceId).future);
      if (mounted && !fresh.isPayable) setState(() => _awaitingGateway = false);
    } catch (_) {
      // Shown by the screen.
    }
  }

  Future<void> _pay(Invoice invoice) async {
    if (_paying) return;
    setState(() => _paying = true);
    try {
      final outcome = await payInvoiceFlow(context, ref, invoice);
      if (!mounted) return;
      if (outcome == PaymentOutcome.checkoutOpened) {
        setState(() => _awaitingGateway = true);
      } else if (outcome == PaymentOutcome.sandboxFinished) {
        await _refresh();
      }
    } finally {
      if (mounted) setState(() => _paying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final invoice = ref.watch(invoiceProvider(widget.invoiceId));
    final loaded = invoice.valueOrNull;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('invoiceTitle'))),
      body: AsyncValueView<Invoice>(
        value: invoice,
        onRetry: () => ref.invalidate(invoiceProvider(widget.invoiceId)),
        data: (data) => _body(context, data),
      ),
      bottomNavigationBar: (loaded == null || !loaded.isPayable)
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: PrimaryButton(
                  label: l10n.t('invoicePayNow', <String, Object?>{'amount': Money.format(loaded.balanceDue, loaded.totals.currency)}),
                  icon: PhosphorIconsRegular.lockSimple,
                  loading: _paying,
                  onPressed: () => _pay(loaded),
                ),
              ),
            ),
    );
  }

  Widget _body(BuildContext context, Invoice invoice) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final language = l10n.languageCode;
    final currency = invoice.totals.currency;
    final requestId = invoice.requestId;

    return RefreshableList(
      onRefresh: _refresh,
      children: <Widget>[
        SectionCard(
          title: invoice.invoiceNo,
          trailing: StatusBadge(
            label: l10n.tOr('invoiceStatus_${invoice.status}', invoice.status),
            tone: invoiceTone(invoice.status, overdue: invoice.overdue),
          ),
          child: Column(
            children: <Widget>[
              if (invoice.requestNo != null) DetailRow(label: l10n.t('quotationForRequest'), value: invoice.requestNo!),
              if (invoice.quotationNo != null) DetailRow(label: l10n.t('quotationNumber'), value: invoice.quotationNo!),
              DetailRow(label: l10n.t('invoiceIssuedOn'), value: Dates.date(invoice.issuedAt, language)),
              if (invoice.isPayable) DetailRow(label: l10n.t('invoiceDueOn'), value: Dates.date(invoice.dueAt, language)),
            ],
          ),
        ),
        if (_awaitingGateway && invoice.isPayable)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InfoBanner(
              tone: Tone.info,
              icon: PhosphorIconsRegular.hourglassHigh,
              title: l10n.t('paymentWaitingTitle'),
              message: l10n.t('paymentWaitingBody'),
              action: OutlinedButton.icon(
                onPressed: _refresh,
                icon: const Icon(PhosphorIconsRegular.arrowClockwise, size: 18),
                label: Text(l10n.t('paymentCheckAgain')),
              ),
            ),
          ),
        FeeBreakdownCard(totals: invoice.totals, items: invoice.items),
        SectionCard(
          title: l10n.t('invoiceSettlement'),
          child: Column(
            children: <Widget>[
              _amountRow(context, l10n.t('feeTotal'), invoice.totals.total, currency),
              _amountRow(context, l10n.t('invoicePaidTotal'), invoice.amountPaid, currency),
              if (!Money.isZero(invoice.amountCredited)) _amountRow(context, l10n.t('invoiceCredited'), invoice.amountCredited, currency),
              if (!Money.isZero(invoice.amountRefunded)) _amountRow(context, l10n.t('invoiceRefunded'), invoice.amountRefunded, currency),
              const Divider(height: 16),
              _amountRow(context, l10n.t('invoiceBalance'), invoice.balanceDue, currency, strong: true),
            ],
          ),
        ),
        if (invoice.payments.isNotEmpty)
          SectionCard(
            title: l10n.t('invoicePayments'),
            child: Column(
              children: <Widget>[
                for (final payment in invoice.payments)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                payment.receiptNo ?? payment.paymentNo ?? '',
                                textDirection: TextDirection.ltr,
                                style: theme.textTheme.bodyMedium,
                              ),
                              Text(
                                <String>[
                                  l10n.tOr('paymentMethod_${payment.method}', payment.method),
                                  Dates.dateTime(payment.receivedAt, language),
                                ].join(' · '),
                                style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                              ),
                              const SizedBox(height: 4),
                              StatusBadge(
                                label: l10n.tOr('paymentStatus_${payment.status}', payment.status),
                                tone: paymentTone(payment.status),
                              ),
                            ],
                          ),
                        ),
                        MoneyText(payment.allocated, currency: currency, style: theme.textTheme.titleSmall),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        if (invoice.isPayable)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.userCheck, message: l10n.t('invoicePayHint')),
          ),
        if (requestId != null)
          TextButton(
            onPressed: () => context.push<void>(Routes.request(requestId)),
            child: Text(l10n.t('quotationOpenRequest')),
          ),
      ],
    );
  }

  Widget _amountRow(BuildContext context, String label, String amount, String currency, {bool strong = false}) {
    final theme = Theme.of(context);
    final style = strong ? theme.textTheme.titleMedium : theme.textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: <Widget>[
          Expanded(child: Text(label, style: style)),
          MoneyText(amount, currency: currency, style: style),
        ],
      ),
    );
  }
}
