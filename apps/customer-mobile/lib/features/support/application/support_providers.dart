import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/support_models.dart';
import '../data/support_repository.dart';

final ticketsProvider = FutureProvider.autoDispose<List<Ticket>>((ref) async {
  final page = await ref.watch(supportRepositoryProvider).list();
  return page.items;
});

final ticketProvider = FutureProvider.autoDispose.family<Ticket, String>((ref, id) {
  return ref.watch(supportRepositoryProvider).detail(id);
});
