import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/reminders_providers.dart';
import '../data/reminder_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Reminders: the customer's documents with an expiry date on record, soonest
/// first, each with "Start renewal".
class RemindersScreen extends ConsumerWidget {
  const RemindersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final reminders = ref.watch(remindersProvider);

    Future<void> refresh() async {
      ref.invalidate(remindersProvider);
      try {
        await ref.read(remindersProvider.future);
      } catch (_) {
        // Shown by the list.
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('remindersTitle'))),
      body: AsyncValueView<List<ReminderItem>>(
        value: reminders,
        onRetry: () => ref.invalidate(remindersProvider),
        data: (items) {
          if (items.isEmpty) {
            return RefreshableList(
              onRefresh: refresh,
              children: <Widget>[
                FillRemainingMessage(
                  child: EmptyStateView(
                    icon: PhosphorIconsRegular.calendarCheck,
                    title: l10n.t('remindersEmptyTitle'),
                    message: l10n.t('remindersEmptyBody'),
                  ),
                ),
              ],
            );
          }
          return RefreshableList(
            onRefresh: refresh,
            children: <Widget>[
              // The date is what the centre has on record - not a legal deadline.
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.info, message: l10n.t('remindersRecordNote')),
              ),
              for (final reminder in items) _ReminderCard(reminder: reminder),
            ],
          );
        },
      ),
    );
  }
}

class _ReminderCard extends StatelessWidget {
  const _ReminderCard({required this.reminder});

  final ReminderItem reminder;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final days = reminder.daysLeft;
    final renewalRequestId = reminder.renewalRequestId;
    final subject = reminder.subjectLabel;

    final Tone tone;
    final String timeLeft;
    if (days == null) {
      tone = Tone.neutral;
      timeLeft = '';
    } else if (days < 0) {
      tone = Tone.danger;
      timeLeft = l10n.t('remindersExpired');
    } else if (days == 0) {
      tone = Tone.danger;
      timeLeft = l10n.t('remindersExpiresToday');
    } else {
      tone = days <= 30 ? Tone.warning : Tone.info;
      timeLeft = l10n.t('remindersDaysLeft', <String, Object?>{'count': days});
    }

    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(PhosphorIconsRegular.identificationCard, color: tokens.mutedText),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.pick(reminder.documentTypeName, reminder.documentTypeNameAr), style: theme.textTheme.titleSmall),
                    if (subject != null && subject.isNotEmpty)
                      Text(subject, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
                  ],
                ),
              ),
              if (timeLeft.isNotEmpty) StatusBadge(label: timeLeft, tone: tone),
            ],
          ),
          const SizedBox(height: 10),
          DetailRow(label: l10n.t('remindersExpiresOn'), value: Dates.calendarDate(reminder.expiryDate, l10n.languageCode)),
          if (reminder.nextReminderOn != null)
            DetailRow(label: l10n.t('remindersNextReminder'), value: Dates.calendarDate(reminder.nextReminderOn, l10n.languageCode)),
          const SizedBox(height: 8),
          if (renewalRequestId != null)
            OutlinedButton.icon(
              onPressed: () => context.push<void>(Routes.request(renewalRequestId)),
              icon: const Icon(PhosphorIconsRegular.clipboardText),
              label: Text(l10n.t('remindersOpenRenewal')),
            )
          else
            FilledButton.icon(
              // The customer picks the renewal service; the reminder is linked
              // to the new request when the draft is created.
              onPressed: () => context.push<void>(Routes.catalogueWith(renewalOf: reminder.id)),
              icon: const Icon(PhosphorIconsRegular.arrowsClockwise),
              label: Text(l10n.t('remindersStartRenewal')),
            ),
        ],
      ),
    );
  }
}
