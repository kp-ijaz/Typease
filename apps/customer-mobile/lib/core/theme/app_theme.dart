import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'brand_colors.dart';
import 'brand_tokens.dart';

/// Builds the Material theme from a centre's three brand colours.
///
/// No colour of any centre is compiled into the app: the values come from
/// `GET /public/tenant-config` at run time. The TypEase defaults are used only
/// before a centre is selected or when a configured value is not a valid hex
/// colour.
class AppTheme {
  const AppTheme._();

  static const String fontFamily = 'Poppins';

  /// Poppins (the TypEase brand font) has no Arabic glyphs; Arabic text falls back to Plex.
  static const List<String> fontFallback = <String>['IBMPlexSansArabic'];

  /// Corner radii used across the app, so every surface feels like one family.
  static const double radiusSm = 10;
  static const double radiusMd = 14;
  static const double radiusLg = 20;
  static const double radiusXl = 28;

  static ThemeData build({
    required Brightness brightness,
    String? primaryHex,
    String? secondaryHex,
    String? accentHex,
  }) {
    final isDark = brightness == Brightness.dark;

    final brand = Rgb.tryParseHex(primaryHex) ?? BrandColors.defaultPrimary;
    final secondaryRaw = Rgb.tryParseHex(secondaryHex) ?? BrandColors.defaultSecondary;
    final accentRaw = Rgb.tryParseHex(accentHex) ?? BrandColors.defaultAccent;

    final surface = isDark ? const Rgb(0x14, 0x1A, 0x24) : Rgb.white;
    final background = isDark ? const Rgb(0x0B, 0x0F, 0x17) : const Rgb(0xF6, 0xF7, 0xFB);
    final surfaceMuted = isDark ? const Rgb(0x1C, 0x23, 0x30) : const Rgb(0xF1, 0xF3, 0xF8);
    final onSurface = isDark ? const Rgb(0xEC, 0xEF, 0xF5) : const Rgb(0x10, 0x18, 0x28);
    final muted = isDark ? const Rgb(0x9A, 0xA4, 0xB5) : const Rgb(0x5D, 0x67, 0x7A);
    final border = isDark ? const Rgb(0x26, 0x30, 0x40) : const Rgb(0xE6, 0xE9, 0xF0);

    // Colours used AS text or icons on the surface must reach AA contrast.
    final primary = BrandColors.ensureContrast(brand, surface);
    final secondary = BrandColors.ensureContrast(secondaryRaw, surface, minimum: BrandColors.minUiContrast);
    final accent = BrandColors.ensureContrast(accentRaw, surface, minimum: BrandColors.minUiContrast);
    final (buttonFill, buttonLabel) = BrandColors.buttonColors(secondaryRaw);
    final link = BrandColors.ensureContrast(secondaryRaw, surface);

    final success = isDark ? const Rgb(0x4A, 0xD6, 0x9A) : const Rgb(0x06, 0x76, 0x47);
    final warning = isDark ? const Rgb(0xF2, 0xB8, 0x4B) : const Rgb(0x93, 0x5A, 0x00);
    final danger = isDark ? const Rgb(0xFF, 0x8A, 0x80) : const Rgb(0xC0, 0x26, 0x1C);
    final info = isDark ? const Rgb(0x7C, 0xB7, 0xFF) : const Rgb(0x17, 0x5C, 0xD3);
    final neutral = muted;

    Rgb container(Rgb tone) => surface.mix(tone, isDark ? 0.20 : 0.10);
    Color c(Rgb value) => Color(value.argb);

    final scheme = ColorScheme.fromSeed(seedColor: c(brand), brightness: brightness).copyWith(
      primary: c(primary),
      onPrimary: c(BrandColors.onColorFor(primary)),
      primaryContainer: c(container(secondaryRaw)),
      onPrimaryContainer: c(link),
      secondary: c(secondary),
      onSecondary: c(BrandColors.onColorFor(secondary)),
      tertiary: c(accent),
      onTertiary: c(BrandColors.onColorFor(accent)),
      surface: c(surface),
      onSurface: c(onSurface),
      onSurfaceVariant: c(muted),
      surfaceContainerHighest: c(surfaceMuted),
      surfaceContainerHigh: c(surfaceMuted),
      surfaceContainer: c(surfaceMuted),
      surfaceContainerLow: c(surface),
      surfaceContainerLowest: c(surface),
      error: c(danger),
      onError: c(BrandColors.onColorFor(danger)),
      outline: c(border),
      outlineVariant: c(border),
      shadow: const Color(0xFF0B1220),
    );

    final tokens = BrandTokens(
      brand: c(brand),
      onBrand: c(BrandColors.onColorFor(brand)),
      brandDeep: c(brand.mix(Rgb.black, 0.35)),
      accent: c(accent),
      onAccent: c(BrandColors.onColorFor(accent)),
      success: c(success),
      successContainer: c(container(success)),
      warning: c(warning),
      warningContainer: c(container(warning)),
      danger: c(danger),
      dangerContainer: c(container(danger)),
      info: c(info),
      infoContainer: c(container(info)),
      neutral: c(neutral),
      neutralContainer: c(container(neutral)),
      border: c(border),
      mutedText: c(muted),
      surfaceMuted: c(surfaceMuted),
    );

    final text = _textTheme(c(onSurface), c(muted));
    final buttonShape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusMd));
    const buttonMinimum = Size(64, 54);
    const buttonPadding = EdgeInsets.symmetric(horizontal: 20, vertical: 14);
    final buttonText = text.labelLarge;

    OutlineInputBorder inputBorder(Color color, [double width = 1]) {
      return OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusMd),
        borderSide: BorderSide(color: color, width: width),
      );
    }

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: fontFamily,
      fontFamilyFallback: fontFallback,
      textTheme: text,
      scaffoldBackgroundColor: c(background),
      canvasColor: c(background),
      splashFactory: InkSparkle.splashFactory,
      visualDensity: VisualDensity.standard,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      extensions: <ThemeExtension<dynamic>>[tokens],
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: <TargetPlatform, PageTransitionsBuilder>{
          TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        },
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: c(background),
        surfaceTintColor: Colors.transparent,
        foregroundColor: c(onSurface),
        elevation: 0,
        scrolledUnderElevation: 0.5,
        shadowColor: c(border),
        centerTitle: false,
        titleSpacing: 20,
        titleTextStyle: text.titleLarge,
        iconTheme: IconThemeData(color: c(onSurface), size: 22),
        actionsIconTheme: IconThemeData(color: c(onSurface), size: 22),
      ),
      iconTheme: IconThemeData(color: c(onSurface), size: 22),
      dividerTheme: DividerThemeData(color: c(border), thickness: 1, space: 1),
      cardTheme: CardThemeData(
        color: c(surface),
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusLg), side: BorderSide(color: c(border))),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: c(buttonFill),
          foregroundColor: c(buttonLabel),
          disabledBackgroundColor: c(surfaceMuted),
          disabledForegroundColor: c(muted),
          minimumSize: buttonMinimum,
          padding: buttonPadding,
          shape: buttonShape,
          textStyle: buttonText,
          elevation: 0,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: c(surface),
          foregroundColor: c(onSurface),
          minimumSize: buttonMinimum,
          padding: buttonPadding,
          shape: buttonShape,
          textStyle: buttonText,
          elevation: 0,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: c(onSurface),
          backgroundColor: c(surface),
          minimumSize: buttonMinimum,
          padding: buttonPadding,
          shape: buttonShape,
          textStyle: buttonText,
          side: BorderSide(color: c(border), width: 1.2),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: c(link),
          textStyle: text.labelLarge?.copyWith(fontSize: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSm)),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: c(onSurface)),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: c(buttonFill),
        foregroundColor: c(buttonLabel),
        elevation: 2,
        highlightElevation: 4,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusLg)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c(surfaceMuted),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 17),
        hintStyle: text.bodyLarge?.copyWith(color: c(muted.mix(surface, 0.2))),
        labelStyle: text.bodyLarge?.copyWith(color: c(muted)),
        floatingLabelStyle: text.bodyMedium?.copyWith(color: c(link), fontWeight: FontWeight.w600),
        helperStyle: text.bodySmall?.copyWith(color: c(muted)),
        errorStyle: text.bodySmall?.copyWith(color: c(danger), fontWeight: FontWeight.w500),
        prefixIconColor: WidgetStateColor.resolveWith(
          (states) => states.contains(WidgetState.focused) ? c(link) : c(muted),
        ),
        suffixIconColor: c(muted),
        border: inputBorder(Colors.transparent),
        enabledBorder: inputBorder(Colors.transparent),
        focusedBorder: inputBorder(c(link), 1.6),
        errorBorder: inputBorder(c(danger).withValues(alpha: 0.7)),
        focusedErrorBorder: inputBorder(c(danger), 1.6),
        disabledBorder: inputBorder(Colors.transparent),
        errorMaxLines: 3,
        helperMaxLines: 3,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: c(surface),
        selectedColor: c(buttonFill),
        secondarySelectedColor: c(buttonFill),
        disabledColor: c(surfaceMuted),
        labelStyle: text.labelLarge?.copyWith(fontSize: 13.5, color: c(onSurface)),
        secondaryLabelStyle: text.labelLarge?.copyWith(fontSize: 13.5, color: c(buttonLabel)),
        side: BorderSide(color: c(border)),
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        showCheckmark: false,
        iconTheme: IconThemeData(color: c(muted), size: 18),
      ),
      listTileTheme: ListTileThemeData(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
        iconColor: c(muted),
        titleTextStyle: text.titleSmall,
        subtitleTextStyle: text.bodySmall?.copyWith(color: c(muted)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusMd)),
        minVerticalPadding: 12,
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c(buttonLabel) : c(surface)),
        trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c(buttonFill) : c(border)),
        trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
      ),
      checkboxTheme: CheckboxThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        side: BorderSide(color: c(muted), width: 1.5),
        fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c(buttonFill) : Colors.transparent),
        checkColor: WidgetStateProperty.all(c(buttonLabel)),
      ),
      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c(buttonFill) : c(muted)),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: c(link),
        linearTrackColor: c(surfaceMuted),
        circularTrackColor: Colors.transparent,
        linearMinHeight: 6,
        borderRadius: const BorderRadius.all(Radius.circular(99)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: c(isDark ? surfaceMuted : const Rgb(0x10, 0x18, 0x28)),
        contentTextStyle: text.bodyMedium?.copyWith(color: Colors.white),
        actionTextColor: c(isDark ? link : const Rgb(0x9E, 0xC9, 0xFF)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusMd)),
        insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        elevation: 0,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: c(surface),
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusXl)),
        titleTextStyle: text.titleLarge,
        contentTextStyle: text.bodyMedium?.copyWith(color: c(muted)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: c(surface),
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: c(surface),
        showDragHandle: true,
        dragHandleColor: c(border),
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(radiusXl))),
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: c(onSurface),
        unselectedLabelColor: c(muted),
        labelStyle: text.titleSmall,
        unselectedLabelStyle: text.titleSmall?.copyWith(fontWeight: FontWeight.w500),
        indicatorColor: c(link),
        dividerColor: c(border),
        indicatorSize: TabBarIndicatorSize.label,
      ),
      badgeTheme: BadgeThemeData(backgroundColor: c(danger), textColor: Colors.white, textStyle: text.labelSmall),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(color: c(const Rgb(0x10, 0x18, 0x28)), borderRadius: BorderRadius.circular(radiusSm)),
        textStyle: text.bodySmall?.copyWith(color: Colors.white),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: c(surface),
        surfaceTintColor: Colors.transparent,
        indicatorColor: c(container(secondaryRaw)),
        indicatorShape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusMd)),
        elevation: 0,
        height: 68,
        shadowColor: Colors.transparent,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        iconTheme: WidgetStateProperty.resolveWith(
          (s) => IconThemeData(size: 24, color: s.contains(WidgetState.selected) ? c(link) : c(muted)),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (s) => text.labelSmall?.copyWith(
            fontSize: 11.5,
            color: s.contains(WidgetState.selected) ? c(onSurface) : c(muted),
            fontWeight: s.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          ),
        ),
      ),
      cupertinoOverrideTheme: NoDefaultCupertinoThemeData(primaryColor: c(link)),
    );
  }

  /// A deliberate type scale: tight, confident headings and relaxed body text.
  static TextTheme _textTheme(Color ink, Color muted) {
    TextStyle style(double size, FontWeight weight, {double height = 1.3, double spacing = 0, Color? color}) => TextStyle(
          fontFamily: fontFamily,
          fontFamilyFallback: fontFallback,
          fontSize: size,
          fontWeight: weight,
          height: height,
          letterSpacing: spacing,
          color: color ?? ink,
        );
    // Poppins is wide with tall ascenders: slightly smaller sizes and tighter
    // line heights than a narrower face would need.
    return TextTheme(
      displayLarge: style(44, FontWeight.w700, height: 1.1, spacing: -1),
      displayMedium: style(36, FontWeight.w700, height: 1.12, spacing: -0.8),
      displaySmall: style(30, FontWeight.w700, height: 1.15, spacing: -0.6),
      headlineLarge: style(28, FontWeight.w700, height: 1.2, spacing: -0.5),
      headlineMedium: style(25, FontWeight.w700, height: 1.22, spacing: -0.4),
      headlineSmall: style(21.5, FontWeight.w600, height: 1.27, spacing: -0.3),
      titleLarge: style(18, FontWeight.w600, height: 1.3, spacing: -0.15),
      titleMedium: style(16, FontWeight.w600, height: 1.35, spacing: -0.1),
      titleSmall: style(14, FontWeight.w600, height: 1.35),
      bodyLarge: style(15.5, FontWeight.w400, height: 1.5),
      bodyMedium: style(14, FontWeight.w400, height: 1.5),
      bodySmall: style(12.5, FontWeight.w400, height: 1.45, color: muted),
      labelLarge: style(14.5, FontWeight.w600, height: 1.2, spacing: 0.1),
      labelMedium: style(12.5, FontWeight.w500, height: 1.3, spacing: 0.1),
      labelSmall: style(11, FontWeight.w500, height: 1.3, spacing: 0.3),
    );
  }

  /// Soft, layered shadow for raised cards (hero panels, floating bars).
  static List<BoxShadow> softShadow(BuildContext context, {double strength = 1}) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    if (dark) return const <BoxShadow>[];
    return <BoxShadow>[
      BoxShadow(color: const Color(0xFF0B1220).withValues(alpha: 0.04 * strength), blurRadius: 2, offset: const Offset(0, 1)),
      BoxShadow(color: const Color(0xFF0B1220).withValues(alpha: 0.06 * strength), blurRadius: 24, offset: const Offset(0, 10)),
    ];
  }
}
