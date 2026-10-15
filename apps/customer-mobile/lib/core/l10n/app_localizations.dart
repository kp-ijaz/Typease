import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';

/// Translations loaded from the ARB files in `assets/l10n/`.
///
/// The ARB files are read at run time instead of being compiled with
/// `flutter gen-l10n`: this keeps the project free of generated code (see
/// ARCHITECTURE.md, "Localisation"). Lookups are by key:
///
/// ```dart
/// context.l10n.t('loginTitle');
/// context.l10n.t('homeGreeting', {'name': 'Fatima'});
/// ```
///
/// Supported message syntax: `{placeholder}` and ICU plurals
/// `{count, plural, =0{...} one{...} other{... # ...}}`.
class AppLocalizations {
  AppLocalizations(this.locale, Map<String, String> messages, [Map<String, String> fallback = const <String, String>{}])
      : _messages = messages,
        _fallback = fallback;

  final Locale locale;
  final Map<String, String> _messages;
  final Map<String, String> _fallback;

  static const List<Locale> supportedLocales = <Locale>[Locale('en'), Locale('ar')];

  static const LocalizationsDelegate<AppLocalizations> delegate = _AppLocalizationsDelegate();

  static AppLocalizations of(BuildContext context) {
    final value = Localizations.of<AppLocalizations>(context, AppLocalizations);
    assert(value != null, 'AppLocalizations.delegate is missing from localizationsDelegates');
    return value!;
  }

  String get languageCode => locale.languageCode;
  bool get isArabic => locale.languageCode == 'ar';

  bool has(String key) => _messages.containsKey(key) || _fallback.containsKey(key);

  /// The message for [key], or the key itself when it is unknown (so a
  /// missing translation is visible instead of crashing).
  String t(String key, [Map<String, Object?> args = const <String, Object?>{}]) {
    final template = _messages[key] ?? _fallback[key];
    if (template == null) return key;
    return formatMessage(template, args, locale.languageCode);
  }

  /// Like [t] but returns [fallback] when the key does not exist. Used for
  /// labels derived from server codes that may be newer than the app.
  String tOr(String key, String fallback, [Map<String, Object?> args = const <String, Object?>{}]) {
    final template = _messages[key] ?? _fallback[key];
    if (template == null) return fallback;
    return formatMessage(template, args, locale.languageCode);
  }

  /// Parses ARB content: drops `@`-prefixed metadata entries.
  static Map<String, String> parseArb(String source) {
    final decoded = jsonDecode(source);
    final out = <String, String>{};
    if (decoded is Map) {
      decoded.forEach((key, value) {
        if (key is String && !key.startsWith('@') && value is String) out[key] = value;
      });
    }
    return out;
  }

  static Future<AppLocalizations> load(Locale locale) async {
    final code = supportedLocales.any((l) => l.languageCode == locale.languageCode) ? locale.languageCode : 'en';
    final english = parseArb(await rootBundle.loadString('assets/l10n/app_en.arb'));
    if (code == 'en') return AppLocalizations(const Locale('en'), english);
    final messages = parseArb(await rootBundle.loadString('assets/l10n/app_$code.arb'));
    return AppLocalizations(Locale(code), messages, english);
  }

  /// Replaces placeholders and resolves plurals. Visible for tests.
  static String formatMessage(String template, Map<String, Object?> args, String languageCode) {
    if (!template.contains('{')) return template;
    final out = StringBuffer();
    var index = 0;
    while (index < template.length) {
      final char = template[index];
      if (char != '{') {
        out.write(char);
        index++;
        continue;
      }
      final end = _matchingBrace(template, index);
      if (end < 0) {
        // Unbalanced: print the rest unchanged.
        out.write(template.substring(index));
        break;
      }
      final inner = template.substring(index + 1, end);
      out.write(_resolve(inner, args, languageCode));
      index = end + 1;
    }
    return out.toString();
  }

  static int _matchingBrace(String text, int open) {
    var depth = 0;
    for (var i = open; i < text.length; i++) {
      final char = text[i];
      if (char == '{') depth++;
      if (char == '}') {
        depth--;
        if (depth == 0) return i;
      }
    }
    return -1;
  }

  static String _resolve(String inner, Map<String, Object?> args, String languageCode) {
    final firstComma = inner.indexOf(',');
    if (firstComma < 0) {
      final name = inner.trim();
      final value = args[name];
      return value == null ? '' : value.toString();
    }
    final name = inner.substring(0, firstComma).trim();
    final rest = inner.substring(firstComma + 1).trimLeft();
    if (!rest.startsWith('plural')) {
      final value = args[name];
      return value == null ? '' : value.toString();
    }
    final secondComma = rest.indexOf(',');
    if (secondComma < 0) return '';
    final forms = _parsePluralForms(rest.substring(secondComma + 1));
    final raw = args[name];
    final count = raw is num ? raw : num.tryParse(raw?.toString() ?? '') ?? 0;
    final other = forms['other'] ?? '';
    final chosen = Intl.pluralLogic<String>(
      count,
      zero: forms['=0'] ?? forms['zero'],
      one: forms['=1'] ?? forms['one'],
      two: forms['=2'] ?? forms['two'],
      few: forms['few'],
      many: forms['many'],
      other: other,
      locale: languageCode,
    );
    final withCount = chosen.replaceAll('#', count.toString());
    return formatMessage(withCount, args, languageCode);
  }

  /// Parses ` =0{none} one{one item} other{# items}` into a map.
  static Map<String, String> _parsePluralForms(String source) {
    final forms = <String, String>{};
    var index = 0;
    while (index < source.length) {
      final open = source.indexOf('{', index);
      if (open < 0) break;
      final selector = source.substring(index, open).trim();
      final close = _matchingBrace(source, open);
      if (close < 0) break;
      if (selector.isNotEmpty) forms[selector] = source.substring(open + 1, close);
      index = close + 1;
    }
    return forms;
  }
}

class _AppLocalizationsDelegate extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  bool isSupported(Locale locale) => AppLocalizations.supportedLocales.any((l) => l.languageCode == locale.languageCode);

  @override
  Future<AppLocalizations> load(Locale locale) => AppLocalizations.load(locale);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

/// A delegate that serves already-loaded messages. Used by widget tests, which
/// read the ARB files from disk instead of the asset bundle.
class PreloadedLocalizationsDelegate extends LocalizationsDelegate<AppLocalizations> {
  const PreloadedLocalizationsDelegate(this.byLanguage, {this.fallback = const <String, String>{}});

  final Map<String, Map<String, String>> byLanguage;
  final Map<String, String> fallback;

  @override
  bool isSupported(Locale locale) => byLanguage.containsKey(locale.languageCode);

  @override
  Future<AppLocalizations> load(Locale locale) async {
    return AppLocalizations(locale, byLanguage[locale.languageCode] ?? const <String, String>{}, fallback);
  }

  @override
  bool shouldReload(PreloadedLocalizationsDelegate old) => false;
}
