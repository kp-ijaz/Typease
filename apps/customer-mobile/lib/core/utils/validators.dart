/// Input checks that mirror the API's validation rules
/// (`packages/validation/src/common.ts`). They only give earlier feedback;
/// the server remains the authority.
class Validators {
  const Validators._();

  static final RegExp _email = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
  static final RegExp _e164 = RegExp(r'^\+[1-9][0-9]{6,14}$');
  static final RegExp _slug = RegExp(r'^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$');
  static final RegExp _otp = RegExp(r'^\d{6}$');

  static bool isEmail(String value) => value.length <= 254 && _email.hasMatch(value.trim());

  /// Removes spaces, brackets and dashes, as the API does before checking.
  static String normalisePhone(String value) => value.replaceAll(RegExp(r'[\s()-]'), '');

  static bool isPhone(String value) => _e164.hasMatch(normalisePhone(value));

  static bool isSlug(String value) => _slug.hasMatch(value.trim().toLowerCase());

  static bool isOtp(String value) => _otp.hasMatch(value.trim());

  /// At least 10 characters with upper-case, lower-case and a number.
  static bool isStrongPassword(String value) {
    if (value.length < 10 || value.length > 128) return false;
    return RegExp(r'[a-z]').hasMatch(value) && RegExp(r'[A-Z]').hasMatch(value) && RegExp(r'\d').hasMatch(value);
  }
}
