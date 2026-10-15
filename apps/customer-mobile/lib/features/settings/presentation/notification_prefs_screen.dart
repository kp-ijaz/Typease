import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../notifications/data/notification_models.dart';
import '../../notifications/data/notifications_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

final _preferencesProvider = FutureProvider.autoDispose<NotificationPreferences>((ref) {
  return ref.watch(notificationsRepositoryProvider).preferences();
});

/// Topics a customer can receive messages about. The API also knows staff
/// topics (billing, reports); those are not offered here.
const List<String> _customerGroups = <String>['requests', 'payments', 'appointments', 'reminders', 'support', 'marketing'];

/// Notification preferences: per channel, which topics the customer wants to
/// hear about. Account-security messages are always sent.
class NotificationPrefsScreen extends ConsumerStatefulWidget {
  const NotificationPrefsScreen({super.key});

  @override
  ConsumerState<NotificationPrefsScreen> createState() => _NotificationPrefsScreenState();
}

class _NotificationPrefsScreenState extends ConsumerState<NotificationPrefsScreen> {
  String _channel = 'PUSH';
  NotificationPreferences? _latest;
  String? _savingGroup;

  Future<void> _toggle(String group, bool enabled) async {
    if (_savingGroup != null) return;
    setState(() => _savingGroup = group);
    try {
      final saved = await ref.read(notificationsRepositoryProvider).savePreference(
            channel: _channel,
            eventGroup: group,
            enabled: enabled,
          );
      if (mounted) setState(() => _latest = saved);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _savingGroup = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final loaded = ref.watch(_preferencesProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('notificationPrefsTitle'))),
      body: AsyncValueView<NotificationPreferences>(
        value: loaded,
        onRetry: () => ref.invalidate(_preferencesProvider),
        data: (fromServer) {
          final preferences = _latest ?? fromServer;
          // The in-app inbox always receives everything; it is not a choice.
          final channels = preferences.channels.where((c) => c != 'IN_APP').toList();
          final channel = channels.contains(_channel) ? _channel : (channels.isEmpty ? _channel : channels.first);
          final groups = _customerGroups.where((g) => preferences.groups.isEmpty || preferences.groups.contains(g)).toList();
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            children: <Widget>[
              Text(l10n.t('notificationPrefsIntro')),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: <Widget>[
                  for (final option in channels)
                    ChoiceChip(
                      label: Text(l10n.tOr('channel_${option.toLowerCase()}', option)),
                      selected: option == channel,
                      onSelected: (_) => setState(() => _channel = option),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              SectionCard(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(
                  children: <Widget>[
                    for (final group in groups)
                      SwitchListTile(
                        title: Text(l10n.tOr('notificationGroup_$group', group)),
                        subtitle: Text(l10n.tOr('notificationGroupHelp_$group', '')),
                        value: preferences.isEnabled(channel, group),
                        onChanged: _savingGroup == null ? (value) => _toggle(group, value) : null,
                      ),
                  ],
                ),
              ),
              InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.shieldCheck, message: l10n.t('notificationPrefsSecurity')),
              const SizedBox(height: 8),
              Text(l10n.t('notificationPrefsConsentNote'), style: Theme.of(context).textTheme.bodySmall),
            ],
          );
        },
      ),
    );
  }
}
