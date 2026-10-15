import 'package:flutter/widgets.dart';

import '../utils/json.dart';
import 'app_localizations.dart';

extension L10nContext on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);

  /// `en` or `ar`.
  String get languageCode => AppLocalizations.of(this).languageCode;

  /// Chooses between a `name` / `nameAr` pair from the API.
  String pick(String? en, String? ar) => pickLanguage(AppLocalizations.of(this).languageCode, en, ar);

  /// Resolves a `{ en, ar }` label from the API.
  String label(LocalizedText text) => text.resolve(AppLocalizations.of(this).languageCode);
}
