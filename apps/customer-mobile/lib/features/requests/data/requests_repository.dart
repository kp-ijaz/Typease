import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/network/page.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';
import 'request_models.dart';

class RequestsRepository {
  RequestsRepository(this._api);

  final ApiClient _api;

  /// `GET /requests` - the customer's own requests, newest first.
  Future<Page<RequestSummary>> list({
    List<String>? statuses,
    String? serviceId,
    int page = 1,
    int pageSize = 20,
  }) async {
    final json = await _api.get(
      '/requests',
      query: <String, dynamic>{
        'page': page,
        'pageSize': pageSize,
        'sort': 'updatedAt:desc',
        'status': (statuses == null || statuses.isEmpty) ? null : statuses.join(','),
        'serviceId': serviceId,
      },
    );
    return Page<RequestSummary>.fromJson(json, RequestSummary.fromJson);
  }

  /// `GET /requests/counts`
  Future<RequestCounts> counts() async => RequestCounts.fromJson(await _api.get('/requests/counts'));

  /// `GET /requests/:id`
  Future<RequestDetail> detail(String id) async => RequestDetail.fromJson(await _api.get('/requests/$id'));

  /// `POST /requests` - creates a DRAFT on the server so it can be continued
  /// on another device. `renewalOfScheduleId` links a document-expiry reminder.
  Future<RequestDetail> create({required String serviceId, String? renewalOfScheduleId}) async {
    final body = <String, dynamic>{'serviceId': serviceId};
    if (renewalOfScheduleId != null && renewalOfScheduleId.isNotEmpty) {
      body['renewalOfScheduleId'] = renewalOfScheduleId;
    }
    return RequestDetail.fromJson(await _api.post('/requests', body: body));
  }

  /// `PUT /requests/:id/fields` - saves form values; `null` clears a value.
  Future<RequestDetail> saveFields(String id, Map<String, Object?> values) async {
    final json = await _api.put('/requests/$id/fields', body: <String, dynamic>{'values': values});
    return RequestDetail.fromJson(json);
  }

  /// `PATCH /requests/:id` - the customer's instructions for the centre.
  Future<RequestDetail> updateInstructions(String id, {required String instructions, required int version}) async {
    final json = await _api.patch(
      '/requests/$id',
      body: <String, dynamic>{'instructions': instructions, 'version': version},
    );
    return RequestDetail.fromJson(json);
  }

  /// `POST /requests/:id/submit` - the response carries `trackingCode` once.
  Future<RequestDetail> submit(String id) async => RequestDetail.fromJson(await _api.post('/requests/$id/submit'));

  /// `POST /requests/:id/cancel`
  Future<RequestDetail> cancel(String id, String reason) async {
    final json = await _api.post('/requests/$id/cancel', body: <String, dynamic>{'reason': reason});
    return RequestDetail.fromJson(json);
  }

  /// `POST /requests/:id/resubmit` - after providing what the centre asked for.
  Future<RequestDetail> resubmit(String id, {String? note}) async {
    final body = <String, dynamic>{};
    if (note != null && note.trim().isNotEmpty) body['note'] = note.trim();
    return RequestDetail.fromJson(await _api.post('/requests/$id/resubmit', body: body));
  }

  /// `GET /requests/:id/comments` - customer-visible messages only.
  Future<List<RequestComment>> comments(String id) async {
    final json = await _api.get('/requests/$id/comments');
    return asMapList(json).map(RequestComment.fromJson).toList(growable: false);
  }

  /// `POST /requests/:id/comments`
  Future<RequestComment> addComment(String id, String body) async {
    final json = await _api.post('/requests/$id/comments', body: <String, dynamic>{'body': body});
    return RequestComment.fromJson(json);
  }

  /// `PUT /requests/:id/checklist/:itemId/document` - reuse a document on file.
  Future<RequestDetail> linkDocument(String id, String itemId, String documentId) async {
    final json = await _api.put(
      '/requests/$id/checklist/$itemId/document',
      body: <String, dynamic>{'documentId': documentId},
    );
    return RequestDetail.fromJson(json);
  }

  /// `DELETE /requests/:id/checklist/:itemId/document`
  Future<RequestDetail> unlinkDocument(String id, String itemId) async {
    return RequestDetail.fromJson(await _api.delete('/requests/$id/checklist/$itemId/document'));
  }
}

final requestsRepositoryProvider = Provider<RequestsRepository>((ref) {
  return RequestsRepository(ref.watch(apiClientProvider));
});
