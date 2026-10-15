import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/network/page.dart';
import '../../../core/providers.dart';
import 'reminder_models.dart';

class RemindersRepository {
  RemindersRepository(this._api);

  final ApiClient _api;

  /// `GET /me/reminders` - soonest expiry first.
  Future<Page<ReminderItem>> list({int page = 1, int pageSize = 50}) async {
    final json = await _api.get(
      '/me/reminders',
      query: <String, dynamic>{'page': page, 'pageSize': pageSize, 'sort': 'expiryDate:asc'},
    );
    return Page<ReminderItem>.fromJson(json, ReminderItem.fromJson);
  }
}

final remindersRepositoryProvider = Provider<RemindersRepository>((ref) => RemindersRepository(ref.watch(apiClientProvider)));
