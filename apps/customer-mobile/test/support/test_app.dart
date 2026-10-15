import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:typease_customer/core/l10n/app_localizations.dart';
import 'package:typease_customer/core/theme/app_theme.dart';

import 'fixtures.dart';

/// Wraps [child] in a MaterialApp with the app theme and the real ARB
/// messages (read from disk), in the given language.
Widget testApp(Widget child, {String languageCode = 'en'}) {
  final english = arbMessages('en');
  final delegate = PreloadedLocalizationsDelegate(
    <String, Map<String, String>>{'en': english, 'ar': arbMessages('ar')},
    fallback: english,
  );
  return MaterialApp(
    locale: Locale(languageCode),
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: <LocalizationsDelegate<dynamic>>[
      delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    theme: AppTheme.build(brightness: Brightness.light),
    home: child,
  );
}
