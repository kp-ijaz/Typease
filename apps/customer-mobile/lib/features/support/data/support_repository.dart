import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/network/page.dart';
import '../../../core/providers.dart';
import 'support_models.dart';

class SupportRepository {
  SupportRepository(this._api);

  final ApiClient _api;

  /// `GET /me/tickets`
  Future<Page<Ticket>> list({int page = 1, int pageSize = 50}) async {
    final json = await _api.get('/me/tickets', query: <String, dynamic>{'page': page, 'pageSize': pageSize});
    return Page<Ticket>.fromJson(json, Ticket.fromJson);
  }

  /// `GET /me/tickets/:id`
  Future<Ticket> detail(String id) async => Ticket.fromJson(await _api.get('/me/tickets/$id'));

  /// `POST /me/tickets`
  Future<Ticket> create({
    required String subject,
    required String message,
    String? category,
    String? requestId,
    List<String> attachments = const <String>[],
  }) async {
    final body = <String, dynamic>{'subject': subject.trim(), 'message': message.trim()};
    if (category != null && category.trim().isNotEmpty) body['category'] = category.trim();
    if (requestId != null && requestId.isNotEmpty) body['requestId'] = requestId;
    if (attachments.isNotEmpty) body['attachments'] = attachments;
    return Ticket.fromJson(await _api.post('/me/tickets', body: body));
  }

  /// `POST /me/tickets/:id/messages`
  Future<Ticket> reply(String id, {required String body, List<String> attachments = const <String>[]}) async {
    final payload = <String, dynamic>{'body': body.trim()};
    if (attachments.isNotEmpty) payload['attachments'] = attachments;
    return Ticket.fromJson(await _api.post('/me/tickets/$id/messages', body: payload));
  }

  /// `POST /me/feedback` - rates a resolved ticket or a completed request (once).
  Future<void> rate({String? ticketId, String? requestId, required int rating, String? comment}) async {
    final body = <String, dynamic>{'rating': rating};
    if (ticketId != null) body['ticketId'] = ticketId;
    if (requestId != null) body['requestId'] = requestId;
    if (comment != null && comment.trim().isNotEmpty) body['comment'] = comment.trim();
    await _api.post('/me/feedback', body: body);
  }
}

final supportRepositoryProvider = Provider<SupportRepository>((ref) => SupportRepository(ref.watch(apiClientProvider)));
