import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/select_field.dart';
import '../../../core/widgets/status_badge.dart';
import '../../requests/data/request_models.dart';
import '../../requests/data/requests_repository.dart';
import '../application/support_providers.dart';
import '../data/support_models.dart';
import '../data/support_repository.dart';
import 'attachment_picker.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// The customer's most recent requests, to link a ticket to one of them.
final _linkableRequestsProvider = FutureProvider.autoDispose<List<RequestSummary>>((ref) async {
  final page = await ref.watch(requestsRepositoryProvider).list(pageSize: 30);
  return page.items.where((r) => !r.isDraft).toList(growable: false);
});

/// New support ticket, optionally about one of the customer's requests and
/// with documents attached.
class NewTicketScreen extends ConsumerStatefulWidget {
  const NewTicketScreen({super.key, this.requestId});

  /// Preselected request (when opened from a request).
  final String? requestId;

  @override
  ConsumerState<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends ConsumerState<NewTicketScreen> {
  static const String _noRequest = '';

  final TextEditingController _subject = TextEditingController();
  final TextEditingController _body = TextEditingController();
  late String _requestId;
  List<TicketAttachment> _attachments = const <TicketAttachment>[];
  Map<String, String> _errors = <String, String>{};
  String? _formError;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _requestId = widget.requestId ?? _noRequest;
  }

  @override
  void dispose() {
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final l10n = context.l10n;
    final errors = <String, String>{};
    if (_subject.text.trim().length < 3) errors['subject'] = l10n.t('supportSubjectRequired');
    if (_body.text.trim().length < 3) errors['message'] = l10n.t('supportMessageRequired');
    setState(() {
      _errors = errors;
      _formError = null;
    });
    if (errors.isNotEmpty) return;

    setState(() => _busy = true);
    try {
      final ticket = await ref.read(supportRepositoryProvider).create(
            subject: _subject.text,
            message: _body.text,
            requestId: _requestId.isEmpty ? null : _requestId,
            attachments: <String>[for (final attachment in _attachments) attachment.documentId],
          );
      ref.invalidate(ticketsProvider);
      if (!mounted) return;
      showMessage(context, l10n.t('supportTicketCreated', <String, Object?>{'number': ticket.ticketNo}));
      context.pushReplacement(Routes.ticket(ticket.id));
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _errors = fields;
        _formError = fields.isEmpty ? describeError(l10n, error) : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _formError = describeError(l10n, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final requests = ref.watch(_linkableRequestsProvider).valueOrNull ?? const <RequestSummary>[];
    final formError = _formError;
    // A preselected request stays selectable even if it is not among the
    // newest ones that were loaded.
    final preselected = widget.requestId;
    final hasPreselected = preselected != null && requests.any((r) => r.id == preselected);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('supportNewTicket'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: <Widget>[
          if (formError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
            ),
          AppTextField(
            controller: _subject,
            label: l10n.t('supportSubject'),
            errorText: _errors['subject'],
            maxLength: 200,
            textInputAction: TextInputAction.next,
            textCapitalization: TextCapitalization.sentences,
            enabled: !_busy,
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: SelectField(
              label: l10n.t('supportAboutRequest'),
              value: _requestId,
              enabled: !_busy,
              options: <SelectOption>[
                SelectOption(value: _noRequest, label: l10n.t('supportNoRequest')),
                if (preselected != null && !hasPreselected) SelectOption(value: preselected, label: l10n.t('supportThisRequest')),
                for (final request in requests)
                  SelectOption(
                    value: request.id,
                    label: '${request.requestNo} · ${context.pick(request.serviceName, request.serviceNameAr)}',
                  ),
              ],
              onChanged: (value) => setState(() => _requestId = value ?? _noRequest),
            ),
          ),
          AppTextField(
            controller: _body,
            label: l10n.t('supportMessage'),
            errorText: _errors['message'],
            maxLines: 8,
            maxLength: 4000,
            textCapitalization: TextCapitalization.sentences,
            enabled: !_busy,
          ),
          SectionCard(
            title: l10n.t('supportAttachments'),
            child: AttachmentPicker(
              attachments: _attachments,
              enabled: !_busy,
              onChanged: (next) => setState(() => _attachments = next),
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: PrimaryButton(label: l10n.t('supportSend'), icon: PhosphorIconsFill.paperPlaneRight, loading: _busy, onPressed: _submit),
        ),
      ),
    );
  }
}
