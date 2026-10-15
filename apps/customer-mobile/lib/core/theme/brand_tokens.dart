import 'package:flutter/material.dart';

/// Semantic colours that are not part of [ColorScheme]: the raw brand colour
/// for headers, and the status tones used by badges and timelines.
@immutable
class BrandTokens extends ThemeExtension<BrandTokens> {
  const BrandTokens({
    required this.brand,
    required this.onBrand,
    required this.brandDeep,
    required this.accent,
    required this.onAccent,
    required this.success,
    required this.successContainer,
    required this.warning,
    required this.warningContainer,
    required this.danger,
    required this.dangerContainer,
    required this.info,
    required this.infoContainer,
    required this.neutral,
    required this.neutralContainer,
    required this.border,
    required this.mutedText,
    required this.surfaceMuted,
  });

  /// The centre's primary colour exactly as configured (header background).
  final Color brand;
  final Color onBrand;

  /// The brand colour darkened, the far end of the hero gradients.
  final Color brandDeep;

  /// The centre's accent colour, adjusted to be readable as a filled button.
  final Color accent;
  final Color onAccent;

  final Color success;
  final Color successContainer;
  final Color warning;
  final Color warningContainer;
  final Color danger;
  final Color dangerContainer;
  final Color info;
  final Color infoContainer;
  final Color neutral;
  final Color neutralContainer;
  final Color border;
  final Color mutedText;

  /// Quiet fill for inputs, icon wells and secondary tiles.
  final Color surfaceMuted;

  /// The brand hero gradient (headers, welcome panels).
  LinearGradient get brandGradient => LinearGradient(
        begin: AlignmentDirectional.topStart,
        end: AlignmentDirectional.bottomEnd,
        colors: <Color>[brand, brandDeep],
      );

  static BrandTokens of(BuildContext context) {
    final tokens = Theme.of(context).extension<BrandTokens>();
    assert(tokens != null, 'BrandTokens is missing from the theme');
    return tokens!;
  }

  @override
  BrandTokens copyWith({
    Color? brand,
    Color? onBrand,
    Color? brandDeep,
    Color? accent,
    Color? onAccent,
    Color? success,
    Color? successContainer,
    Color? warning,
    Color? warningContainer,
    Color? danger,
    Color? dangerContainer,
    Color? info,
    Color? infoContainer,
    Color? neutral,
    Color? neutralContainer,
    Color? border,
    Color? mutedText,
    Color? surfaceMuted,
  }) {
    return BrandTokens(
      brand: brand ?? this.brand,
      onBrand: onBrand ?? this.onBrand,
      brandDeep: brandDeep ?? this.brandDeep,
      accent: accent ?? this.accent,
      onAccent: onAccent ?? this.onAccent,
      success: success ?? this.success,
      successContainer: successContainer ?? this.successContainer,
      warning: warning ?? this.warning,
      warningContainer: warningContainer ?? this.warningContainer,
      danger: danger ?? this.danger,
      dangerContainer: dangerContainer ?? this.dangerContainer,
      info: info ?? this.info,
      infoContainer: infoContainer ?? this.infoContainer,
      neutral: neutral ?? this.neutral,
      neutralContainer: neutralContainer ?? this.neutralContainer,
      border: border ?? this.border,
      mutedText: mutedText ?? this.mutedText,
      surfaceMuted: surfaceMuted ?? this.surfaceMuted,
    );
  }

  @override
  BrandTokens lerp(ThemeExtension<BrandTokens>? other, double t) {
    if (other is! BrandTokens) return this;
    Color mix(Color a, Color b) => Color.lerp(a, b, t) ?? a;
    return BrandTokens(
      brand: mix(brand, other.brand),
      onBrand: mix(onBrand, other.onBrand),
      brandDeep: mix(brandDeep, other.brandDeep),
      accent: mix(accent, other.accent),
      onAccent: mix(onAccent, other.onAccent),
      success: mix(success, other.success),
      successContainer: mix(successContainer, other.successContainer),
      warning: mix(warning, other.warning),
      warningContainer: mix(warningContainer, other.warningContainer),
      danger: mix(danger, other.danger),
      dangerContainer: mix(dangerContainer, other.dangerContainer),
      info: mix(info, other.info),
      infoContainer: mix(infoContainer, other.infoContainer),
      neutral: mix(neutral, other.neutral),
      neutralContainer: mix(neutralContainer, other.neutralContainer),
      border: mix(border, other.border),
      mutedText: mix(mutedText, other.mutedText),
      surfaceMuted: mix(surfaceMuted, other.surfaceMuted),
    );
  }
}
