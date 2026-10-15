/// Checks done on the device before any byte is uploaded. They mirror the
/// server defaults (`UPLOAD_ALLOWED_MIME`, `UPLOAD_MAX_BYTES`); a centre's
/// server may be configured differently and always has the final word.
class UploadRules {
  const UploadRules._();

  /// 15 MB, the API default.
  static const int maxBytes = 15 * 1024 * 1024;

  static const List<String> allowedMime = <String>['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

  static const List<String> allowedExtensions = <String>['pdf', 'jpg', 'jpeg', 'png', 'webp'];

  /// The file type by content ("magic bytes"), or null when it is not one of
  /// the types the vault accepts. [head] is the first bytes of the file
  /// (12 are enough).
  static String? sniffMime(List<int> head) {
    bool startsWith(List<int> signature, [int offset = 0]) {
      if (head.length < offset + signature.length) return false;
      for (var i = 0; i < signature.length; i++) {
        if (head[offset + i] != signature[i]) return false;
      }
      return true;
    }

    if (startsWith(const <int>[0x25, 0x50, 0x44, 0x46])) return 'application/pdf'; // %PDF
    if (startsWith(const <int>[0xFF, 0xD8, 0xFF])) return 'image/jpeg';
    if (startsWith(const <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
    if (startsWith(const <int>[0x52, 0x49, 0x46, 0x46]) && startsWith(const <int>[0x57, 0x45, 0x42, 0x50], 8)) {
      return 'image/webp'; // RIFF....WEBP
    }
    return null;
  }

  /// The type suggested by the file name, or null.
  static String? mimeFromName(String filename) {
    final dot = filename.lastIndexOf('.');
    if (dot < 0 || dot == filename.length - 1) return null;
    switch (filename.substring(dot + 1).toLowerCase()) {
      case 'pdf':
        return 'application/pdf';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      default:
        return null;
    }
  }

  /// Returns null when the file may be uploaded, otherwise the reason:
  /// `empty`, `tooLarge` or `type`.
  static String? problem({required int sizeBytes, required String? mime}) {
    if (sizeBytes <= 0) return 'empty';
    if (sizeBytes > maxBytes) return 'tooLarge';
    if (mime == null || !allowedMime.contains(mime)) return 'type';
    return null;
  }

  /// A safe display / upload name: the last path segment, never longer than
  /// 255 characters, with a fitting extension.
  static String cleanName(String name, String mime) {
    var base = name.replaceAll('\\', '/');
    final slash = base.lastIndexOf('/');
    if (slash >= 0) base = base.substring(slash + 1);
    base = base.trim();
    if (base.isEmpty) base = 'document';
    if (mimeFromName(base) != mime) {
      final dot = base.lastIndexOf('.');
      final stem = dot > 0 ? base.substring(0, dot) : base;
      base = '$stem.${_extensionFor(mime)}';
    }
    if (base.length > 255) base = base.substring(base.length - 255);
    return base;
  }

  static String _extensionFor(String mime) {
    switch (mime) {
      case 'application/pdf':
        return 'pdf';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return 'jpg';
    }
  }
}
