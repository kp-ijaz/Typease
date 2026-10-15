// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/theme/app_theme.dart';
import 'package:typease_customer/core/theme/brand_colors.dart';
import 'package:typease_customer/core/theme/brand_tokens.dart';

void main() {
  group('Rgb.tryParseHex', () {
    test('parses the forms a centre can configure', () {
      expect(Rgb.tryParseHex('#0B2240'), const Rgb(0x0B, 0x22, 0x40));
      expect(Rgb.tryParseHex('0b7ad1'), const Rgb(0x0B, 0x7A, 0xD1));
      expect(Rgb.tryParseHex(' #00A166 '), const Rgb(0x00, 0xA1, 0x66));
      expect(Rgb.tryParseHex('#07D'), const Rgb(0x00, 0x77, 0xDD));
    });

    test('returns null for anything else', () {
      expect(Rgb.tryParseHex(null), isNull);
      expect(Rgb.tryParseHex(''), isNull);
      expect(Rgb.tryParseHex('blue'), isNull);
      expect(Rgb.tryParseHex('#12345'), isNull);
      expect(Rgb.tryParseHex('#GGGGGG'), isNull);
    });

    test('round-trips through hex and argb', () {
      const colour = Rgb(11, 122, 209);
      expect(colour.hex, '#0B7AD1');
      expect(colour.argb, 0xFF0B7AD1);
    });
  });

  group('contrast', () {
    test('black on white is 21:1, a colour on itself 1:1', () {
      expect(BrandColors.contrastRatio(Rgb.black, Rgb.white), closeTo(21.0, 0.01));
      expect(BrandColors.contrastRatio(Rgb.white, Rgb.black), closeTo(21.0, 0.01));
      expect(BrandColors.contrastRatio(BrandColors.defaultPrimary, BrandColors.defaultPrimary), closeTo(1.0, 0.0001));
    });

    test('picks white on dark brand colours and black on light ones', () {
      expect(BrandColors.onColorFor(BrandColors.defaultPrimary), Rgb.white);
      expect(BrandColors.onColorFor(const Rgb(0xFF, 0xEB, 0x3B)), Rgb.black);
      expect(BrandColors.onColorFor(Rgb.white), Rgb.black);
      expect(BrandColors.onColorFor(Rgb.black), Rgb.white);
    });

    test('the on-colour reaches WCAG AA on every grey and on sample brand colours', () {
      final samples = <Rgb>[
        for (var v = 0; v <= 255; v += 5) Rgb(v, v, v),
        const Rgb(0x0B, 0x22, 0x40),
        const Rgb(0x0B, 0x7A, 0xD1),
        const Rgb(0x00, 0xA1, 0x66),
        const Rgb(0xFF, 0xEB, 0x3B),
        const Rgb(0xFF, 0x57, 0x22),
        const Rgb(0x9C, 0x27, 0xB0),
        const Rgb(0x80, 0xCB, 0xC4),
        const Rgb(0x79, 0x55, 0x48),
      ];
      for (final background in samples) {
        final onColour = BrandColors.onColorFor(background);
        expect(
          BrandColors.contrastRatio(onColour, background),
          greaterThanOrEqualTo(BrandColors.minTextContrast),
          reason: 'on-colour for $background',
        );
      }
    });

    test('ensureContrast leaves readable colours alone', () {
      expect(BrandColors.ensureContrast(BrandColors.defaultPrimary, Rgb.white), BrandColors.defaultPrimary);
    });

    test('ensureContrast darkens light colours on a light surface', () {
      const yellow = Rgb(0xFF, 0xEB, 0x3B);
      final adjusted = BrandColors.ensureContrast(yellow, Rgb.white);
      expect(adjusted, isNot(yellow));
      expect(BrandColors.contrastRatio(adjusted, Rgb.white), greaterThanOrEqualTo(4.5));
    });

    test('ensureContrast lightens dark colours on a dark surface', () {
      const darkSurface = Rgb(0x12, 0x18, 0x22);
      final adjusted = BrandColors.ensureContrast(BrandColors.defaultPrimary, darkSurface);
      expect(BrandColors.contrastRatio(adjusted, darkSurface), greaterThanOrEqualTo(4.5));
    });

    test('ensureContrast honours a lower minimum for UI components', () {
      const pale = Rgb(0xBB, 0xDE, 0xFB);
      final adjusted = BrandColors.ensureContrast(pale, Rgb.white, minimum: BrandColors.minUiContrast);
      expect(BrandColors.contrastRatio(adjusted, Rgb.white), greaterThanOrEqualTo(3.0));
    });
  });

  group('AppTheme.build', () {
    test('uses the TypEase defaults when no colours are given', () {
      final theme = AppTheme.build(brightness: Brightness.light);
      final tokens = theme.extension<BrandTokens>();
      expect(tokens, isNotNull);
      expect(tokens!.brand, const Color(0xFF0B2240));
      expect(tokens.onBrand, const Color(0xFFFFFFFF));
      expect(theme.colorScheme.primary, const Color(0xFF0B2240));
    });

    test('keeps the configured brand colour for headers but adjusts it for text', () {
      final theme = AppTheme.build(brightness: Brightness.light, primaryHex: '#FFEB3B', secondaryHex: '#FFEB3B', accentHex: '#FFEB3B');
      final tokens = theme.extension<BrandTokens>()!;
      // The header keeps the centre's yellow, with black text on it.
      expect(tokens.brand, const Color(0xFFFFEB3B));
      expect(tokens.onBrand, const Color(0xFF000000));
      // As a text colour on white, yellow would be unreadable.
      expect(theme.colorScheme.primary, isNot(const Color(0xFFFFEB3B)));
    });

    test('falls back to the defaults for malformed colours', () {
      final theme = AppTheme.build(brightness: Brightness.dark, primaryHex: 'not-a-colour');
      expect(theme.extension<BrandTokens>()!.brand, const Color(0xFF0B2240));
      expect(theme.brightness, Brightness.dark);
    });
  });
}
