import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/deep_links.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/states.dart';
import '../application/inbox_controller.dart';
import '../data/notification_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// In-app inbox: newest first, unread items marked, tap to open the related
/// request, quotation, invoice, appointment or ticket.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  bool _busy = false;

  Future<void> _refresh() async {
    ref.invalidate(inboxProvider);
    ref.invalidate(unreadCountProvider);
    try {
      await ref.read(inboxProvider.future);
    } catch (_) {
      // Shown by the list.
    }
  }

  Future<void> _markAll() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(inboxProvider.notifier).markAllRead();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadMore() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(inboxProvider.notifier).loadMore();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _open(NotificationItem item) {
    // Mark as read in the background; opening the item must not wait for it.
    ref.read(inboxProvider.notifier).markRead(item);
    final location = DeepLinkTarget.fromRelated(item.relatedType, item.relatedId)?.location;
    if (location != null) context.push<void>(location);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final inbox = ref.watch(inboxProvider);
    final unread = inbox.valueOrNull?.unreadCount ?? 0;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.t('notificationsTitle')),
        actions: <Widget>[
          if (unread > 0)
            TextButton(onPressed: _busy ? null : _markAll, child: Text(l10n.t('notificationsMarkAll'))),
        ],
      ),
      body: AsyncValueView<NotificationInbox>(
        value: inbox,
        onRetry: () => ref.invalidate(inboxProvider),
        data: (data) {
          if (data.items.isEmpty) {
            return RefreshableList(
              onRefresh: _refresh,
              children: <Widget>[
                FillRemainingMessage(
                  child: EmptyStateView(
                    icon: PhosphorIconsRegular.bell,
                    title: l10n.t('notificationsEmptyTitle'),
                    message: l10n.t('notificationsEmptyBody'),
                  ),
                ),
              ],
            );
          }
          return RefreshableList(
            onRefresh: _refresh,
            padding: const EdgeInsets.symmetric(vertical: 8),
            children: <Widget>[
              for (final item in data.items) _NotificationTile(item: item, onTap: () => _open(item)),
              if (data.hasMore)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Center(
                    child: OutlinedButton(onPressed: _busy ? null : _loadMore, child: Text(l10n.t('commonLoadMore'))),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.item, required this.onTap});

  final NotificationItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final unread = item.isUnread;
    return Semantics(
      label: unread ? l10n.t('notificationsUnreadLabel') : null,
      child: ListTile(
        onTap: onTap,
        leading: Icon(
          unread ? PhosphorIconsRegular.envelopeSimpleOpen : PhosphorIconsRegular.envelopeOpen,
          color: unread ? theme.colorScheme.secondary : tokens.mutedText,
        ),
        title: Text(
          item.subject,
          style: theme.textTheme.titleSmall?.copyWith(fontWeight: unread ? FontWeight.w700 : FontWeight.w400),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (item.body.isNotEmpty) Text(item.body, maxLines: 3, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Text(
              Dates.dateTime(item.createdAt, l10n.languageCode),
              style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
            ),
          ],
        ),
        isThreeLine: true,
        trailing: unread
            ? Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(color: theme.colorScheme.secondary, shape: BoxShape.circle),
              )
            : null,
      ),
    );
  }
}
