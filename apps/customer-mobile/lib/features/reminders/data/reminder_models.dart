import '../../../core/utils/json.dart';

/// A document-expiry reminder of the customer (`GET /me/reminders`).
class ReminderItem {
  const ReminderItem({
    required this.id,
    required this.documentTypeKey,
    required this.documentTypeName,
    required this.expiryDate,
    required this.status,
    this.documentTypeNameAr,
    this.subjectLabel,
    this.daysLeft,
    this.nextReminderOn,
    this.renewalRequestId,
  });

  factory ReminderItem.fromJson(Object? json) {
    final map = asMap(json);
    return ReminderItem(
      id: asString(map['id']),
      documentTypeKey: asString(map['documentTypeKey']),
      documentTypeName: asString(map['documentTypeName'], asString(map['documentTypeKey'])),
      documentTypeNameAr: asStringOrNull(map['documentTypeNameAr']),
      subjectLabel: asStringOrNull(map['subjectLabel']),
      expiryDate: asString(map['expiryDate']),
      daysLeft: asIntOrNull(map['daysLeft']),
      status: asString(map['status']),
      nextReminderOn: asStringOrNull(map['nextReminderOn']),
      renewalRequestId: asStringOrNull(map['renewalRequestId']),
    );
  }

  final String id;
  final String documentTypeKey;
  final String documentTypeName;
  final String? documentTypeNameAr;

  /// Whose document it is (usually the customer's name).
  final String? subjectLabel;

  /// `YYYY-MM-DD`, according to the centre's records.
  final String expiryDate;
  final int? daysLeft;

  /// `ACTIVE`, `PAUSED`, `COMPLETED`.
  final String status;
  final String? nextReminderOn;

  /// Set once a renewal request was started from this reminder.
  final String? renewalRequestId;

  bool get isExpired => (daysLeft ?? 0) < 0;
  bool get renewalStarted => renewalRequestId != null;
}
