// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/features/documents/data/upload_rules.dart';

void main() {
  group('sniffMime (file type by content)', () {
    test('recognises the four accepted types', () {
      expect(UploadRules.sniffMime(<int>[0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37]), 'application/pdf');
      expect(UploadRules.sniffMime(<int>[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), 'image/jpeg');
      expect(UploadRules.sniffMime(<int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]), 'image/png');
      expect(
        UploadRules.sniffMime(<int>[0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
        'image/webp',
      );
    });

    test('rejects everything else, including look-alikes and short input', () {
      // A Windows executable renamed to .pdf.
      expect(UploadRules.sniffMime(<int>[0x4D, 0x5A, 0x90, 0x00]), isNull);
      // RIFF container that is not WebP (a WAV file).
      expect(
        UploadRules.sniffMime(<int>[0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
        isNull,
      );
      // GIF and HEIC are not accepted by the document vault.
      expect(UploadRules.sniffMime(<int>[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), isNull);
      expect(UploadRules.sniffMime(<int>[]), isNull);
      expect(UploadRules.sniffMime(<int>[0x25, 0x50]), isNull);
    });
  });

  test('mimeFromName looks at the extension only', () {
    expect(UploadRules.mimeFromName('passport.PDF'), 'application/pdf');
    expect(UploadRules.mimeFromName('photo.jpeg'), 'image/jpeg');
    expect(UploadRules.mimeFromName('photo.JPG'), 'image/jpeg');
    expect(UploadRules.mimeFromName('scan.png'), 'image/png');
    expect(UploadRules.mimeFromName('scan.webp'), 'image/webp');
    expect(UploadRules.mimeFromName('archive.zip'), isNull);
    expect(UploadRules.mimeFromName('no-extension'), isNull);
    expect(UploadRules.mimeFromName('ends-with-dot.'), isNull);
  });

  group('problem', () {
    test('accepts an allowed type up to 15 MB', () {
      expect(UploadRules.problem(sizeBytes: 1, mime: 'application/pdf'), isNull);
      expect(UploadRules.problem(sizeBytes: UploadRules.maxBytes, mime: 'image/jpeg'), isNull);
    });

    test('names the reason', () {
      expect(UploadRules.problem(sizeBytes: 0, mime: 'application/pdf'), 'empty');
      expect(UploadRules.problem(sizeBytes: UploadRules.maxBytes + 1, mime: 'application/pdf'), 'tooLarge');
      expect(UploadRules.problem(sizeBytes: 10, mime: null), 'type');
      expect(UploadRules.problem(sizeBytes: 10, mime: 'image/gif'), 'type');
    });
  });

  group('cleanName', () {
    test('keeps only the last path segment', () {
      expect(UploadRules.cleanName('/storage/emulated/0/DCIM/passport.png', 'image/png'), 'passport.png');
      expect(UploadRules.cleanName(r'C:\Users\me\passport.png', 'image/png'), 'passport.png');
    });

    test('makes the extension match the real type', () {
      expect(UploadRules.cleanName('passport.pdf', 'image/jpeg'), 'passport.jpg');
      expect(UploadRules.cleanName('image_picker_1234', 'image/jpeg'), 'image_picker_1234.jpg');
      expect(UploadRules.cleanName('scan.jpeg', 'image/jpeg'), 'scan.jpeg');
      expect(UploadRules.cleanName('letter.docx', 'application/pdf'), 'letter.pdf');
    });

    test('never returns an empty or over-long name', () {
      expect(UploadRules.cleanName('   ', 'application/pdf'), 'document.pdf');
      final long = '${'a' * 400}.png';
      final cleaned = UploadRules.cleanName(long, 'image/png');
      expect(cleaned.length, 255);
      expect(cleaned.endsWith('.png'), isTrue);
    });
  });
}
