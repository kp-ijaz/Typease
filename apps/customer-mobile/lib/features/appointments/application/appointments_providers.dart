import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../requests/data/requests_repository.dart';
import '../../tenant/application/tenant_controller.dart';
import '../data/appointment_models.dart';
import '../data/appointments_repository.dart';

final appointmentsProvider = FutureProvider.autoDispose<List<Appointment>>((ref) async {
  final page = await ref.watch(appointmentsRepositoryProvider).list();
  return page.items;
});

/// The branches the customer can choose from when booking.
///
/// The API has no "list branches" call for signed-in customers. The list is
/// therefore assembled from what the customer may already see:
///  1. the centre's published branches (`/public/appointments/options`,
///     filled only when the centre enabled guest booking);
///  2. branches of the customer's own appointments;
///  3. branches of the customer's own requests (the name is read from the
///     availability call of that branch).
/// When all three are empty the booking screen explains that the centre has
/// to be contacted.
final bookableBranchesProvider = FutureProvider.autoDispose<List<BranchOption>>((ref) async {
  final appointments = ref.watch(appointmentsRepositoryProvider);
  final byId = <String, BranchOption>{};

  final slug = ref.watch(tenantControllerProvider)?.slug;
  if (slug != null && slug.isNotEmpty) {
    try {
      for (final branch in await appointments.publishedBranches(slug)) {
        byId[branch.id] = branch;
      }
    } catch (_) {
      // Optional source.
    }
  }

  try {
    final mine = await appointments.list(pageSize: 50);
    for (final appointment in mine.items) {
      if (appointment.branchId.isEmpty) continue;
      byId.putIfAbsent(
        appointment.branchId,
        () => BranchOption(id: appointment.branchId, name: appointment.branchName, nameAr: appointment.branchNameAr),
      );
    }
  } catch (_) {
    // Optional source.
  }

  if (byId.isEmpty) {
    final requests = await ref.watch(requestsRepositoryProvider).list(pageSize: 20);
    final branchIds = <String>{};
    for (final request in requests.items) {
      final branchId = request.branchId;
      if (branchId != null && branchId.isNotEmpty) branchIds.add(branchId);
    }
    final today = DateTime.now();
    for (final branchId in branchIds) {
      try {
        final availability = await appointments.availability(branchId: branchId, date: today);
        byId[branchId] = BranchOption(id: branchId, name: availability.branchName);
      } catch (_) {
        // This branch cannot be booked by the customer.
      }
    }
  }

  return byId.values.toList(growable: false);
});

/// One branch day.
@immutable
class AvailabilityQuery {
  const AvailabilityQuery({required this.branchId, required this.date, this.serviceId});

  final String branchId;

  /// Calendar day (time of day is ignored).
  final DateTime date;
  final String? serviceId;

  @override
  bool operator ==(Object other) {
    return other is AvailabilityQuery &&
        other.branchId == branchId &&
        other.serviceId == serviceId &&
        other.date.year == date.year &&
        other.date.month == date.month &&
        other.date.day == date.day;
  }

  @override
  int get hashCode => Object.hash(branchId, serviceId, date.year, date.month, date.day);
}

final availabilityProvider = FutureProvider.autoDispose.family<Availability, AvailabilityQuery>((ref, query) {
  return ref.watch(appointmentsRepositoryProvider).availability(
        branchId: query.branchId,
        date: query.date,
        serviceId: query.serviceId,
      );
});
