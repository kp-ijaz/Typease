import 'dart:convert';
import 'dart:io';

/// Loads a JSON response that was captured from the local TypEase API
/// (see test/fixtures/README.md). Tests run with the package root as the
/// working directory.
dynamic fixture(String name) {
  final file = File('test/fixtures/$name.json');
  return jsonDecode(file.readAsStringSync());
}

/// The messages of an ARB file, without metadata entries.
Map<String, String> arbMessages(String languageCode) {
  final decoded = jsonDecode(File('assets/l10n/app_$languageCode.arb').readAsStringSync()) as Map<String, dynamic>;
  final out = <String, String>{};
  decoded.forEach((key, value) {
    if (!key.startsWith('@') && value is String) out[key] = value;
  });
  return out;
}
