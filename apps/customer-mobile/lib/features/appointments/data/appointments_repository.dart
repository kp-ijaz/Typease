import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/network/page.dart';
import '../../../core/providers.dart';
import '../../../core/utils/dates.dart';
import '../../../core/utils/json.dart';
import 'appointment_models.dart';

class AppointmentsRepository {
  AppointmentsRepository(this._api);

  final ApiClient _api;

  /// `GET /me/appointments`
  Future<Page<Appointment>> list({bool upcoming = false, int page = 1, int pageSize = 50}) async {
    final json = await _api.get(
      '/me/appointments',
      query: <String, dynamic>{'page': page, 'pageSize': pageSize, 'upcoming': upcoming ? 'true' : null},
    );
    return Page<Appointment>.fromJson(json, Appointment.fromJson);
  }

  /// `GET /appointments/availability` - free slots of one branch day.
  Future<Availability> availability({required String branchId, required DateTime date, String? serviceId}) async {
    final json = await _api.get(
      '/appointments/availability',
      query: <String, dynamic>{'branchId': branchId, 'date': Dates.toIsoDate(date), 'serviceId': serviceId},
    );
    return Availability.fromJson(json);
  }

  /// `POST /me/appointments`
  Future<Appointment> book({required String branchId, required String startsAt, String? serviceId, String? notes}) async {
    final body = <String, dynamic>{'branchId': branchId, 'startsAt': startsAt};
    if (serviceId != null && serviceId.isNotEmpty) body['serviceId'] = serviceId;
    if (notes != null && notes.trim().isNotEmpty) body['notes'] = notes.trim();
    return Appointment.fromJson(await _api.post('/me/appointments', body: body));
  }

  /// `POST /me/appointments/:id/cancel`
  Future<Appointment> cancel(String id, {String? reason}) async {
    final body = <String, dynamic>{};
    if (reason != null && reason.trim().isNotEmpty) body['reason'] = reason.trim();
    return Appointment.fromJson(await _api.post('/me/appointments/$id/cancel', body: body));
  }

  /// `POST /me/appointments/:id/reschedule` - returns the NEW appointment.
  Future<Appointment> reschedule(String id, {required String startsAt, String? branchId}) async {
    final body = <String, dynamic>{'startsAt': startsAt};
    if (branchId != null && branchId.isNotEmpty) body['branchId'] = branchId;
    return Appointment.fromJson(await _api.post('/me/appointments/$id/reschedule', body: body));
  }

  /// `GET /public/appointments/options?tenant=` - the centre's published
  /// branches. The list is empty while the centre has guest booking disabled.
  Future<List<BranchOption>> publishedBranches(String tenantSlug) async {
    final json = await _api.get('/public/appointments/options', query: <String, dynamic>{'tenant': tenantSlug}, auth: false);
    return asMapList(asMap(json)['branches']).map(BranchOption.fromJson).where((b) => b.id.isNotEmpty).toList(growable: false);
  }
}

final appointmentsRepositoryProvider = Provider<AppointmentsRepository>((ref) {
  return AppointmentsRepository(ref.watch(apiClientProvider));
});
