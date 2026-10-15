/// Decimal-safe money helpers.
///
/// The API sends every amount as a decimal STRING ("476.00"). Amounts are
/// never converted to `double`: they are kept as strings in the models and
/// only turned into an exact scaled integer here for comparing, adding and
/// formatting.
class Decimal implements Comparable<Decimal> {
  const Decimal._(this._unscaled, this.scale);

  /// The unscaled value: `value = _unscaled / 10^scale`.
  final BigInt _unscaled;
  final int scale;

  static final Decimal zero = Decimal._(BigInt.zero, 0);

  static final RegExp _pattern = RegExp(r'^[+-]?\d+(\.\d+)?$');

  /// Parses "123", "123.4", "-0.50". Returns null for anything else.
  static Decimal? tryParse(String? input) {
    if (input == null) return null;
    final text = input.trim();
    if (!_pattern.hasMatch(text)) return null;
    final negative = text.startsWith('-');
    final unsigned = (text.startsWith('-') || text.startsWith('+')) ? text.substring(1) : text;
    final dot = unsigned.indexOf('.');
    final whole = dot < 0 ? unsigned : unsigned.substring(0, dot);
    final fraction = dot < 0 ? '' : unsigned.substring(dot + 1);
    final digits = BigInt.parse('$whole$fraction');
    return Decimal._(negative ? -digits : digits, fraction.length);
  }

  /// Like [tryParse] but treats null / invalid input as zero.
  static Decimal parseOrZero(String? input) => tryParse(input) ?? zero;

  bool get isZero => _unscaled == BigInt.zero;
  bool get isNegative => _unscaled < BigInt.zero;
  bool get isPositive => _unscaled > BigInt.zero;

  BigInt _unscaledAt(int targetScale) {
    assert(targetScale >= scale);
    return _unscaled * BigInt.from(10).pow(targetScale - scale);
  }

  Decimal operator +(Decimal other) {
    final target = scale > other.scale ? scale : other.scale;
    return Decimal._(_unscaledAt(target) + other._unscaledAt(target), target);
  }

  Decimal operator -(Decimal other) {
    final target = scale > other.scale ? scale : other.scale;
    return Decimal._(_unscaledAt(target) - other._unscaledAt(target), target);
  }

  @override
  int compareTo(Decimal other) {
    final target = scale > other.scale ? scale : other.scale;
    return _unscaledAt(target).compareTo(other._unscaledAt(target));
  }

  @override
  bool operator ==(Object other) => other is Decimal && compareTo(other) == 0;

  @override
  int get hashCode => toStringAsFixed(6).hashCode;

  /// Rounds half away from zero to [fractionDigits] and prints without
  /// grouping, e.g. `Decimal.tryParse('1.005')!.toStringAsFixed(2) == '1.01'`.
  String toStringAsFixed(int fractionDigits) {
    final rounded = _roundTo(fractionDigits);
    final negative = rounded < BigInt.zero;
    var digits = rounded.abs().toString();
    if (fractionDigits == 0) return negative ? '-$digits' : digits;
    if (digits.length <= fractionDigits) {
      digits = digits.padLeft(fractionDigits + 1, '0');
    }
    final split = digits.length - fractionDigits;
    final text = '${digits.substring(0, split)}.${digits.substring(split)}';
    return negative ? '-$text' : text;
  }

  BigInt _roundTo(int fractionDigits) {
    if (fractionDigits >= scale) return _unscaledAt(fractionDigits);
    final divisor = BigInt.from(10).pow(scale - fractionDigits);
    final negative = _unscaled < BigInt.zero;
    final absolute = _unscaled.abs();
    var quotient = absolute ~/ divisor;
    final remainder = absolute % divisor;
    if (remainder * BigInt.two >= divisor) quotient += BigInt.one;
    return negative ? -quotient : quotient;
  }

  @override
  String toString() => toStringAsFixed(scale);
}

/// Formatting for display.
class Money {
  const Money._();

  /// "1234567.5" -> "1,234,567.50". Invalid or missing input -> "—".
  static String formatAmount(String? amount, {int fractionDigits = 2}) {
    final value = Decimal.tryParse(amount);
    if (value == null) return '—';
    final fixed = value.toStringAsFixed(fractionDigits);
    final negative = fixed.startsWith('-');
    final unsigned = negative ? fixed.substring(1) : fixed;
    final dot = unsigned.indexOf('.');
    final whole = dot < 0 ? unsigned : unsigned.substring(0, dot);
    final fraction = dot < 0 ? '' : unsigned.substring(dot);
    final buffer = StringBuffer();
    for (var i = 0; i < whole.length; i++) {
      if (i > 0 && (whole.length - i) % 3 == 0) buffer.write(',');
      buffer.write(whole[i]);
    }
    final sign = negative ? '-' : '';
    return '$sign$buffer$fraction';
  }

  /// "476.00", "AED" -> "AED 476.00". The currency code always comes first and
  /// the result is wrapped in left-to-right isolates so that it reads the same
  /// inside Arabic text.
  static String format(String? amount, String currency) {
    final formatted = formatAmount(amount);
    if (formatted == '—') return formatted;
    final code = currency.trim();
    final text = code.isEmpty ? formatted : '$code $formatted';
    return '⁦$text⁩';
  }

  static bool isZero(String? amount) => Decimal.parseOrZero(amount).isZero;

  static bool isPositive(String? amount) => Decimal.parseOrZero(amount).isPositive;

  /// Exact sum of decimal strings, printed with two decimals.
  static String sum(Iterable<String?> amounts) {
    var total = Decimal.zero;
    for (final amount in amounts) {
      total = total + Decimal.parseOrZero(amount);
    }
    return total.toStringAsFixed(2);
  }

  static int compare(String? a, String? b) => Decimal.parseOrZero(a).compareTo(Decimal.parseOrZero(b));
}
