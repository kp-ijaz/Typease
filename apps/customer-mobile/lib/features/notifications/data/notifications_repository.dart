import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';
import 'notification_models.dart';

class NotificationsRepository {
  NotificationsRepository(this._api);

  final ApiClient _api;

  /// `GET /me/notifications`
  Future<NotificationInbox> inbox({int page = 1, int pageSize = 30, bool unreadOnly = false}) async {
    final json = await _api.get(
      '/me/notifications',
      query: <String, dynamic>{'page': page, 'pageSize': pageSize, 'unreadOnly': unreadOnly ? 'true' : null},
    );
    return NotificationInbox.fromJson(json);
  }

  /// `POST /me/notifications/:id/read`
  Future<String> markRead(String id) async {
    final json = await _api.post('/me/notifications/$id/read');
    return asString(asMap(json)['readAt'], DateTime.now().toUtc().toIso8601String());
  }

  /// `POST /me/notifications/read-all`
  Future<void> markAllRead() async {
    await _api.post('/me/notifications/read-all');
  }

  /// `GET /me/notification-preferences`
  Future<NotificationPreferences> preferences() async {
    return NotificationPreferences.fromJson(await _api.get('/me/notification-preferences'));
  }

  /// `PUT /me/notification-preferences`
  Future<NotificationPreferences> savePreference({required String channel, required String eventGroup, required bool enabled}) async {
    final json = await _api.put(
      '/me/notification-preferences',
      body: <String, dynamic>{
        'preferences': <Map<String, dynamic>>[
          <String, dynamic>{'channel': channel, 'eventGroup': eventGroup, 'enabled': enabled},
        ],
      },
    );
    return NotificationPreferences.fromJson(json);
  }

  /// `POST /me/devices` - registers this device for push notifications.
  Future<void> registerDevice({required String token, required String platform}) async {
    await _api.post('/me/devices', body: <String, dynamic>{'token': token, 'platform': platform});
  }

  /// `DELETE /me/devices`
  Future<void> removeDevice(String token) async {
    await _api.delete('/me/devices', body: <String, dynamic>{'token': token});
  }
}

final notificationsRepositoryProvider = Provider<NotificationsRepository>((ref) {
  return NotificationsRepository(ref.watch(apiClientProvider));
});
