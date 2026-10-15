import 'package:intl/intl.dart';

/// Date formatting for display. All API timestamps are ISO-8601 in UTC; they
/// are shown in the device's local time. Calendar dates (`YYYY-MM-DD`) are
/// shown as they are, without any time-zone shift.
class Dates {
  const Dates._();

  static final RegExp _dateOnly = RegExp(r'^\d{4}-\d{2}-\d{2}$');

  /// Parses an ISO date-time or a plain calendar date.
  static DateTime? parse(String? iso) {
    if (iso == null || iso.isEmpty) return null;
    final value = DateTime.tryParse(iso);
    if (value == null) return null;
    if (_dateOnly.hasMatch(iso)) return DateTime(value.year, value.month, value.day);
    return value.toLocal();
  }

  /// Parses a value that is semantically a calendar date even when the API
  /// sends it as midnight UTC ("2030-01-01T00:00:00.000Z"): the day must not
  /// move when the device is west of UTC.
  static DateTime? parseCalendarDate(String? iso) {
    if (iso == null || iso.length < 10) return null;
    final value = DateTime.tryParse(iso.substring(0, 10));
    if (value == null) return null;
    return DateTime(value.year, value.month, value.day);
  }

  static String date(String? iso, String locale) {
    final value = parse(iso);
    if (value == null) return '—';
    return DateFormat.yMMMd(locale).format(value);
  }

  static String calendarDate(String? iso, String locale) {
    final value = parseCalendarDate(iso);
    if (value == null) return '—';
    return DateFormat.yMMMd(locale).format(value);
  }

  static String dateTime(String? iso, String locale) {
    final value = parse(iso);
    if (value == null) return '—';
    return '${DateFormat.yMMMd(locale).format(value)}, ${DateFormat.jm(locale).format(value)}';
  }

  static String time(String? iso, String locale) {
    final value = parse(iso);
    if (value == null) return '—';
    return DateFormat.jm(locale).format(value);
  }

  static String weekdayDate(DateTime value, String locale) => DateFormat.MMMEd(locale).format(value);

  /// `YYYY-MM-DD` for request bodies and query strings.
  static String toIsoDate(DateTime value) {
    final y = value.year.toString().padLeft(4, '0');
    final m = value.month.toString().padLeft(2, '0');
    final d = value.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
  }

  /// True when [value] is a real calendar date written as `YYYY-MM-DD`.
  static bool isValidIsoDate(String value) {
    if (!_dateOnly.hasMatch(value)) return false;
    final parsed = DateTime.tryParse('${value}T00:00:00Z');
    if (parsed == null) return false;
    return toIsoDate(parsed.toUtc()) == value;
  }
}
