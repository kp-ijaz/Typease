import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/notification_models.dart';
import '../data/notifications_repository.dart';

/// The in-app inbox: list, unread count, mark as read.
class InboxController extends AutoDisposeAsyncNotifier<NotificationInbox> {
  bool _loadingMore = false;

  @override
  Future<NotificationInbox> build() {
    return ref.watch(notificationsRepositoryProvider).inbox();
  }

  Future<void> loadMore() async {
    final current = state.valueOrNull;
    if (current == null || !current.hasMore || _loadingMore) return;
    _loadingMore = true;
    try {
      final next = await ref.read(notificationsRepositoryProvider).inbox(page: current.page + 1);
      state = AsyncData<NotificationInbox>(
        NotificationInbox(
          items: <NotificationItem>[...current.items, ...next.items],
          unreadCount: next.unreadCount,
          page: next.page,
          totalPages: next.totalPages,
        ),
      );
    } finally {
      _loadingMore = false;
    }
  }

  /// Marks one notification as read. The list is updated at once; a failure
  /// is ignored because reading the linked item matters more than the flag.
  Future<void> markRead(NotificationItem item) async {
    if (!item.isUnread) return;
    final current = state.valueOrNull;
    try {
      final readAt = await ref.read(notificationsRepositoryProvider).markRead(item.id);
      if (current == null) return;
      final latest = state.valueOrNull ?? current;
      state = AsyncData<NotificationInbox>(
        NotificationInbox(
          items: <NotificationItem>[
            for (final existing in latest.items)
              if (existing.id == item.id) existing.markedRead(readAt) else existing,
          ],
          unreadCount: latest.unreadCount > 0 ? latest.unreadCount - 1 : 0,
          page: latest.page,
          totalPages: latest.totalPages,
        ),
      );
      ref.invalidate(unreadCountProvider);
    } catch (_) {
      // Keep the item unread; it can be marked again later.
    }
  }

  Future<void> markAllRead() async {
    await ref.read(notificationsRepositoryProvider).markAllRead();
    ref.invalidate(unreadCountProvider);
    ref.invalidateSelf();
    await future;
  }
}

final inboxProvider = AsyncNotifierProvider.autoDispose<InboxController, NotificationInbox>(InboxController.new);

/// The number on the bell. Loaded with a one-item page, which is the cheapest
/// call that returns `unreadCount`.
final unreadCountProvider = FutureProvider.autoDispose<int>((ref) async {
  final inbox = await ref.watch(notificationsRepositoryProvider).inbox(pageSize: 1, unreadOnly: true);
  return inbox.unreadCount;
});
