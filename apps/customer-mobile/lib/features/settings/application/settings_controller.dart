import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers.dart';
import '../../../core/storage/prefs_keys.dart';

/// Device-level preferences (not the customer's profile on the server).
@immutable
class AppPreferences {
  const AppPreferences({
    required this.languageCode,
    required this.languageChosen,
    required this.themeMode,
    required this.onboardingSeen,
  });

  /// Effective language: `en` or `ar`.
  final String languageCode;

  /// True once the user picked a language themselves. Until then the centre's
  /// default language may replace the device language.
  final bool languageChosen;
  final ThemeMode themeMode;
  final bool onboardingSeen;

  Locale get locale => Locale(languageCode);

  AppPreferences copyWith({String? languageCode, bool? languageChosen, ThemeMode? themeMode, bool? onboardingSeen}) {
    return AppPreferences(
      languageCode: languageCode ?? this.languageCode,
      languageChosen: languageChosen ?? this.languageChosen,
      themeMode: themeMode ?? this.themeMode,
      onboardingSeen: onboardingSeen ?? this.onboardingSeen,
    );
  }
}

const List<String> kSupportedLanguages = <String>['en', 'ar'];

class SettingsController extends Notifier<AppPreferences> {
  @override
  AppPreferences build() {
    final prefs = ref.watch(sharedPreferencesProvider);
    final saved = prefs.getString(PrefsKeys.languageCode);
    final String? valid = (saved != null && kSupportedLanguages.contains(saved)) ? saved : null;
    return AppPreferences(
      languageCode: valid ?? _deviceLanguage(),
      languageChosen: valid != null,
      themeMode: _parseThemeMode(prefs.getString(PrefsKeys.themeMode)),
      onboardingSeen: prefs.getBool(PrefsKeys.onboardingSeen) ?? false,
    );
  }

  Future<void> setLanguage(String code) async {
    if (!kSupportedLanguages.contains(code)) return;
    state = state.copyWith(languageCode: code, languageChosen: true);
    await ref.read(sharedPreferencesProvider).setString(PrefsKeys.languageCode, code);
  }

  /// Uses the centre's default language unless the user chose one already.
  void applyTenantDefaultLanguage(String code) {
    if (state.languageChosen || !kSupportedLanguages.contains(code)) return;
    if (state.languageCode == code) return;
    state = state.copyWith(languageCode: code);
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    state = state.copyWith(themeMode: mode);
    await ref.read(sharedPreferencesProvider).setString(PrefsKeys.themeMode, mode.name);
  }

  Future<void> markOnboardingSeen() async {
    state = state.copyWith(onboardingSeen: true);
    await ref.read(sharedPreferencesProvider).setBool(PrefsKeys.onboardingSeen, true);
  }

  static String _deviceLanguage() {
    final code = PlatformDispatcher.instance.locale.languageCode;
    return kSupportedLanguages.contains(code) ? code : 'en';
  }

  static ThemeMode _parseThemeMode(String? value) {
    if (value == 'light') return ThemeMode.light;
    if (value == 'dark') return ThemeMode.dark;
    return ThemeMode.system;
  }
}

final settingsControllerProvider = NotifierProvider<SettingsController, AppPreferences>(SettingsController.new);
