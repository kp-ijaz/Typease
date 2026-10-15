import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/finance_providers.dart';
import '../data/finance_models.dart';
import 'fee_breakdown.dart';
import 'finance_actions.dart';
import 'payments_screen.dart' show quotationTone;
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// A quotation with its full fee breakdown. The customer approves it (which
/// issues the invoice) or rejects it with a reason.
class QuotationScreen extends ConsumerStatefulWidget {
  const QuotationScreen({super.key, required this.quotationId});

  final String quotationId;

  @override
  ConsumerState<QuotationScreen> createState() => _QuotationScreenState();
}

class _QuotationScreenState extends ConsumerState<QuotationScreen> {
  bool _busy = false;

  Future<void> _approve(Quotation quotation) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final approval = await approveQuotationFlow(
        context,
        ref,
        quotationId: quotation.id,
        total: quotation.totals.total,
        currency: quotation.totals.currency,
        requestId: quotation.requestId,
      );
      final invoiceId = approval?.invoiceId;
      if (invoiceId != null && mounted) {
        // Next step for the customer: the invoice that was just issued.
        context.pushReplacement(Routes.invoice(invoiceId));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reject(Quotation quotation) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await rejectQuotationFlow(context, ref, quotationId: quotation.id, requestId: quotation.requestId);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refresh() async {
    ref.invalidate(quotationProvider(widget.quotationId));
    try {
      await ref.read(quotationProvider(widget.quotationId).future);
    } catch (_) {
      // Shown by the screen.
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final quotation = ref.watch(quotationProvider(widget.quotationId));
    final loaded = quotation.valueOrNull;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('quotationTitle'))),
      body: AsyncValueView<Quotation>(
        value: quotation,
        onRetry: () => ref.invalidate(quotationProvider(widget.quotationId)),
        data: (data) => _body(context, data),
      ),
      bottomNavigationBar: (loaded == null || !loaded.awaitingDecision)
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    PrimaryButton(label: l10n.t('quotationApprove'), loading: _busy, onPressed: () => _approve(loaded)),
                    TextButton(
                      onPressed: _busy ? null : () => _reject(loaded),
                      child: Text(l10n.t('quotationReject')),
                    ),
                  ],
                ),
              ),
            ),
    );
  }

  Widget _body(BuildContext context, Quotation quotation) {
    final l10n = context.l10n;
    final language = l10n.languageCode;
    final requestId = quotation.requestId;
    final invoiceId = quotation.invoiceId;
    final notes = quotation.notes;
    final rejection = quotation.rejectionReason;
    final expired = quotation.expired && quotation.status == 'SENT';

    return RefreshableList(
      onRefresh: _refresh,
      children: <Widget>[
        SectionCard(
          title: quotation.quotationNo,
          trailing: StatusBadge(
            label: expired ? l10n.t('quotationStatus_EXPIRED') : l10n.tOr('quotationStatus_${quotation.status}', quotation.status),
            tone: quotationTone(quotation),
          ),
          child: Column(
            children: <Widget>[
              if (quotation.requestNo != null) DetailRow(label: l10n.t('quotationForRequest'), value: quotation.requestNo!),
              DetailRow(label: l10n.t('quotationSentOn'), value: Dates.date(quotation.sentAt, language)),
              DetailRow(label: l10n.t('quotationValidUntil'), value: Dates.date(quotation.validUntil, language)),
              if (quotation.decidedAt != null)
                DetailRow(label: l10n.t('quotationDecidedOn'), value: Dates.date(quotation.decidedAt, language)),
            ],
          ),
        ),
        if (expired)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InfoBanner(tone: Tone.warning, icon: PhosphorIconsRegular.timer, message: l10n.t('quotationExpiredNote')),
          ),
        if (quotation.awaitingDecision)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InfoBanner(icon: PhosphorIconsRegular.info, message: l10n.t('quotationApproveHint')),
          ),
        FeeBreakdownCard(totals: quotation.totals, items: quotation.items),
        if (notes != null && notes.trim().isNotEmpty) SectionCard(title: l10n.t('quotationNotes'), child: Text(notes)),
        if (rejection != null && rejection.trim().isNotEmpty)
          SectionCard(title: l10n.t('quotationRejectReason'), child: Text(rejection)),
        if (invoiceId != null)
          OutlinedButton.icon(
            onPressed: () => context.push<void>(Routes.invoice(invoiceId)),
            icon: const Icon(PhosphorIconsRegular.receipt),
            label: Text(l10n.t('quotationOpenInvoice')),
          ),
        if (requestId != null)
          TextButton(
            onPressed: () => context.push<void>(Routes.request(requestId)),
            child: Text(l10n.t('quotationOpenRequest')),
          ),
      ],
    );
  }
}
