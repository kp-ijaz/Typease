import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/select_field.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../catalogue/application/catalogue_providers.dart';
import '../../catalogue/data/catalogue_models.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/appointments_providers.dart';
import '../data/appointment_models.dart';
import '../data/appointments_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Book (or reschedule) an appointment in four small steps on one page:
/// branch -> service (optional) -> day -> a free time slot.
///
/// Free slots come from the availability endpoint; the server checks the
/// capacity again when booking, so a slot taken in the meantime is reported
/// and the list is reloaded.
class BookAppointmentScreen extends ConsumerStatefulWidget {
  const BookAppointmentScreen({super.key, this.rescheduleId});

  /// Id of the appointment to move; null for a new booking.
  final String? rescheduleId;

  @override
  ConsumerState<BookAppointmentScreen> createState() => _BookAppointmentScreenState();
}

class _BookAppointmentScreenState extends ConsumerState<BookAppointmentScreen> {
  static const String _noService = '';

  final TextEditingController _notes = TextEditingController();
  String? _branchId;
  String _serviceId = _noService;
  late DateTime _date;
  AppointmentSlot? _slot;
  bool _busy = false;
  bool _prefilled = false;

  bool get _rescheduling => widget.rescheduleId != null;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _date = DateTime(now.year, now.month, now.day);
  }

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  /// When rescheduling, start from the branch and service of the appointment.
  void _prefillFrom(List<Appointment> appointments) {
    if (_prefilled || !_rescheduling) return;
    for (final appointment in appointments) {
      if (appointment.id != widget.rescheduleId) continue;
      _prefilled = true;
      _branchId = appointment.branchId;
      _serviceId = appointment.serviceId ?? _noService;
    }
  }

  AvailabilityQuery? get _query {
    final branchId = _branchId;
    if (branchId == null) return null;
    return AvailabilityQuery(branchId: branchId, date: _date, serviceId: _serviceId.isEmpty ? null : _serviceId);
  }

  Future<void> _pickDate(DateTime? lastBookable) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final last = lastBookable ?? today.add(const Duration(days: 60));
    final picked = await showDatePicker(
      context: context,
      initialDate: _date.isAfter(last) ? last : _date,
      firstDate: today,
      lastDate: last.isBefore(today) ? today : last,
    );
    if (picked != null && mounted) {
      setState(() {
        _date = picked;
        _slot = null;
      });
    }
  }

  Future<void> _submit() async {
    final branchId = _branchId;
    final slot = _slot;
    if (_busy || branchId == null || slot == null) return;
    final l10n = context.l10n;
    final repository = ref.read(appointmentsRepositoryProvider);
    setState(() => _busy = true);
    try {
      final rescheduleId = widget.rescheduleId;
      if (rescheduleId != null) {
        await repository.reschedule(rescheduleId, startsAt: slot.startsAt, branchId: branchId);
      } else {
        await repository.book(
          branchId: branchId,
          startsAt: slot.startsAt,
          serviceId: _serviceId.isEmpty ? null : _serviceId,
          notes: _notes.text,
        );
      }
      ref.invalidate(appointmentsProvider);
      if (!mounted) return;
      showMessage(context, _rescheduling ? l10n.t('appointmentRescheduled') : l10n.t('appointmentBooked'));
      context.pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      showError(context, error);
      // Someone else took the slot, or it is no longer offered: reload.
      final query = _query;
      if (query != null) ref.invalidate(availabilityProvider(query));
      setState(() => _slot = null);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final tenant = ref.watch(tenantControllerProvider);
    final branches = ref.watch(bookableBranchesProvider);
    final services = ref.watch(catalogueProvider).valueOrNull?.services ?? const <CatalogueService>[];
    if (_rescheduling) {
      final mine = ref.watch(appointmentsProvider).valueOrNull;
      if (mine != null) _prefillFrom(mine);
    }
    // With a single branch there is nothing to choose.
    final known = branches.valueOrNull;
    if (_branchId == null && known != null && known.length == 1) _branchId = known.first.id;
    final query = _query;
    final availability = query == null ? null : ref.watch(availabilityProvider(query));
    final lastBookable = Dates.parseCalendarDate(availability?.valueOrNull?.bookableUntil);

    return Scaffold(
      appBar: AppBar(title: Text(_rescheduling ? l10n.t('appointmentRescheduleTitle') : l10n.t('appointmentBookTitle'))),
      body: AsyncValueView<List<BranchOption>>(
        value: branches,
        onRetry: () => ref.invalidate(bookableBranchesProvider),
        data: (options) {
          if (options.isEmpty) {
            // The API offers customers no list of branches unless the centre
            // published them; say so instead of showing an empty picker.
            return EmptyStateView(
              icon: PhosphorIconsRegular.storefront,
              title: l10n.t('appointmentNoBranchesTitle'),
              message: l10n.t('appointmentNoBranchesBody', <String, Object?>{
                'contact': tenant?.supportPhone ?? tenant?.supportEmail ?? '',
              }),
            );
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            children: <Widget>[
              SectionCard(
                title: l10n.t('appointmentStepBranch'),
                child: SelectField(
                  label: l10n.t('appointmentBranch'),
                  value: _branchId,
                  options: <SelectOption>[
                    for (final branch in options) SelectOption(value: branch.id, label: context.pick(branch.name, branch.nameAr)),
                  ],
                  onChanged: (value) => setState(() {
                    _branchId = value;
                    _slot = null;
                  }),
                ),
              ),
              if (!_rescheduling)
                SectionCard(
                  title: l10n.t('appointmentStepService'),
                  child: SelectField(
                    label: l10n.t('appointmentService'),
                    helperText: l10n.t('appointmentServiceHelp'),
                    value: _serviceId,
                    options: <SelectOption>[
                      SelectOption(value: _noService, label: l10n.t('appointmentGeneralVisit')),
                      for (final service in services)
                        SelectOption(value: service.id, label: context.pick(service.name, service.nameAr)),
                    ],
                    onChanged: (value) => setState(() {
                      _serviceId = value ?? _noService;
                      _slot = null;
                    }),
                  ),
                ),
              SectionCard(
                title: l10n.t('appointmentStepDay'),
                child: Row(
                  children: <Widget>[
                    Expanded(child: Text(Dates.weekdayDate(_date, l10n.languageCode), style: theme.textTheme.titleMedium)),
                    OutlinedButton.icon(
                      onPressed: () => _pickDate(lastBookable),
                      icon: const Icon(PhosphorIconsRegular.calendarBlank, size: 18),
                      label: Text(l10n.t('appointmentChangeDay')),
                    ),
                  ],
                ),
              ),
              SectionCard(
                title: l10n.t('appointmentStepTime'),
                child: availability == null
                    ? Text(l10n.t('appointmentChooseBranchFirst'))
                    : AsyncValueView<Availability>(
                        value: availability,
                        onRetry: query == null ? null : () => ref.invalidate(availabilityProvider(query)),
                        loading: const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator()),
                        data: (day) => _slots(context, day),
                      ),
              ),
              if (!_rescheduling)
                SectionCard(
                  title: l10n.t('appointmentNotesTitle'),
                  child: TextField(
                    controller: _notes,
                    minLines: 2,
                    maxLines: 4,
                    maxLength: 500,
                    decoration: InputDecoration(hintText: l10n.t('appointmentNotesHint')),
                  ),
                ),
              Text(
                l10n.t('appointmentTimezoneNote', <String, Object?>{'timezone': tenant?.timezone ?? ''}),
                style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
              ),
            ],
          );
        },
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: PrimaryButton(
            label: _rescheduling ? l10n.t('appointmentRescheduleSubmit') : l10n.t('appointmentBookSubmit'),
            loading: _busy,
            onPressed: (_slot == null || _branchId == null) ? null : _submit,
          ),
        ),
      ),
    );
  }

  Widget _slots(BuildContext context, Availability day) {
    final l10n = context.l10n;
    if (day.closed) {
      return InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.calendarX, message: l10n.t('appointmentClosed'));
    }
    final free = day.freeSlots;
    if (free.isEmpty) {
      return InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.calendarX, message: l10n.t('appointmentNoSlots'));
    }
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: <Widget>[
        for (final slot in free)
          ChoiceChip(
            label: Text(slot.localStart, textDirection: TextDirection.ltr),
            selected: _slot?.startsAt == slot.startsAt,
            onSelected: (_) => setState(() => _slot = slot),
          ),
      ],
    );
  }
}
