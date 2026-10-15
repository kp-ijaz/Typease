import 'dart:math' as math;

/// Pure-Dart colour maths for white-label themes (no Flutter imports, so it is
/// unit-testable without a widget binding).
///
/// A centre chooses its own colours. Nothing guarantees they are readable, so
/// every colour that carries text is paired with a computed "on" colour, and
/// colours used AS text are adjusted until they reach the WCAG AA contrast
/// ratio against their background.
class Rgb {
  const Rgb(this.r, this.g, this.b)
      : assert(r >= 0 && r <= 255),
        assert(g >= 0 && g <= 255),
        assert(b >= 0 && b <= 255);

  final int r;
  final int g;
  final int b;

  static const Rgb white = Rgb(255, 255, 255);
  static const Rgb black = Rgb(0, 0, 0);

  /// Near-black used for body text on light surfaces.
  static const Rgb ink = Rgb(11, 18, 32);

  static final RegExp _hex6 = RegExp(r'^#?([0-9a-fA-F]{6})$');
  static final RegExp _hex3 = RegExp(r'^#?([0-9a-fA-F]{3})$');

  /// Parses `#0B7AD1`, `0B7AD1` or the short form `#07D`. Null when invalid.
  static Rgb? tryParseHex(String? input) {
    if (input == null) return null;
    final text = input.trim();
    final long = _hex6.firstMatch(text);
    if (long != null) {
      final value = int.parse(long.group(1)!, radix: 16);
      return Rgb((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF);
    }
    final short = _hex3.firstMatch(text);
    if (short != null) {
      final digits = short.group(1)!;
      final r = int.parse(digits[0] * 2, radix: 16);
      final g = int.parse(digits[1] * 2, radix: 16);
      final b = int.parse(digits[2] * 2, radix: 16);
      return Rgb(r, g, b);
    }
    return null;
  }

  /// 0xAARRGGBB with full opacity, for `Color(int)`.
  int get argb => 0xFF000000 | (r << 16) | (g << 8) | b;

  String get hex {
    String two(int v) => v.toRadixString(16).padLeft(2, '0').toUpperCase();
    return '#${two(r)}${two(g)}${two(b)}';
  }

  /// WCAG 2.x relative luminance (0 = black, 1 = white).
  double get luminance {
    double channel(int value) {
      final s = value / 255.0;
      return s <= 0.03928 ? s / 12.92 : math.pow((s + 0.055) / 1.055, 2.4).toDouble();
    }

    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  /// Linear mix towards [other]; `t = 0` is this colour, `t = 1` is [other].
  Rgb mix(Rgb other, double t) {
    final clamped = t < 0 ? 0.0 : (t > 1 ? 1.0 : t);
    int lerp(int a, int b) => (a + (b - a) * clamped).round();
    return Rgb(lerp(r, other.r), lerp(g, other.g), lerp(b, other.b));
  }

  @override
  bool operator ==(Object other) => other is Rgb && other.r == r && other.g == g && other.b == b;

  @override
  int get hashCode => Object.hash(r, g, b);

  @override
  String toString() => hex;
}

class BrandColors {
  const BrandColors._();

  /// WCAG AA for normal text.
  static const double minTextContrast = 4.5;

  /// WCAG AA for large text and UI components.
  static const double minUiContrast = 3.0;

  /// TypEase defaults, used when a centre's colour is missing or malformed.
  static const Rgb defaultPrimary = Rgb(0x0B, 0x22, 0x40);
  static const Rgb defaultSecondary = Rgb(0x0B, 0x7A, 0xD1);
  static const Rgb defaultAccent = Rgb(0x00, 0xA1, 0x66);

  /// WCAG contrast ratio between two colours (1.0 - 21.0).
  static double contrastRatio(Rgb a, Rgb b) {
    final la = a.luminance;
    final lb = b.luminance;
    final lighter = la > lb ? la : lb;
    final darker = la > lb ? lb : la;
    return (lighter + 0.05) / (darker + 0.05);
  }

  /// White or black, whichever is more readable on [background].
  ///
  /// With pure white and pure black the better of the two always reaches at
  /// least 4.58:1 (the worst case is a mid-tone of luminance 0.179), so text
  /// on any brand colour meets WCAG AA.
  static Rgb onColorFor(Rgb background) {
    final withWhite = contrastRatio(Rgb.white, background);
    final withBlack = contrastRatio(Rgb.black, background);
    return withWhite >= withBlack ? Rgb.white : Rgb.black;
  }

  /// Fill colour for a solid button in [brand], and the label colour on it.
  /// White labels look more refined, so a mid-tone brand colour is darkened
  /// just enough for white to reach AA; only light colours (yellow, mint...)
  /// keep a black label.
  static (Rgb fill, Rgb label) buttonColors(Rgb brand) {
    if (contrastRatio(Rgb.white, brand) >= 2.4) return (ensureContrast(brand, Rgb.white), Rgb.white);
    return (brand, onColorFor(brand));
  }

  /// Returns [foreground] unchanged when it already has at least [minimum]
  /// contrast against [background]; otherwise moves it step by step towards
  /// black (on light backgrounds) or white (on dark backgrounds) until it does.
  static Rgb ensureContrast(Rgb foreground, Rgb background, {double minimum = minTextContrast}) {
    if (contrastRatio(foreground, background) >= minimum) return foreground;
    final target = background.luminance > 0.5 ? Rgb.black : Rgb.white;
    var candidate = foreground;
    for (var step = 1; step <= 20; step++) {
      candidate = foreground.mix(target, step / 20.0);
      if (contrastRatio(candidate, background) >= minimum) return candidate;
    }
    return target;
  }
}
