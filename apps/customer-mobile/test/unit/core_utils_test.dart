// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:typease_customer/core/config/app_config.dart';
import 'package:typease_customer/core/errors/api_exception.dart';
import 'package:typease_customer/core/network/url_rewriter.dart';
import 'package:typease_customer/core/utils/dates.dart';
import 'package:typease_customer/core/utils/json.dart';
import 'package:typease_customer/core/utils/validators.dart';

import '../support/fixtures.dart';

void main() {
  setUpAll(() async {
    await initializeDateFormatting();
  });

  group('ApiException.fromResponse (real error bodies)', () {
    test('wrong password', () {
      final error = ApiException.fromResponse(401, fixture('error_login'));
      expect(error.kind, ApiErrorKind.unauthorized);
      expect(error.code, 'INVALID_CREDENTIALS');
      expect(error.message, 'The email or password is incorrect.');
      expect(error.statusCode, 401);
      // Not a session problem: the user is not signed in yet.
      expect(error.isSessionExpired, isFalse);
      expect(error.fieldErrors, isEmpty);
    });

    test('request validation: details use "path"', () {
      final error = ApiException.fromResponse(400, fixture('error_validation'));
      expect(error.kind, ApiErrorKind.validation);
      expect(error.fieldErrors.map((f) => f.field), <String>['fullName', 'email', 'password', 'password', 'acceptTerms']);
      expect(error.fieldErrorMap['email'], 'Invalid email');
    });

    test('form validation: details use "field" and carry a code', () {
      final error = ApiException.fromResponse(422, fixture('error_fields'));
      expect(error.kind, ApiErrorKind.validation);
      expect(error.code, 'FORM_INVALID');
      expect(error.fieldErrors, hasLength(2));
      expect(error.fieldErrors.first.field, 'dateOfBirth');
      expect(error.fieldErrors.first.code, 'INVALID_FORMAT');
      expect(error.fieldErrorMap['visaType'], 'Type of visa: choose one of the listed options.');
    });

    test('incomplete form on submit', () {
      final error = ApiException.fromResponse(422, fixture('error_form_invalid'));
      expect(error.fieldErrors, hasLength(5));
      expect(error.fieldErrorMap.keys, contains('nationality'));
      expect(error.fieldErrors.every((f) => f.code == 'REQUIRED'), isTrue);
    });

    test('status codes map to kinds', () {
      ApiErrorKind kind(int status) => ApiException.fromResponse(status, <String, dynamic>{'code': 'X', 'message': 'm'}).kind;
      expect(kind(400), ApiErrorKind.validation);
      expect(kind(401), ApiErrorKind.unauthorized);
      expect(kind(403), ApiErrorKind.forbidden);
      expect(kind(404), ApiErrorKind.notFound);
      expect(kind(409), ApiErrorKind.conflict);
      expect(kind(413), ApiErrorKind.validation);
      expect(kind(422), ApiErrorKind.validation);
      expect(kind(429), ApiErrorKind.rateLimited);
      expect(kind(500), ApiErrorKind.server);
      expect(kind(503), ApiErrorKind.server);
      expect(kind(418), ApiErrorKind.unknown);
    });

    test('session codes', () {
      expect(ApiException.fromResponse(401, <String, dynamic>{'code': 'SESSION_EXPIRED'}).isSessionExpired, isTrue);
      expect(ApiException.fromResponse(401, <String, dynamic>{'code': 'TOKEN_INVALID'}).isSessionExpired, isTrue);
      expect(ApiException.fromResponse(403, <String, dynamic>{'code': 'SESSION_EXPIRED'}).isSessionExpired, isFalse);
    });

    test('a body that is JSON text, plain text, a list or missing never throws', () {
      final fromText = ApiException.fromResponse(409, '{"code":"SLOT_FULL","message":"This time is no longer available."}');
      expect(fromText.code, 'SLOT_FULL');
      expect(fromText.message, 'This time is no longer available.');
      expect(fromText.kind, ApiErrorKind.conflict);

      final html = ApiException.fromResponse(502, '<html>Bad gateway</html>');
      expect(html.code, 'HTTP_502');
      expect(html.message, isEmpty);
      expect(html.kind, ApiErrorKind.server);

      expect(ApiException.fromResponse(500, null).code, 'HTTP_500');
      expect(ApiException.fromResponse(500, <dynamic>[1, 2]).code, 'HTTP_500');
      expect(ApiException.fromResponse(null, null).kind, ApiErrorKind.unknown);
      expect(ApiException.fromResponse(null, null).code, 'UNKNOWN');
    });
  });

  group('UrlRewriter (emulator helper)', () {
    test('points loopback links at the configured API host', () {
      const rewriter = UrlRewriter('http://10.0.2.2:4000/api/v1');
      expect(
        rewriter.rewrite('http://localhost:4000/api/v1/storage/local/upload/signed-token-placeholder'),
        'http://10.0.2.2:4000/api/v1/storage/local/upload/signed-token-placeholder',
      );
      expect(
        rewriter.rewrite('http://127.0.0.1:4000/api/v1/public/payments/sandbox/checkout/abc?lang=ar'),
        'http://10.0.2.2:4000/api/v1/public/payments/sandbox/checkout/abc?lang=ar',
      );
    });

    test('takes scheme and port from the API base URL', () {
      const rewriter = UrlRewriter('https://dev-api.example.ae/api/v1');
      expect(rewriter.rewrite('http://localhost:4000/files/a.pdf'), 'https://dev-api.example.ae/files/a.pdf');
    });

    test('leaves real hosts alone', () {
      const rewriter = UrlRewriter('http://10.0.2.2:4000/api/v1');
      const signed = 'https://files.typease.ae/bucket/key?X-Amz-Signature=abc';
      expect(rewriter.rewrite(signed), signed);
    });

    test('does nothing when the API itself is on loopback (iOS simulator, desktop)', () {
      const rewriter = UrlRewriter('http://localhost:4000/api/v1');
      const link = 'http://localhost:4000/api/v1/storage/local/download/x';
      expect(rewriter.rewrite(link), link);
    });

    test('does nothing for text that is not an absolute URL, or without a base URL', () {
      expect(const UrlRewriter('http://10.0.2.2:4000/api/v1').rewrite('/relative/path'), '/relative/path');
      expect(const UrlRewriter('').rewrite('http://localhost:4000/x'), 'http://localhost:4000/x');
    });
  });

  group('AppConfig.resolveApiBaseUrl', () {
    test('uses the given value without trailing slashes', () {
      expect(
        AppConfig.resolveApiBaseUrl(' https://api.typease.ae/api/v1/ ', isRelease: true, isAndroid: true),
        'https://api.typease.ae/api/v1',
      );
    });

    test('a release build without a value has no API (configuration error screen)', () {
      expect(AppConfig.resolveApiBaseUrl('', isRelease: true, isAndroid: true), '');
      expect(AppConfig.resolveApiBaseUrl('   ', isRelease: true, isAndroid: false), '');
    });

    test('a debug build defaults to the local API; the Android emulator uses 10.0.2.2', () {
      expect(AppConfig.resolveApiBaseUrl('', isRelease: false, isAndroid: true), 'http://10.0.2.2:4000/api/v1');
      expect(AppConfig.resolveApiBaseUrl('', isRelease: false, isAndroid: false), 'http://localhost:4000/api/v1');
    });
  });

  group('Validators (same rules as the API)', () {
    test('email', () {
      expect(Validators.isEmail('fatima@mobile-fixture.test'), isTrue);
      expect(Validators.isEmail('not-an-email'), isFalse);
      expect(Validators.isEmail('a@b'), isFalse);
      expect(Validators.isEmail('a b@c.de'), isFalse);
    });

    test('phone numbers are E.164 after removing spaces, brackets and dashes', () {
      expect(Validators.isPhone('+971501110002'), isTrue);
      expect(Validators.isPhone('+971 50 111-0002'), isTrue);
      expect(Validators.normalisePhone('+971 (50) 111-0002'), '+971501110002');
      expect(Validators.isPhone('0501110002'), isFalse);
      expect(Validators.isPhone('+0501110002'), isFalse);
      expect(Validators.isPhone('+97150'), isFalse);
    });

    test('centre code', () {
      expect(Validators.isSlug('mobile-fixture'), isTrue);
      expect(Validators.isSlug(' Mobile-Fixture '), isTrue);
      expect(Validators.isSlug('ab'), isFalse);
      expect(Validators.isSlug('-abc'), isFalse);
      expect(Validators.isSlug('has space'), isFalse);
    });

    test('one-time code', () {
      expect(Validators.isOtp('123456'), isTrue);
      expect(Validators.isOtp('12345'), isFalse);
      expect(Validators.isOtp('12345a'), isFalse);
    });

    test('password policy: 10+ characters with upper-case, lower-case and a number', () {
      expect(Validators.isStrongPassword('Customer1234'), isTrue);
      expect(Validators.isStrongPassword('Short1a'), isFalse);
      expect(Validators.isStrongPassword('alllowercase123'), isFalse);
      expect(Validators.isStrongPassword('ALLUPPERCASE123'), isFalse);
      expect(Validators.isStrongPassword('NoNumbersHere'), isFalse);
    });
  });

  group('Dates', () {
    test('calendar dates are not shifted by the time zone', () {
      final plain = Dates.parse('2030-01-01')!;
      expect(<int>[plain.year, plain.month, plain.day], <int>[2030, 1, 1]);
      expect(plain.isUtc, isFalse);

      // The API sends some calendar dates as midnight UTC.
      final midnightUtc = Dates.parseCalendarDate('2030-01-01T00:00:00.000Z')!;
      expect(<int>[midnightUtc.year, midnightUtc.month, midnightUtc.day], <int>[2030, 1, 1]);
    });

    test('date-times are converted to local time', () {
      final value = Dates.parse('2026-10-08T22:45:31.633Z')!;
      expect(value.isUtc, isFalse);
      expect(value.toUtc().hour, 22);
    });

    test('absent or invalid values', () {
      expect(Dates.parse(null), isNull);
      expect(Dates.parse(''), isNull);
      expect(Dates.parse('yesterday'), isNull);
      expect(Dates.parseCalendarDate('2030'), isNull);
      expect(Dates.date(null, 'en'), '—');
      expect(Dates.dateTime('nonsense', 'ar'), '—');
    });

    test('formats in English and Arabic', () {
      expect(Dates.calendarDate('2030-01-01', 'en'), 'Jan 1, 2030');
      final arabic = Dates.calendarDate('2030-01-01', 'ar');
      expect(arabic, isNot('—'));
      expect(arabic, isNot('Jan 1, 2030'));
    });

    test('toIsoDate and isValidIsoDate', () {
      expect(Dates.toIsoDate(DateTime(2026, 3, 7)), '2026-03-07');
      expect(Dates.isValidIsoDate('1988-07-15'), isTrue);
      expect(Dates.isValidIsoDate('2026-02-30'), isFalse);
      expect(Dates.isValidIsoDate('15/07/1988'), isFalse);
      expect(Dates.isValidIsoDate('1988-7-15'), isFalse);
    });
  });

  group('JSON helpers never throw on unexpected types', () {
    test('scalars', () {
      expect(asString(12), '12');
      expect(asString(null, 'x'), 'x');
      expect(asStringOrNull(<String, dynamic>{}), isNull);
      expect(asInt('42'), 42);
      expect(asInt(3.9), 3);
      expect(asIntOrNull('abc'), isNull);
      expect(asBool('true'), isTrue);
      expect(asBool(1), isFalse);
      expect(asBool(null, true), isTrue);
      expect(asDate('2026-10-08T22:45:31.633Z'), isNotNull);
      expect(asDate(20261008), isNull);
    });

    test('collections', () {
      expect(asMap('text'), isEmpty);
      expect(asMap(<dynamic, dynamic>{1: 'a'}), <String, dynamic>{'1': 'a'});
      expect(asMapOrNull(null), isNull);
      expect(asMapList(<dynamic>[1, <String, dynamic>{'a': 1}, null]), hasLength(1));
      expect(asMapList('text'), isEmpty);
      expect(asStringList(<dynamic>['a', 1, null]), <String>['a', '1']);
    });

    test('LocalizedText', () {
      const both = LocalizedText(en: 'Completed', ar: 'مكتمل');
      expect(both.resolve('en'), 'Completed');
      expect(both.resolve('ar'), 'مكتمل');
      // No Arabic text: English is shown rather than nothing.
      expect(const LocalizedText(en: 'Completed').resolve('ar'), 'Completed');
      expect(const LocalizedText(en: 'Completed', ar: '  ').resolve('ar'), 'Completed');
      expect(LocalizedText.fromJson('Plain text').en, 'Plain text');
      expect(LocalizedText.fromJson(null).isEmpty, isTrue);
      expect(pickLanguage('ar', 'Passport', null), 'Passport');
      expect(pickLanguage('ar', 'Passport', 'جواز السفر'), 'جواز السفر');
      expect(pickLanguage('en', 'Passport', 'جواز السفر'), 'Passport');
    });
  });
}
