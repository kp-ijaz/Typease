import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';

/// The answer of `POST /public/track`: status and status history of one
/// request, without any personal details (works without signing in).
class TrackedRequest {
  const TrackedRequest({
    required this.requestNo,
    required this.serviceName,
    required this.status,
    required this.statusLabel,
    required this.timeline,
    this.serviceNameAr,
    this.submittedAt,
    this.completedAt,
  });

  factory TrackedRequest.fromJson(Object? json) {
    final map = asMap(json);
    final service = asMap(map['service']);
    return TrackedRequest(
      requestNo: asString(map['requestNo']),
      serviceName: asString(service['name']),
      serviceNameAr: asStringOrNull(service['nameAr']),
      status: asString(map['status']),
      statusLabel: LocalizedText.fromJson(map['statusLabel']),
      submittedAt: asStringOrNull(map['submittedAt']),
      completedAt: asStringOrNull(map['completedAt']),
      timeline: asMapList(map['timeline'])
          .map((step) => TrackedStep(
                status: asString(step['status']),
                label: LocalizedText.fromJson(step['statusLabel']),
                at: asStringOrNull(step['at']),
              ))
          .toList(growable: false),
    );
  }

  final String requestNo;
  final String serviceName;
  final String? serviceNameAr;
  final String status;
  final LocalizedText statusLabel;
  final String? submittedAt;
  final String? completedAt;
  final List<TrackedStep> timeline;
}

class TrackedStep {
  const TrackedStep({required this.status, required this.label, this.at});

  final String status;
  final LocalizedText label;
  final String? at;
}

class TrackingRepository {
  TrackingRepository(this._api);

  final ApiClient _api;

  /// `POST /public/track`. A wrong number or code is a 404, like an unknown
  /// request, so the code cannot be guessed.
  Future<TrackedRequest> track({required String tenantSlug, required String requestNo, required String trackingCode}) async {
    final json = await _api.post(
      '/public/track',
      body: <String, dynamic>{'tenantSlug': tenantSlug, 'requestNo': requestNo, 'trackingCode': trackingCode},
      auth: false,
    );
    return TrackedRequest.fromJson(json);
  }
}

final trackingRepositoryProvider = Provider<TrackingRepository>((ref) {
  return TrackingRepository(ref.watch(apiClientProvider));
});
