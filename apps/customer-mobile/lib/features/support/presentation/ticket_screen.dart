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
import '../../documents/presentation/document_actions.dart';
import '../../requests/presentation/request_details_screen.dart' show MessageBubble;
import '../application/support_providers.dart';
import '../data/support_models.dart';
import '../data/support_repository.dart';
import 'attachment_picker.dart';
import 'rating_dialog.dart';
import 'support_screen.dart' show ticketTone;
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// A support conversation: the messages, a reply box with attachments, and
/// - once the ticket is resolved - the rating.
class TicketScreen extends ConsumerStatefulWidget {
  const TicketScreen({super.key, required this.ticketId});

  final String ticketId;

  @override
  ConsumerState<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends ConsumerState<TicketScreen> {
  final TextEditingController _reply = TextEditingController();
  List<TicketAttachment> _attachments = const <TicketAttachment>[];
  bool _sending = false;
  bool _rating = false;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    ref.invalidate(ticketProvider(widget.ticketId));
    try {
      await ref.read(ticketProvider(widget.ticketId).future);
    } catch (_) {
      // Shown by the screen.
    }
  }

  Future<void> _send() async {
    final text = _reply.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await ref.read(supportRepositoryProvider).reply(
            widget.ticketId,
            body: text,
            attachments: <String>[for (final attachment in _attachments) attachment.documentId],
          );
      // Cleared only after the server accepted the message.
      _reply.clear();
      if (mounted) setState(() => _attachments = const <TicketAttachment>[]);
      ref.invalidate(ticketProvider(widget.ticketId));
      ref.invalidate(ticketsProvider);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _rate() async {
    if (_rating) return;
    final l10n = context.l10n;
    final result = await showRatingDialog(context, title: l10n.t('supportRateTitle'));
    if (result == null || !mounted) return;
    setState(() => _rating = true);
    try {
      await ref.read(supportRepositoryProvider).rate(ticketId: widget.ticketId, rating: result.rating, comment: result.comment);
      ref.invalidate(ticketProvider(widget.ticketId));
      if (mounted) showMessage(context, l10n.t('ratingThanks'));
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _rating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final ticket = ref.watch(ticketProvider(widget.ticketId));
    final loaded = ticket.valueOrNull;

    return Scaffold(
      appBar: AppBar(title: Text(loaded?.ticketNo ?? l10n.t('supportTicketTitle'))),
      body: AsyncValueView<Ticket>(
        value: ticket,
        onRetry: () => ref.invalidate(ticketProvider(widget.ticketId)),
        data: (data) => _body(context, data),
      ),
    );
  }

  Widget _body(BuildContext context, Ticket ticket) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final language = l10n.languageCode;
    final requestId = ticket.requestId;
    final summary = ticket.resolutionSummary;
    final rating = ticket.rating;

    return RefreshableList(
      onRefresh: _refresh,
      children: <Widget>[
        SectionCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(ticket.subject, style: theme.textTheme.titleMedium),
              const SizedBox(height: 8),
              StatusBadge(label: l10n.tOr('ticketStatus_${ticket.status}', ticket.status), tone: ticketTone(ticket.status)),
              if (requestId != null)
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: TextButton.icon(
                    onPressed: () => context.push<void>(Routes.request(requestId)),
                    icon: const Icon(PhosphorIconsRegular.clipboardText, size: 18),
                    label: Text(ticket.requestNo ?? l10n.t('quotationOpenRequest')),
                  ),
                ),
            ],
          ),
        ),
        for (final message in ticket.messages)
          MessageBubble(
            fromCentre: message.fromSupport,
            author: message.fromSupport ? l10n.t('messageFromCentre') : l10n.t('messageFromYou'),
            body: message.body,
            time: Dates.dateTime(message.createdAt, language),
            footer: message.attachments.isEmpty
                ? null
                : Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: <Widget>[
                        for (final attachment in message.attachments)
                          ActionChip(
                            avatar: const Icon(PhosphorIconsRegular.paperclip, size: 16),
                            label: Text(attachment.title, overflow: TextOverflow.ellipsis),
                            onPressed: () => openDocument(context, ref, attachment.documentId),
                          ),
                      ],
                    ),
                  ),
          ),
        const SizedBox(height: 12),
        if (summary != null && summary.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: InfoBanner(tone: Tone.success, icon: PhosphorIconsRegular.checkCircle, title: l10n.t('supportResolution'), message: summary),
          ),
        if (rating != null)
          SectionCard(
            title: l10n.t('supportYourRating'),
            child: Semantics(
              label: l10n.t('ratingStars', <String, Object?>{'count': rating}),
              excludeSemantics: true,
              child: Row(
                children: <Widget>[
                  for (var star = 1; star <= 5; star++)
                    Icon(star <= rating ? PhosphorIconsFill.star : PhosphorIconsRegular.star, color: tokens.warning),
                ],
              ),
            ),
          )
        else if (ticket.canRate)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: FilledButton.icon(
              onPressed: _rating ? null : _rate,
              icon: const Icon(PhosphorIconsRegular.star),
              label: Text(l10n.t('supportRate')),
            ),
          ),
        if (ticket.canReply)
          SectionCard(
            title: ticket.isOpen ? l10n.t('supportReply') : l10n.t('supportReopenReply'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                TextField(
                  controller: _reply,
                  enabled: !_sending,
                  minLines: 2,
                  maxLines: 6,
                  maxLength: 4000,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(hintText: l10n.t('supportReplyHint')),
                ),
                AttachmentPicker(
                  attachments: _attachments,
                  enabled: !_sending,
                  onChanged: (next) => setState(() => _attachments = next),
                ),
                const SizedBox(height: 8),
                FilledButton.icon(
                  onPressed: _sending ? null : _send,
                  icon: _sending
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(PhosphorIconsFill.paperPlaneRight, size: 18),
                  label: Text(l10n.t('commonSend')),
                ),
              ],
            ),
          )
        else
          InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.lockSimple, message: l10n.t('supportClosedNote')),
      ],
    );
  }
}
