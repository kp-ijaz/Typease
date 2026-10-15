import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/money_text.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/finance_providers.dart';
import '../data/finance_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

Tone quotationTone(Quotation quotation) {
  if (quotation.awaitingDecision) return Tone.warning;
  if (quotation.status == 'APPROVED') return Tone.success;
  if (quotation.status == 'REJECTED') return Tone.danger;
  return Tone.neutral;
}

Tone invoiceTone(String status, {bool overdue = false}) {
  if (status == 'PAID') return Tone.success;
  if (status == 'ISSUED' || status == 'PARTIALLY_PAID') return overdue ? Tone.danger : Tone.warning;
  return Tone.neutral;
}

Tone paymentTone(String status) {
  if (status == 'COMPLETED') return Tone.success;
  if (status == 'PENDING') return Tone.info;
  if (status == 'FAILED' || status == 'CANCELLED') return Tone.danger;
  return Tone.neutral;
}

/// Quotations & payments: three lists - quotations to decide on, invoices to
/// pay, and the payments already made.
class PaymentsScreen extends ConsumerWidget {
  const PaymentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(l10n.t('paymentsTitle')),
          bottom: TabBar(
            tabs: <Widget>[
              Tab(text: l10n.t('paymentsTabInvoices')),
              Tab(text: l10n.t('paymentsTabQuotations')),
              Tab(text: l10n.t('paymentsTabPayments')),
            ],
          ),
        ),
        body: const TabBarView(
          children: <Widget>[_InvoicesTab(), _QuotationsTab(), _PaymentsTab()],
        ),
      ),
    );
  }
}

class _InvoicesTab extends ConsumerWidget {
  const _InvoicesTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final invoices = ref.watch(invoicesProvider);

    Future<void> reload() async {
      ref.invalidate(invoicesProvider);
      try {
        await ref.read(invoicesProvider.future);
      } catch (_) {
        // Shown by the list.
      }
    }

    return AsyncValueView<List<Invoice>>(
      value: invoices,
      onRetry: () => ref.invalidate(invoicesProvider),
      data: (items) {
        if (items.isEmpty) {
          return RefreshableList(
            onRefresh: reload,
            children: <Widget>[
              FillRemainingMessage(
                child: EmptyStateView(
                  icon: PhosphorIconsRegular.receipt,
                  title: l10n.t('invoicesEmptyTitle'),
                  message: l10n.t('invoicesEmptyBody'),
                ),
              ),
            ],
          );
        }
        return RefreshableList(
          onRefresh: reload,
          children: <Widget>[
            for (final invoice in items)
              SectionCard(
                onTap: () => context.push<void>(Routes.invoice(invoice.id)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(invoice.invoiceNo, textDirection: TextDirection.ltr, style: theme.textTheme.titleSmall),
                        ),
                        MoneyText(invoice.totals.total, currency: invoice.totals.currency, style: theme.textTheme.titleSmall),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      children: <Widget>[
                        StatusBadge(
                          label: l10n.tOr('invoiceStatus_${invoice.status}', invoice.status),
                          tone: invoiceTone(invoice.status, overdue: invoice.overdue),
                        ),
                        if (invoice.isPayable && invoice.overdue) StatusBadge(label: l10n.t('invoiceOverdue'), tone: Tone.danger),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      <String>[
                        if (invoice.requestNo != null) invoice.requestNo!,
                        Dates.date(invoice.issuedAt, l10n.languageCode),
                      ].join(' · '),
                      style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                    ),
                    if (invoice.isPayable)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Row(
                          children: <Widget>[
                            Expanded(child: Text(l10n.t('invoiceBalance'))),
                            MoneyText(invoice.balanceDue, currency: invoice.totals.currency, style: theme.textTheme.titleSmall),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

class _QuotationsTab extends ConsumerWidget {
  const _QuotationsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final quotations = ref.watch(quotationsProvider);

    Future<void> reload() async {
      ref.invalidate(quotationsProvider);
      try {
        await ref.read(quotationsProvider.future);
      } catch (_) {
        // Shown by the list.
      }
    }

    return AsyncValueView<List<Quotation>>(
      value: quotations,
      onRetry: () => ref.invalidate(quotationsProvider),
      data: (items) {
        if (items.isEmpty) {
          return RefreshableList(
            onRefresh: reload,
            children: <Widget>[
              FillRemainingMessage(
                child: EmptyStateView(
                  icon: PhosphorIconsRegular.invoice,
                  title: l10n.t('quotationsEmptyTitle'),
                  message: l10n.t('quotationsEmptyBody'),
                ),
              ),
            ],
          );
        }
        return RefreshableList(
          onRefresh: reload,
          children: <Widget>[
            for (final quotation in items)
              SectionCard(
                onTap: () => context.push<void>(Routes.quotation(quotation.id)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(quotation.quotationNo, textDirection: TextDirection.ltr, style: theme.textTheme.titleSmall),
                        ),
                        MoneyText(quotation.totals.total, currency: quotation.totals.currency, style: theme.textTheme.titleSmall),
                      ],
                    ),
                    const SizedBox(height: 6),
                    StatusBadge(
                      label: quotation.expired && quotation.status == 'SENT'
                          ? l10n.t('quotationStatus_EXPIRED')
                          : l10n.tOr('quotationStatus_${quotation.status}', quotation.status),
                      tone: quotationTone(quotation),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      <String>[
                        if (quotation.requestNo != null) quotation.requestNo!,
                        if (quotation.awaitingDecision)
                          l10n.t('quotationValidUntilShort', <String, Object?>{'date': Dates.date(quotation.validUntil, l10n.languageCode)})
                        else
                          Dates.date(quotation.sentAt, l10n.languageCode),
                      ].join(' · '),
                      style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

class _PaymentsTab extends ConsumerWidget {
  const _PaymentsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final payments = ref.watch(paymentsProvider);

    Future<void> reload() async {
      ref.invalidate(paymentsProvider);
      try {
        await ref.read(paymentsProvider.future);
      } catch (_) {
        // Shown by the list.
      }
    }

    return AsyncValueView<List<Payment>>(
      value: payments,
      onRetry: () => ref.invalidate(paymentsProvider),
      data: (items) {
        if (items.isEmpty) {
          return RefreshableList(
            onRefresh: reload,
            children: <Widget>[
              FillRemainingMessage(
                child: EmptyStateView(
                  icon: PhosphorIconsRegular.creditCard,
                  title: l10n.t('paymentsEmptyTitle'),
                  message: l10n.t('paymentsEmptyBody'),
                ),
              ),
            ],
          );
        }
        return RefreshableList(
          onRefresh: reload,
          children: <Widget>[
            for (final payment in items)
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            payment.receiptNo ?? payment.paymentNo ?? l10n.t('paymentPending'),
                            textDirection: TextDirection.ltr,
                            style: theme.textTheme.titleSmall,
                          ),
                        ),
                        MoneyText(payment.amount, currency: payment.currency, style: theme.textTheme.titleSmall),
                      ],
                    ),
                    const SizedBox(height: 6),
                    StatusBadge(
                      label: l10n.tOr('paymentStatus_${payment.status}', payment.status),
                      tone: paymentTone(payment.status),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      <String>[
                        l10n.tOr('paymentMethod_${payment.method}', payment.method),
                        Dates.dateTime(payment.receivedAt ?? payment.createdAt, l10n.languageCode),
                      ].join(' · '),
                      style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                    ),
                    if (payment.failureReason != null && payment.failureReason!.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(payment.failureReason!, style: theme.textTheme.bodySmall?.copyWith(color: tokens.danger)),
                      ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}
