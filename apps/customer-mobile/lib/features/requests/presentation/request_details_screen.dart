import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/money_text.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../../core/widgets/status_timeline.dart';
import '../../documents/application/document_providers.dart';
import '../../documents/data/document_models.dart';
import '../../documents/presentation/document_actions.dart';
import '../../finance/presentation/finance_actions.dart';
import '../../support/data/support_repository.dart';
import '../../support/presentation/rating_dialog.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/requests_providers.dart';
import '../data/request_models.dart';
import '../data/requests_repository.dart';
import 'checklist_tile.dart';
import 'dynamic_form_field.dart';
import 'request_card.dart';
import 'timeline_builder.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Request details: status, what happens next, the one action that is due,
/// the document checklist, quotation, invoices, messages and - once the
/// request is complete - the documents to download.
class RequestDetailsScreen extends ConsumerStatefulWidget {
  const RequestDetailsScreen({super.key, required this.requestId});

  final String requestId;

  @override
  ConsumerState<RequestDetailsScreen> createState() => _RequestDetailsScreenState();
}

class _RequestDetailsScreenState extends ConsumerState<RequestDetailsScreen> {
  final TextEditingController _message = TextEditingController();
  bool _busy = false;
  bool _sending = false;
  bool _rated = false;

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    ref.invalidate(requestDetailProvider(widget.requestId));
    ref.invalidate(checklistAssistProvider(widget.requestId));
    try {
      await ref.read(requestDetailProvider(widget.requestId).future);
    } catch (_) {
      // Shown by the screen.
    }
  }

  void _invalidateLists() {
    ref.invalidate(requestListProvider);
    ref.invalidate(activeRequestsProvider);
    ref.invalidate(actionRequestsProvider);
    ref.invalidate(requestCountsProvider);
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resubmit() {
    return _run(() async {
      await ref.read(requestsRepositoryProvider).resubmit(widget.requestId);
      _invalidateLists();
      ref.invalidate(requestDetailProvider(widget.requestId));
      if (mounted) showMessage(context, context.l10n.t('requestResubmitted'));
    });
  }

  Future<void> _cancel(RequestDetail request) async {
    final l10n = context.l10n;
    final reason = await showTextInputDialog(
      context,
      title: l10n.t('requestCancelTitle'),
      message: l10n.t('requestCancelBody', <String, Object?>{'number': request.requestNo}),
      fieldLabel: l10n.t('requestCancelReason'),
      confirmLabel: l10n.t('requestCancelConfirm'),
      minLength: 3,
      destructive: true,
    );
    if (reason == null || !mounted) return;
    await _run(() async {
      await ref.read(requestsRepositoryProvider).cancel(widget.requestId, reason);
      _invalidateLists();
      ref.invalidate(requestDetailProvider(widget.requestId));
      if (mounted) showMessage(context, l10n.t('requestCancelled'));
    });
  }

  Future<void> _sendMessage() async {
    final text = _message.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await ref.read(requestsRepositoryProvider).addComment(widget.requestId, text);
      // The text is only cleared once the server accepted it.
      _message.clear();
      ref.invalidate(requestDetailProvider(widget.requestId));
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _rate(RequestDetail request) async {
    final l10n = context.l10n;
    final result = await showRatingDialog(context, title: l10n.t('requestRateTitle'));
    if (result == null || !mounted) return;
    await _run(() async {
      await ref.read(supportRepositoryProvider).rate(requestId: request.id, rating: result.rating, comment: result.comment);
      if (!mounted) return;
      setState(() => _rated = true);
      showMessage(context, l10n.t('ratingThanks'));
    });
  }

  Future<void> _openUpload(RequestDetail request, {String? checklistItemId}) async {
    await context.push<void>(Routes.requestUpload(request.id, checklistItemId: checklistItemId));
    if (!mounted) return;
    await _refresh();
  }

  Future<void> _reuse(ChecklistItem item, String documentId) {
    return _run(() async {
      await ref.read(requestsRepositoryProvider).linkDocument(widget.requestId, item.id, documentId);
      ref.invalidate(requestDetailProvider(widget.requestId));
      ref.invalidate(checklistAssistProvider(widget.requestId));
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final detail = ref.watch(requestDetailProvider(widget.requestId));
    final loaded = detail.valueOrNull;
    // Watched here (not inside the list callback) so that this widget owns
    // the subscriptions.
    final tenantCurrency = ref.watch(tenantControllerProvider)?.currency ?? 'AED';
    final assist = ref.watch(checklistAssistProvider(widget.requestId)).valueOrNull;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.t('requestDetailsTitle')),
        actions: <Widget>[
          if (loaded != null)
            IconButton(
              tooltip: l10n.t('requestContactSupport'),
              icon: const Icon(PhosphorIconsRegular.headset),
              onPressed: () => context.push<void>(Routes.newTicketFor(loaded.id)),
            ),
        ],
      ),
      body: AsyncValueView<RequestDetail>(
        value: detail,
        onRetry: () => ref.invalidate(requestDetailProvider(widget.requestId)),
        data: (request) => RefreshableList(onRefresh: _refresh, children: _sections(context, request, tenantCurrency, assist)),
      ),
    );
  }

  List<Widget> _sections(BuildContext context, RequestDetail request, String tenantCurrency, ChecklistAssist? assist) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final language = l10n.languageCode;
    final currency = request.currencyOr(tenantCurrency);
    final external = request.externalStatus;
    final nextText = request.nextStepText.resolve(language);
    final timeline = buildRequestTimeline(request, language);
    final recent = timeline.where((e) => e.state != TimelineState.upcoming).toList();
    final preview = recent.length > 3 ? recent.sublist(recent.length - 3) : recent;
    final canUpload = request.can('upload_documents');
    final cancel = request.transitionTo('CANCELLED');
    final quotation = request.quotation;
    final completed = request.completionItems.where((c) => c.document != null).toList();

    return <Widget>[
      // ---- status header
      SectionCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(context.pick(request.serviceName, request.serviceNameAr), style: theme.textTheme.titleLarge),
            const SizedBox(height: 2),
            Text(
              request.requestNo,
              textDirection: TextDirection.ltr,
              style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: <Widget>[
                StatusBadge(label: request.statusLabel.resolve(language), tone: toneFromString(request.tone)),
                if (request.overdue) StatusBadge(label: l10n.t('requestOverdue'), tone: Tone.warning, icon: PhosphorIconsRegular.clock),
              ],
            ),
            if (external != null) Padding(padding: const EdgeInsets.only(top: 10), child: ExternalStatusLine(status: external)),
            const Divider(height: 24),
            if (request.submittedAt != null)
              DetailRow(label: l10n.t('requestSubmitted'), value: Dates.date(request.submittedAt, language)),
            if (request.targetDate != null && !request.isClosed)
              DetailRow(label: l10n.t('requestEstimatedCompletion'), value: Dates.date(request.targetDate, language)),
            if (request.completedAt != null)
              DetailRow(label: l10n.t('requestCompleted'), value: Dates.date(request.completedAt, language)),
            if (request.branchName != null)
              DetailRow(label: l10n.t('requestBranch'), value: context.pick(request.branchName, request.branchNameAr)),
          ],
        ),
      ),

      // ---- what happens next + the one action that is due
      if (nextText.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: InfoBanner(
            tone: request.waitingOn == 'CUSTOMER' ? Tone.warning : Tone.info,
            icon: request.waitingOn == 'CUSTOMER' ? PhosphorIconsRegular.clockCountdown : PhosphorIconsRegular.flag,
            title: l10n.t('requestWhatNext'),
            message: nextText,
          ),
        ),
      ..._primaryAction(context, request),

      // ---- timeline preview
      SectionCard(
        title: l10n.t('requestTimelineTitle'),
        trailing: TextButton(
          onPressed: () => context.push<void>(Routes.requestTimeline(request.id)),
          child: Text(l10n.t('requestTimelineAll')),
        ),
        child: StatusTimeline(entries: preview),
      ),

      // ---- completed documents
      if (completed.isNotEmpty)
        SectionCard(
          title: l10n.t('requestCompletedDocuments'),
          child: Column(
            children: <Widget>[
              for (final item in completed)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(PhosphorIconsRegular.fileText, color: tokens.success),
                  title: Text(context.pick(item.label, item.labelAr)),
                  subtitle: Text(Dates.date(item.document!.uploadedAt, language)),
                  trailing: IconButton(
                    tooltip: l10n.t('documentDownload'),
                    icon: const Icon(PhosphorIconsRegular.downloadSimple),
                    onPressed: () => openDocument(context, ref, item.document!.id, download: true),
                  ),
                  onTap: () => openDocument(context, ref, item.document!.id),
                ),
            ],
          ),
        ),

      // ---- document checklist
      if (request.inputItems.isNotEmpty)
        SectionCard(
          title: l10n.t('requestDocuments'),
          trailing: canUpload
              ? TextButton.icon(
                  onPressed: () => _openUpload(request),
                  icon: const Icon(PhosphorIconsBold.plus, size: 18),
                  label: Text(l10n.t('requestAddDocument')),
                )
              : null,
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Column(
            children: <Widget>[
              for (var i = 0; i < request.inputItems.length; i++) ...<Widget>[
                if (i > 0) const Divider(),
                ChecklistTile(
                  item: request.inputItems[i],
                  assist: assist?.forItem(request.inputItems[i].id),
                  onUpload: canUpload ? () => _openUpload(request, checklistItemId: request.inputItems[i].id) : null,
                  onReuse: canUpload ? (candidate) => _reuse(request.inputItems[i], candidate.documentId) : null,
                  onView: request.inputItems[i].document == null
                      ? null
                      : () => openDocument(context, ref, request.inputItems[i].document!.id),
                ),
              ],
            ],
          ),
        ),

      // ---- quotation
      if (quotation != null)
        SectionCard(
          title: l10n.t('requestQuotation'),
          trailing: StatusBadge(
            label: l10n.tOr('quotationStatus_${quotation.status}', quotation.status),
            tone: quotation.status == 'SENT' ? Tone.warning : (quotation.status == 'APPROVED' ? Tone.success : Tone.neutral),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              DetailRow(label: l10n.t('quotationNumber'), value: quotation.quotationNo),
              Row(
                children: <Widget>[
                  Expanded(child: Text(l10n.t('quotationTotal'), style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText))),
                  MoneyText(quotation.total, currency: quotation.currency, style: theme.textTheme.titleMedium),
                ],
              ),
              if (quotation.validUntil != null && quotation.status == 'SENT')
                DetailRow(label: l10n.t('quotationValidUntil'), value: Dates.date(quotation.validUntil, language)),
              const SizedBox(height: 8),
              if (quotation.status == 'SENT')
                Row(
                  children: <Widget>[
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _busy ? null : () => rejectQuotationFlow(context, ref, quotationId: quotation.id, requestId: request.id),
                        child: Text(l10n.t('quotationReject')),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: _busy
                            ? null
                            : () => approveQuotationFlow(
                                  context,
                                  ref,
                                  quotationId: quotation.id,
                                  total: quotation.total,
                                  currency: quotation.currency,
                                  requestId: request.id,
                                ),
                        child: Text(l10n.t('quotationApprove')),
                      ),
                    ),
                  ],
                ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton(
                  onPressed: () => context.push<void>(Routes.quotation(quotation.id)),
                  child: Text(l10n.t('quotationViewBreakdown')),
                ),
              ),
            ],
          ),
        ),

      // ---- invoices and payments
      if (request.invoices.isNotEmpty)
        SectionCard(
          title: l10n.t('requestInvoices'),
          child: Column(
            children: <Widget>[
              for (final invoice in request.invoices)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(invoice.invoiceNo, textDirection: TextDirection.ltr),
                  subtitle: Text(l10n.tOr('invoiceStatus_${invoice.status}', invoice.status)),
                  trailing: Column(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: <Widget>[
                      MoneyText(invoice.total, currency: invoice.currency, style: theme.textTheme.titleSmall),
                      if (invoice.isPayable)
                        Text(
                          l10n.t('invoiceBalanceShort', <String, Object?>{'amount': invoice.balanceDue}),
                          style: theme.textTheme.bodySmall?.copyWith(color: tokens.warning),
                        ),
                    ],
                  ),
                  onTap: () => context.push<void>(Routes.invoice(invoice.id)),
                ),
              const Divider(),
              Row(
                children: <Widget>[
                  Expanded(child: Text(l10n.t('invoicePaidTotal'))),
                  MoneyText(request.totalPaid, currency: currency),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: <Widget>[
                  Expanded(child: Text(l10n.t('invoiceBalance'), style: theme.textTheme.titleSmall)),
                  MoneyText(request.totalBalance, currency: currency, style: theme.textTheme.titleSmall),
                ],
              ),
            ],
          ),
        ),

      // ---- external references (always with their source)
      if (request.externalReferences.isNotEmpty)
        SectionCard(
          title: l10n.t('requestExternalTitle'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (final reference in request.externalReferences)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      if (reference.authorityName != null) Text(reference.authorityName!, style: theme.textTheme.titleSmall),
                      DetailRow(label: l10n.t('requestExternalReference'), value: reference.referenceNo),
                      if (reference.status != null)
                        ExternalStatusLine(
                          status: ExternalStatus(
                            status: reference.status!,
                            source: reference.statusSource,
                            sourceLabel: reference.statusSourceLabel,
                            at: reference.recordedAt,
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),

      // ---- messages
      SectionCard(
        title: l10n.t('requestMessages'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (request.comments.isEmpty)
              Text(l10n.t('requestNoMessages'), style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText)),
            for (final comment in request.comments)
              MessageBubble(
                fromCentre: comment.fromCentre,
                author: comment.fromCentre ? (comment.authorName ?? l10n.t('messageFromCentre')) : l10n.t('messageFromYou'),
                body: comment.body,
                time: Dates.dateTime(comment.createdAt, language),
              ),
            if (request.can('comment')) ...<Widget>[
              const SizedBox(height: 8),
              TextField(
                controller: _message,
                minLines: 1,
                maxLines: 4,
                maxLength: 2000,
                enabled: !_sending,
                decoration: InputDecoration(
                  hintText: l10n.t('requestMessageHint'),
                  counterText: '',
                  suffixIcon: IconButton(
                    tooltip: l10n.t('commonSend'),
                    icon: _sending
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(PhosphorIconsFill.paperPlaneRight),
                    onPressed: _sending ? null : _sendMessage,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),

      // ---- what the customer submitted
      if (!request.formSchema.isEmpty)
        SectionCard(
          padding: EdgeInsets.zero,
          child: Theme(
            data: theme.copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              title: Text(l10n.t('requestYourDetails'), style: theme.textTheme.titleMedium),
              childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              children: <Widget>[
                for (final field in request.formSchema.fields)
                  if (!_isEmptyValue(request.formValues[field.key]))
                    DetailRow(
                      label: field.displayLabel(language),
                      value: describeFormValue(l10n, field, request.formValues[field.key]),
                    ),
                if (request.customerInstructions != null && request.customerInstructions!.trim().isNotEmpty)
                  DetailRow(label: l10n.t('wizardInstructionsTitle'), value: request.customerInstructions!),
              ],
            ),
          ),
        ),

      // ---- secondary actions
      if (request.isCompleted && !_rated)
        OutlinedButton.icon(
          onPressed: _busy ? null : () => _rate(request),
          icon: const Icon(PhosphorIconsRegular.star),
          label: Text(l10n.t('requestRate')),
        ),
      if (cancel != null && cancel.enabled)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
            onPressed: _busy ? null : () => _cancel(request),
            icon: const Icon(PhosphorIconsRegular.xCircle),
            label: Text(l10n.t('requestCancel')),
          ),
        ),
    ];
  }

  static bool _isEmptyValue(Object? value) {
    if (value == null) return true;
    if (value is String) return value.trim().isEmpty;
    if (value is List) return value.isEmpty;
    return false;
  }

  /// The single primary action for the current status, if the customer has one.
  List<Widget> _primaryAction(BuildContext context, RequestDetail request) {
    final l10n = context.l10n;
    Widget? button;
    String? hint;

    if (request.isDraft) {
      button = PrimaryButton(
        label: l10n.t('requestContinueDraft'),
        icon: PhosphorIconsRegular.pencilSimple,
        onPressed: () => context.push<void>(Routes.requestWizard(request.id)),
      );
    } else if (request.awaitingCustomer) {
      final resubmit = request.transitionTo('UNDER_REVIEW') ?? request.transitionTo('IN_PREPARATION');
      final enabled = request.can('resubmit') && (resubmit == null || resubmit.enabled);
      button = PrimaryButton(
        label: l10n.t('requestResubmit'),
        icon: PhosphorIconsFill.paperPlaneRight,
        loading: _busy,
        onPressed: enabled ? _resubmit : null,
      );
      if (!enabled) hint = resubmit?.blockedMessage ?? l10n.t('requestResubmitBlocked');
    } else if (request.status == 'QUOTED' && request.quotation != null) {
      final quotationId = request.quotation!.id;
      button = PrimaryButton(
        label: l10n.t('requestReviewQuotation'),
        icon: PhosphorIconsRegular.invoice,
        onPressed: () => context.push<void>(Routes.quotation(quotationId)),
      );
    } else if (request.status == 'AWAITING_PAYMENT') {
      RequestInvoiceRef? payable;
      for (final invoice in request.invoices) {
        if (invoice.isPayable) {
          payable = invoice;
          break;
        }
      }
      if (payable != null) {
        final invoiceId = payable.id;
        button = PrimaryButton(
          label: l10n.t('requestPayNow'),
          icon: PhosphorIconsRegular.creditCard,
          onPressed: () => context.push<void>(Routes.invoice(invoiceId)),
        );
      }
    }

    if (button == null) return const <Widget>[];
    return <Widget>[
      button,
      if (hint != null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(hint, style: Theme.of(context).textTheme.bodySmall),
        ),
      const SizedBox(height: 12),
    ];
  }
}

/// A chat-style message: the centre on the start side, the customer on the
/// end side (mirrors automatically in Arabic).
class MessageBubble extends StatelessWidget {
  const MessageBubble({super.key, required this.fromCentre, required this.author, required this.body, required this.time, this.footer});

  final bool fromCentre;
  final String author;
  final String body;
  final String time;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final extra = footer;
    return Align(
      alignment: fromCentre ? AlignmentDirectional.centerStart : AlignmentDirectional.centerEnd,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: BoxDecoration(
          color: fromCentre ? tokens.neutralContainer : tokens.infoContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(author, style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(body, style: theme.textTheme.bodyMedium),
            if (extra != null) extra,
            const SizedBox(height: 4),
            Text(time, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
          ],
        ),
      ),
    );
  }
}
