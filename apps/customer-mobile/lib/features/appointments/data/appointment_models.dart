import '../../../core/utils/json.dart';

/// An appointment as the customer sees it (`/me/appointments`).
class Appointment {
  const Appointment({
    required this.id,
    required this.branchId,
    required this.branchName,
    required this.startsAt,
    required this.localDate,
    required this.localTime,
    required this.status,
    required this.canCancel,
    required this.canReschedule,
    this.branchNameAr,
    this.serviceId,
    this.serviceName,
    this.serviceNameAr,
    this.endsAt,
    this.localEndTime,
    this.timezone,
    this.cancelledReason,
  });

  factory Appointment.fromJson(Object? json) {
    final map = asMap(json);
    return Appointment(
      id: asString(map['id']),
      branchId: asString(map['branchId']),
      branchName: asString(map['branchName']),
      branchNameAr: asStringOrNull(map['branchNameAr']),
      serviceId: asStringOrNull(map['serviceId']),
      serviceName: asStringOrNull(map['serviceName']),
      serviceNameAr: asStringOrNull(map['serviceNameAr']),
      startsAt: asString(map['startsAt']),
      endsAt: asStringOrNull(map['endsAt']),
      localDate: asString(map['localDate']),
      localTime: asString(map['localTime']),
      localEndTime: asStringOrNull(map['localEndTime']),
      timezone: asStringOrNull(map['timezone']),
      status: asString(map['status']),
      cancelledReason: asStringOrNull(map['cancelledReason']),
      canCancel: asBool(map['canCancel']),
      canReschedule: asBool(map['canReschedule']),
    );
  }

  final String id;
  final String branchId;
  final String branchName;
  final String? branchNameAr;
  final String? serviceId;
  final String? serviceName;
  final String? serviceNameAr;

  /// UTC instant.
  final String startsAt;
  final String? endsAt;

  /// Date and time in the BRANCH time zone, ready to display.
  final String localDate;
  final String localTime;
  final String? localEndTime;
  final String? timezone;

  /// `BOOKED`, `CONFIRMED`, `CHECKED_IN`, `IN_SERVICE`, `COMPLETED`,
  /// `CANCELLED`, `NO_SHOW`, `RESCHEDULED`.
  final String status;
  final String? cancelledReason;
  final bool canCancel;
  final bool canReschedule;

  bool get isUpcoming => status == 'BOOKED' || status == 'CONFIRMED';
}

class AppointmentSlot {
  const AppointmentSlot({required this.startsAt, required this.localStart, required this.localEnd, required this.available, required this.remaining});

  factory AppointmentSlot.fromJson(Object? json) {
    final map = asMap(json);
    return AppointmentSlot(
      startsAt: asString(map['startsAt']),
      localStart: asString(map['localStart']),
      localEnd: asString(map['localEnd']),
      available: asBool(map['available']),
      remaining: asInt(map['remaining']),
    );
  }

  /// UTC instant to send back when booking.
  final String startsAt;

  /// `HH:MM` in the branch time zone.
  final String localStart;
  final String localEnd;
  final bool available;
  final int remaining;
}

/// `GET /appointments/availability`
class Availability {
  const Availability({
    required this.branchId,
    required this.branchName,
    required this.date,
    required this.closed,
    required this.slots,
    this.timezone,
    this.bookableUntil,
  });

  factory Availability.fromJson(Object? json) {
    final map = asMap(json);
    return Availability(
      branchId: asString(map['branchId']),
      branchName: asString(map['branchName']),
      date: asString(map['date']),
      timezone: asStringOrNull(map['timezone']),
      closed: asBool(map['closed']),
      bookableUntil: asStringOrNull(map['bookableUntil']),
      slots: asMapList(map['slots']).map(AppointmentSlot.fromJson).toList(growable: false),
    );
  }

  final String branchId;
  final String branchName;
  final String date;
  final String? timezone;
  final bool closed;

  /// Last day (`YYYY-MM-DD`) that can be booked.
  final String? bookableUntil;
  final List<AppointmentSlot> slots;

  List<AppointmentSlot> get freeSlots => slots.where((s) => s.available).toList(growable: false);
}

/// A branch the customer can book at.
class BranchOption {
  const BranchOption({required this.id, required this.name, this.nameAr, this.address});

  factory BranchOption.fromJson(Object? json) {
    final map = asMap(json);
    return BranchOption(
      id: asString(map['id']),
      name: asString(map['name']),
      nameAr: asStringOrNull(map['nameAr']),
      address: asStringOrNull(map['address']),
    );
  }

  final String id;
  final String name;
  final String? nameAr;
  final String? address;
}
