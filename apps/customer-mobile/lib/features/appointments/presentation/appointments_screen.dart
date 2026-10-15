import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/appointments_providers.dart';
import '../data/appointment_models.dart';
import '../data/appointments_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

Tone appointmentTone(String status) {
  switch (status) {
    case 'BOOKED':
    case 'CONFIRMED':
    case 'CHECKED_IN':
    case 'IN_SERVICE':
      return Tone.info;
    case 'COMPLETED':
      return Tone.success;
    case 'NO_SHOW':
      return Tone.danger;
    default:
      return Tone.neutral;
  }
}

/// Appointments: upcoming first, then earlier ones. Book, reschedule, cancel.
class AppointmentsScreen extends ConsumerStatefulWidget {
  const AppointmentsScreen({super.key});

  @override
  ConsumerState<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends ConsumerState<AppointmentsScreen> {
  String? _cancellingId;

  Future<void> _refresh() async {
    ref.invalidate(appointmentsProvider);
    try {
      await ref.read(appointmentsProvider.future);
    } catch (_) {
      // Shown by the list.
    }
  }

  Future<void> _cancel(Appointment appointment) async {
    final l10n = context.l10n;
    final confirmed = await showConfirmDialog(
      context,
      title: l10n.t('appointmentCancelTitle'),
      message: l10n.t('appointmentCancelBody', <String, Object?>{
        'date': Dates.calendarDate(appointment.localDate, l10n.languageCode),
        'time': appointment.localTime,
      }),
      confirmLabel: l10n.t('appointmentCancelConfirm'),
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() => _cancellingId = appointment.id);
    try {
      await ref.read(appointmentsRepositoryProvider).cancel(appointment.id);
      ref.invalidate(appointmentsProvider);
      if (mounted) showMessage(context, l10n.t('appointmentCancelled'));
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _cancellingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final appointments = ref.watch(appointmentsProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('appointmentsTitle'))),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push<void>(Routes.bookAppointment),
        icon: const Icon(PhosphorIconsBold.plus),
        label: Text(l10n.t('appointmentsBook')),
      ),
      body: AsyncValueView<List<Appointment>>(
        value: appointments,
        onRetry: () => ref.invalidate(appointmentsProvider),
        data: (items) {
          if (items.isEmpty) {
            return RefreshableList(
              onRefresh: _refresh,
              children: <Widget>[
                FillRemainingMessage(
                  child: EmptyStateView(
                    icon: PhosphorIconsRegular.calendarDots,
                    title: l10n.t('appointmentsEmptyTitle'),
                    message: l10n.t('appointmentsEmptyBody'),
                  ),
                ),
              ],
            );
          }
          final upcoming = items.where((a) => a.isUpcoming).toList()..sort((a, b) => a.startsAt.compareTo(b.startsAt));
          final earlier = items.where((a) => !a.isUpcoming).toList()..sort((a, b) => b.startsAt.compareTo(a.startsAt));
          return RefreshableList(
            onRefresh: _refresh,
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
            children: <Widget>[
              if (upcoming.isNotEmpty) _heading(context, l10n.t('appointmentsUpcoming')),
              for (final appointment in upcoming)
                _AppointmentCard(
                  appointment: appointment,
                  busy: _cancellingId == appointment.id,
                  onCancel: () => _cancel(appointment),
                ),
              if (earlier.isNotEmpty) _heading(context, l10n.t('appointmentsEarlier')),
              for (final appointment in earlier)
                _AppointmentCard(appointment: appointment, busy: false, onCancel: () => _cancel(appointment)),
            ],
          );
        },
      ),
    );
  }

  Widget _heading(BuildContext context, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 4),
      child: Semantics(header: true, child: Text(text, style: Theme.of(context).textTheme.titleMedium)),
    );
  }
}

class _AppointmentCard extends StatelessWidget {
  const _AppointmentCard({required this.appointment, required this.busy, required this.onCancel});

  final Appointment appointment;
  final bool busy;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final service = context.pick(appointment.serviceName, appointment.serviceNameAr);
    final end = appointment.localEndTime;
    final time = end == null ? appointment.localTime : '${appointment.localTime} – $end';
    final reason = appointment.cancelledReason;

    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(Dates.calendarDate(appointment.localDate, l10n.languageCode), style: theme.textTheme.titleMedium),
                    Text(time, textDirection: TextDirection.ltr, style: theme.textTheme.bodyLarge),
                  ],
                ),
              ),
              StatusBadge(
                label: l10n.tOr('appointmentStatus_${appointment.status}', appointment.status),
                tone: appointmentTone(appointment.status),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: <Widget>[
              Icon(PhosphorIconsRegular.mapPin, size: 18, color: tokens.mutedText),
              const SizedBox(width: 6),
              Expanded(child: Text(context.pick(appointment.branchName, appointment.branchNameAr))),
            ],
          ),
          if (service.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: <Widget>[
                  Icon(PhosphorIconsRegular.clipboardText, size: 18, color: tokens.mutedText),
                  const SizedBox(width: 6),
                  Expanded(child: Text(service)),
                ],
              ),
            ),
          if (reason != null && reason.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(reason, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
            ),
          if (busy)
            const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator())
          else if (appointment.canCancel || appointment.canReschedule)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(
                spacing: 8,
                children: <Widget>[
                  if (appointment.canReschedule)
                    OutlinedButton.icon(
                      onPressed: () => context.push<void>(Routes.rescheduleAppointment(appointment.id)),
                      icon: const Icon(PhosphorIconsRegular.calendarPlus, size: 18),
                      label: Text(l10n.t('appointmentReschedule')),
                    ),
                  if (appointment.canCancel)
                    TextButton(
                      style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
                      onPressed: onCancel,
                      child: Text(l10n.t('appointmentCancel')),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
