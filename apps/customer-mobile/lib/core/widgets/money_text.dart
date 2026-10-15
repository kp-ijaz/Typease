import 'package:flutter/material.dart';

import '../utils/money.dart';

/// Shows a decimal-string amount with its currency, always left-to-right.
class MoneyText extends StatelessWidget {
  const MoneyText(this.amount, {super.key, required this.currency, this.style});

  final String? amount;
  final String currency;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return Text(Money.format(amount, currency), textDirection: TextDirection.ltr, style: style);
  }
}
