// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'dart:io';
import 'dart:ui' show Locale;

import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/l10n/app_localizations.dart';

import '../support/fixtures.dart';

/// The placeholder names of an ARB message, including those inside plural forms.
Set<String> placeholders(String template) {
  final names = <String>{};
  var index = 0;
  while (index < template.length) {
    final open = template.indexOf('{', index);
    if (open < 0) break;
    final close = _matching(template, open);
    if (close < 0) break;
    final inner = template.substring(open + 1, close);
    final comma = inner.indexOf(',');
    if (comma < 0) {
      names.add(inner.trim());
    } else {
      names.add(inner.substring(0, comma).trim());
      // "plural, =1{...} other{...}" - look into each form.
      final rest = inner.substring(comma + 1);
      var cursor = 0;
      while (cursor < rest.length) {
        final formOpen = rest.indexOf('{', cursor);
        if (formOpen < 0) break;
        final formClose = _matching(rest, formOpen);
        if (formClose < 0) break;
        names.addAll(placeholders(rest.substring(formOpen + 1, formClose)));
        cursor = formClose + 1;
      }
    }
    index = close + 1;
  }
  return names;
}

int _matching(String text, int open) {
  var depth = 0;
  for (var i = open; i < text.length; i++) {
    if (text[i] == '{') depth++;
    if (text[i] == '}') {
      depth--;
      if (depth == 0) return i;
    }
  }
  return -1;
}

/// Keys that the code looks up with a literal string: `.t('key'`, `.tOr('key'`,
/// plus the keys handed to helpers that translate later.
Set<String> keysUsedInCode() {
  final lookups = RegExp(r"\.(?:t|tOr)\(\s*'([^'$]+)'");
  final deferred = RegExp(r"(?:_notify|SignInRejected)\(\s*'([^'$]+)'");
  final keys = <String>{};
  final files = Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'));
  for (final file in files) {
    final source = file.readAsStringSync();
    for (final match in lookups.allMatches(source)) {
      keys.add(match.group(1)!);
    }
    for (final match in deferred.allMatches(source)) {
      keys.add(match.group(1)!);
    }
  }
  return keys;
}

void main() {
  final english = arbMessages('en');
  final arabic = arbMessages('ar');

  group('ARB files', () {
    test('English and Arabic define exactly the same keys', () {
      expect(arabic.keys.toSet().difference(english.keys.toSet()), isEmpty, reason: 'keys only in app_ar.arb');
      expect(english.keys.toSet().difference(arabic.keys.toSet()), isEmpty, reason: 'keys only in app_en.arb');
      expect(english.length, greaterThan(600));
    });

    test('no message is empty', () {
      for (final entry in english.entries) {
        expect(entry.value.trim(), isNotEmpty, reason: 'en: ${entry.key}');
      }
      for (final entry in arabic.entries) {
        expect(entry.value.trim(), isNotEmpty, reason: 'ar: ${entry.key}');
      }
    });

    test('both languages use the same placeholders in every message', () {
      for (final key in english.keys) {
        expect(placeholders(arabic[key] ?? ''), placeholders(english[key]!), reason: key);
      }
    });

    test('braces are balanced in every message', () {
      for (final messages in <Map<String, String>>[english, arabic]) {
        for (final entry in messages.entries) {
          final opens = '{'.allMatches(entry.value).length;
          final closes = '}'.allMatches(entry.value).length;
          expect(opens, closes, reason: entry.key);
        }
      }
    });

    test('every key the code looks up exists in the ARB files', () {
      final used = keysUsedInCode();
      expect(used.length, greaterThan(400), reason: 'the scan of lib/ found suspiciously few keys');
      final missing = used.where((key) => !english.containsKey(key)).toList()..sort();
      expect(missing, isEmpty);
    });

    test('Arabic messages are actually Arabic (spot check of screen titles)', () {
      final arabicLetters = RegExp(r'[؀-ۿ]');
      for (final key in <String>['loginTitle', 'homeGreeting', 'timelineTitle', 'fieldEmail', 'fieldPassword', 'errorSessionExpired']) {
        expect(arabicLetters.hasMatch(arabic[key]!), isTrue, reason: key);
        expect(arabicLetters.hasMatch(english[key]!), isFalse, reason: key);
      }
    });
  });

  group('formatMessage', () {
    test('replaces placeholders', () {
      expect(AppLocalizations.formatMessage('Hello, {name}', <String, Object?>{'name': 'Fatima'}, 'en'), 'Hello, Fatima');
      expect(
        AppLocalizations.formatMessage('{a} of {b}', <String, Object?>{'a': 2, 'b': 5}, 'en'),
        '2 of 5',
      );
    });

    test('a missing value becomes empty text instead of a visible placeholder', () {
      expect(AppLocalizations.formatMessage('Hello, {name}', const <String, Object?>{}, 'en'), 'Hello, ');
    });

    test('text without placeholders is returned unchanged', () {
      expect(AppLocalizations.formatMessage('Sign in', const <String, Object?>{}, 'en'), 'Sign in');
    });

    test('unbalanced braces do not throw', () {
      expect(AppLocalizations.formatMessage('Broken {name', <String, Object?>{'name': 'x'}, 'en'), 'Broken {name');
    });

    test('English plurals', () {
      const template = '{count, plural, =0{No requests} =1{1 request} other{# requests}}';
      String at(int count) => AppLocalizations.formatMessage(template, <String, Object?>{'count': count}, 'en');
      expect(at(0), 'No requests');
      expect(at(1), '1 request');
      expect(at(2), '2 requests');
      expect(at(25), '25 requests');
    });

    test('placeholders inside a plural form are replaced too', () {
      const template = '{count, plural, =1{1 file for {name}} other{# files for {name}}}';
      expect(
        AppLocalizations.formatMessage(template, <String, Object?>{'count': 3, 'name': 'Omar'}, 'en'),
        '3 files for Omar',
      );
    });
  });

  group('AppLocalizations', () {
    test('real messages: placeholder and plural in both languages', () {
      final en = AppLocalizations(const Locale('en'), english);
      final ar = AppLocalizations(const Locale('ar'), arabic, english);

      expect(en.t('homeGreeting', <String, Object?>{'name': 'Fatima'}), 'Hello, Fatima');
      expect(ar.t('homeGreeting', <String, Object?>{'name': 'فاطمة'}), 'مرحباً، فاطمة');

      expect(en.t('processingDays', <String, Object?>{'count': 1}), 'About 1 day');
      expect(en.t('processingDays', <String, Object?>{'count': 3}), 'About 3 days');

      // Arabic has its own forms for 1, 2, 3-10 and 11+.
      expect(ar.t('processingDays', <String, Object?>{'count': 1}), 'حوالي يوم واحد');
      expect(ar.t('processingDays', <String, Object?>{'count': 2}), 'حوالي يومين');
      expect(ar.t('processingDays', <String, Object?>{'count': 3}), 'حوالي 3 أيام');
      expect(ar.t('processingDays', <String, Object?>{'count': 11}), 'حوالي 11 يوماً');
    });

    test('an unknown key is shown as the key; tOr uses the given fallback', () {
      final en = AppLocalizations(const Locale('en'), english);
      expect(en.t('thisKeyDoesNotExist'), 'thisKeyDoesNotExist');
      expect(en.tOr('requestStatus_SOMETHING_NEW', 'Something new'), 'Something new');
      expect(en.has('loginTitle'), isTrue);
      expect(en.has('thisKeyDoesNotExist'), isFalse);
    });

    test('a key missing in Arabic falls back to English', () {
      final ar = AppLocalizations(const Locale('ar'), const <String, String>{}, english);
      expect(ar.t('loginTitle'), english['loginTitle']);
      expect(ar.isArabic, isTrue);
    });

    test('parseArb drops metadata entries', () {
      final parsed = AppLocalizations.parseArb('{"@@locale":"en","hello":"Hello","@hello":{"description":"greeting"}}');
      expect(parsed, <String, String>{'hello': 'Hello'});
    });
  });
}
