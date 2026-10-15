// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/utils/money.dart';

void main() {
  group('Decimal.tryParse', () {
    test('accepts whole numbers and decimals of any scale', () {
      expect(Decimal.tryParse('476.00')!.toStringAsFixed(2), '476.00');
      expect(Decimal.tryParse('120.5')!.toStringAsFixed(2), '120.50');
      expect(Decimal.tryParse('30')!.toStringAsFixed(2), '30.00');
      expect(Decimal.tryParse(' 0.05 ')!.toStringAsFixed(2), '0.05');
      expect(Decimal.tryParse('-0.50')!.toStringAsFixed(2), '-0.50');
    });

    test('rejects anything that is not a plain decimal', () {
      expect(Decimal.tryParse(null), isNull);
      expect(Decimal.tryParse(''), isNull);
      expect(Decimal.tryParse('abc'), isNull);
      expect(Decimal.tryParse('1.'), isNull);
      expect(Decimal.tryParse('.5'), isNull);
      expect(Decimal.tryParse('1,000.00'), isNull);
      expect(Decimal.tryParse('1e3'), isNull);
    });
  });

  group('Decimal arithmetic', () {
    test('adds exactly where double would not', () {
      final sum = Decimal.tryParse('0.10')! + Decimal.tryParse('0.20')!;
      expect(sum.toStringAsFixed(2), '0.30');
      expect(Money.sum(<String?>['0.10', '0.20']), '0.30');
    });

    test('adds values of different scale', () {
      final sum = Decimal.tryParse('105')! + Decimal.tryParse('200.0')! + Decimal.tryParse('35.00')!;
      expect(sum.toStringAsFixed(2), '340.00');
    });

    test('subtracts', () {
      final net = Decimal.tryParse('126.00')! - Decimal.tryParse('6.00')!;
      expect(net.toStringAsFixed(2), '120.00');
      final negative = Decimal.tryParse('1.00')! - Decimal.tryParse('2.50')!;
      expect(negative.toStringAsFixed(2), '-1.50');
      expect(negative.isNegative, isTrue);
    });

    test('keeps large amounts exact', () {
      final sum = Decimal.tryParse('99999999999.99')! + Decimal.tryParse('0.01')!;
      expect(sum.toStringAsFixed(2), '100000000000.00');
    });

    test('compares by value, not by text', () {
      expect(Money.compare('10.0', '10.00'), 0);
      expect(Money.compare('9.99', '10'), lessThan(0));
      expect(Money.compare('10.01', '10'), greaterThan(0));
      expect(Decimal.tryParse('1.50'), Decimal.tryParse('1.5'));
    });

    test('rounds half away from zero', () {
      expect(Decimal.tryParse('1.005')!.toStringAsFixed(2), '1.01');
      expect(Decimal.tryParse('1.004')!.toStringAsFixed(2), '1.00');
      expect(Decimal.tryParse('-1.005')!.toStringAsFixed(2), '-1.01');
      expect(Decimal.tryParse('2.5')!.toStringAsFixed(0), '3');
      expect(Decimal.tryParse('0.004')!.toStringAsFixed(2), '0.00');
    });
  });

  group('Money formatting', () {
    test('groups thousands and always prints two decimals', () {
      expect(Money.formatAmount('1234567.5'), '1,234,567.50');
      expect(Money.formatAmount('1000'), '1,000.00');
      expect(Money.formatAmount('999'), '999.00');
      expect(Money.formatAmount('0'), '0.00');
      expect(Money.formatAmount('-1234.5'), '-1,234.50');
      expect(Money.formatAmount('123456'), '123,456.00');
    });

    test('shows a dash for missing or invalid amounts', () {
      expect(Money.formatAmount(null), '—');
      expect(Money.formatAmount('x'), '—');
      expect(Money.format(null, 'AED'), '—');
    });

    test('puts the currency first inside left-to-right isolates', () {
      final text = Money.format('476.00', 'AED');
      expect(text, '⁦AED 476.00⁩');
      expect(Money.format('5', ''), '⁦5.00⁩');
    });

    test('zero and positive checks', () {
      expect(Money.isZero('0.00'), isTrue);
      expect(Money.isZero('0'), isTrue);
      expect(Money.isZero(null), isTrue);
      expect(Money.isZero('0.01'), isFalse);
      expect(Money.isPositive('0.01'), isTrue);
      expect(Money.isPositive('0.00'), isFalse);
      expect(Money.isPositive('-3'), isFalse);
    });
  });
}
