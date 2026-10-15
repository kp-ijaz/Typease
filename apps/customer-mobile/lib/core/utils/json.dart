/// Defensive JSON helpers. The API is the source of truth, but a mobile client
/// lives longer than a server release: parsing must never throw on a missing
/// or unexpectedly typed field.
typedef JsonMap = Map<String, dynamic>;

JsonMap asMap(Object? value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    final out = <String, dynamic>{};
    value.forEach((key, val) {
      out[key.toString()] = val;
    });
    return out;
  }
  return <String, dynamic>{};
}

JsonMap? asMapOrNull(Object? value) => value is Map ? asMap(value) : null;

List<dynamic> asList(Object? value) => value is List ? value : const <dynamic>[];

List<JsonMap> asMapList(Object? value) {
  final out = <JsonMap>[];
  for (final item in asList(value)) {
    if (item is Map) out.add(asMap(item));
  }
  return out;
}

List<String> asStringList(Object? value) {
  final out = <String>[];
  for (final item in asList(value)) {
    if (item != null) out.add(item.toString());
  }
  return out;
}

String? asStringOrNull(Object? value) {
  if (value == null) return null;
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return null;
}

String asString(Object? value, [String fallback = '']) => asStringOrNull(value) ?? fallback;

int? asIntOrNull(Object? value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value.trim());
  return null;
}

int asInt(Object? value, [int fallback = 0]) => asIntOrNull(value) ?? fallback;

bool asBool(Object? value, [bool fallback = false]) {
  if (value is bool) return value;
  if (value is String) {
    if (value == 'true') return true;
    if (value == 'false') return false;
  }
  return fallback;
}

/// Parses an ISO-8601 date or date-time. Returns null when absent or invalid.
DateTime? asDate(Object? value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value);
}

/// A text the API returns in both languages: `{ "en": "...", "ar": "..." }`.
class LocalizedText {
  const LocalizedText({required this.en, this.ar});

  factory LocalizedText.fromJson(Object? json) {
    if (json is String) return LocalizedText(en: json);
    final map = asMap(json);
    return LocalizedText(en: asString(map['en']), ar: asStringOrNull(map['ar']));
  }

  static const empty = LocalizedText(en: '');

  final String en;
  final String? ar;

  bool get isEmpty => en.isEmpty && (ar == null || ar!.isEmpty);

  /// Arabic when asked for and available, English otherwise.
  String resolve(String languageCode) {
    final arabic = ar;
    if (languageCode == 'ar' && arabic != null && arabic.trim().isNotEmpty) return arabic;
    if (en.isNotEmpty) return en;
    return arabic ?? '';
  }
}

/// Picks between a pair of `name` / `nameAr` style fields.
String pickLanguage(String languageCode, String? en, String? ar) {
  if (languageCode == 'ar' && ar != null && ar.trim().isNotEmpty) return ar;
  return en ?? ar ?? '';
}
