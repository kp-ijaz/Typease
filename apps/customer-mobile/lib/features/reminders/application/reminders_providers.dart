import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/reminder_models.dart';
import '../data/reminders_repository.dart';

final remindersProvider = FutureProvider.autoDispose<List<ReminderItem>>((ref) async {
  final page = await ref.watch(remindersRepositoryProvider).list();
  return page.items;
});
