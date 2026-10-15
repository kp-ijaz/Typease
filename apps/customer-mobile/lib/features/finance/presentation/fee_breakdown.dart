import 'package:flutter/material.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/money.dart';
import '../../../core/widgets/money_text.dart';
import '../../../core/widgets/section_card.dart';
import '../data/finance_models.dart';

/// The fee breakdown of a quotation or an invoice.
///
/// Service fees, government fees and third-party charges are separate
/// sections with their own subtotals, followed by discount, tax and total.
/// Government fees carry the note that they are collected on behalf of the
/// authority (they are not the centre's income).
class FeeBreakdownCard extends StatelessWidget {
  const FeeBreakdownCard({super.key, required this.totals, required this.items, this.title});

  final MoneyTotals totals;
  final List<MoneyLine> items;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);

    List<MoneyLine> of(String component) => items.where((i) => i.component == component).toList();

    Widget totalRow(String label, String amount, {bool strong = false, bool negative = false}) {
      final style = strong ? theme.textTheme.titleMedium : theme.textTheme.bodyMedium;
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          children: <Widget>[
            Expanded(child: Text(label, style: style)),
            MoneyText(negative ? '-$amount' : amount, currency: totals.currency, style: style),
          ],
        ),
      );
    }

    return SectionCard(
      title: title ?? l10n.t('feeBreakdownTitle'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _ComponentSection(
            title: l10n.t('feeSectionService'),
            lines: of('SERVICE_FEE'),
            subtotal: totals.subtotalServiceFee,
            currency: totals.currency,
          ),
          _ComponentSection(
            title: l10n.t('feeSectionGovernment'),
            note: l10n.t('feeGovernmentNote'),
            lines: of('GOVERNMENT_FEE'),
            subtotal: totals.subtotalGovernmentFee,
            currency: totals.currency,
          ),
          _ComponentSection(
            title: l10n.t('feeSectionThirdParty'),
            lines: of('THIRD_PARTY_FEE'),
            subtotal: totals.subtotalThirdParty,
            currency: totals.currency,
          ),
          const Divider(height: 20),
          if (!Money.isZero(totals.discountTotal)) totalRow(l10n.t('feeDiscount'), totals.discountTotal, negative: true),
          totalRow(l10n.t('feeTax'), totals.taxTotal),
          const SizedBox(height: 4),
          totalRow(l10n.t('feeTotal'), totals.total, strong: true),
        ],
      ),
    );
  }
}

class _ComponentSection extends StatelessWidget {
  const _ComponentSection({required this.title, required this.lines, required this.subtotal, required this.currency, this.note});

  final String title;
  final String? note;
  final List<MoneyLine> lines;
  final String subtotal;
  final String currency;

  @override
  Widget build(BuildContext context) {
    // A component without lines and without an amount is left out entirely.
    if (lines.isEmpty && Money.isZero(subtotal)) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final remark = note;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(child: Semantics(header: true, child: Text(title, style: theme.textTheme.titleSmall))),
              MoneyText(subtotal, currency: currency, style: theme.textTheme.titleSmall),
            ],
          ),
          if (remark != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(remark, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
            ),
          for (final line in lines)
            Padding(
              padding: const EdgeInsetsDirectional.only(top: 6, start: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: Text(
                      Decimal.parseOrZero(line.quantity).compareTo(Decimal.parseOrZero('1')) == 0
                          ? line.description
                          : '${line.description} × ${Money.formatAmount(line.quantity)}',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                  const SizedBox(width: 8),
                  MoneyText(line.netAmount, currency: currency, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
