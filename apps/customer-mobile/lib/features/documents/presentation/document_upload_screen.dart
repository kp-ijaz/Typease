import 'dart:async';

import 'package:app_settings/app_settings.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/select_field.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../requests/application/requests_providers.dart';
import '../../requests/data/request_models.dart';
import '../application/document_providers.dart';
import '../application/upload_queue.dart';
import '../data/document_models.dart';
import '../data/documents_repository.dart';
import '../data/upload_rules.dart';
import 'camera_capture_screen.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Document upload for a request: take a photo, choose photos or choose
/// files. Each file is checked on the device (type by content, size), then
/// uploaded in three steps with its own progress bar.
class DocumentUploadScreen extends ConsumerStatefulWidget {
  const DocumentUploadScreen({super.key, required this.requestId, this.checklistItemId});

  final String requestId;

  /// The checklist line this upload answers; null for an additional document.
  final String? checklistItemId;

  @override
  ConsumerState<DocumentUploadScreen> createState() => _DocumentUploadScreenState();
}

class _DocumentUploadScreenState extends ConsumerState<DocumentUploadScreen> {
  final ImagePicker _imagePicker = ImagePicker();
  String? _documentTypeKey;
  String? _expiryDate;
  bool _picking = false;

  /// True once a file for the checklist line is uploading or uploaded. Further
  /// files (more pages) are attached to the request without replacing it.
  bool _lineTaken = false;

  ChecklistItem? _item(RequestDetail detail) {
    final id = widget.checklistItemId;
    if (id == null) return null;
    for (final item in detail.checklist) {
      if (item.id == id) return item;
    }
    return null;
  }

  Future<void> _startUpload(RequestDetail detail, {required String path, required String name}) async {
    final l10n = context.l10n;
    final item = _item(detail);
    final typeKey = item?.documentTypeKey ?? _documentTypeKey;
    if (typeKey == null || typeKey.isEmpty) {
      showMessage(context, l10n.t('uploadChooseType'), isError: true);
      return;
    }
    LocalFile file;
    try {
      file = await DocumentsRepository.inspect(path: path, name: name);
    } on LocalFileRejected catch (rejected) {
      if (!mounted) return;
      showMessage(
        context,
        l10n.t('uploadRejected_${rejected.reason}', <String, Object?>{'name': rejected.name, 'limit': UploadRules.maxBytes ~/ (1024 * 1024)}),
        isError: true,
      );
      return;
    }
    if (!mounted) return;
    // The first file answers the checklist line; further files (more pages)
    // are filed under the request.
    final String? lineId = (item != null && !_lineTaken) ? item.id : null;
    final useLine = lineId != null;
    if (useLine) _lineTaken = true;
    final target = UploadTarget(
      documentTypeKey: typeKey,
      requestId: detail.id,
      checklistItemId: lineId,
      expiryDate: _expiryDate,
    );
    final ok = await ref.read(uploadQueueProvider(detail.id).notifier).start(file, target);
    if (!ok && useLine && mounted) {
      // The line is still unanswered; the next file should fill it.
      setState(() => _lineTaken = false);
    }
  }

  Future<void> _guardPicking(Future<void> Function() action) async {
    if (_picking) return;
    setState(() => _picking = true);
    try {
      await action();
    } on PlatformException catch (error) {
      if (!mounted) return;
      final code = error.code.toLowerCase();
      if (code.contains('denied') || code.contains('restricted') || code.contains('permission')) {
        _showPermissionMessage();
      } else {
        showMessage(context, context.l10n.t('uploadPickFailed'), isError: true);
      }
    } catch (_) {
      if (!mounted) return;
      showMessage(context, context.l10n.t('uploadPickFailed'), isError: true);
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  void _showPermissionMessage() {
    final l10n = context.l10n;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(l10n.t('uploadPermissionDenied')),
        duration: const Duration(seconds: 8),
        action: SnackBarAction(label: l10n.t('captureOpenSettings'), onPressed: () => AppSettings.openAppSettings()),
      ),
    );
  }

  Future<void> _takePhoto(RequestDetail detail) {
    return _guardPicking(() async {
      final photo = await context.push<CapturedPhoto>(Routes.capture);
      if (photo == null || !mounted) return;
      await _startUpload(detail, path: photo.path, name: photo.name);
    });
  }

  Future<void> _choosePhotos(RequestDetail detail) {
    return _guardPicking(() async {
      final photos = await _imagePicker.pickMultiImage(maxWidth: 2400, maxHeight: 2400, imageQuality: 85);
      for (final photo in photos) {
        if (!mounted) return;
        // Not awaited one after the other on purpose: uploads run in parallel.
        unawaited(_startUpload(detail, path: photo.path, name: photo.name));
      }
    });
  }

  Future<void> _chooseFiles(RequestDetail detail) {
    return _guardPicking(() async {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: UploadRules.allowedExtensions,
        allowMultiple: true,
      );
      if (result == null) return;
      for (final picked in result.files) {
        final path = picked.path;
        if (path == null || !mounted) continue;
        unawaited(_startUpload(detail, path: path, name: picked.name));
      }
    });
  }

  Future<void> _pickExpiry() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: Dates.parseCalendarDate(_expiryDate) ?? now,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 30),
    );
    if (picked != null && mounted) setState(() => _expiryDate = Dates.toIsoDate(picked));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final detail = ref.watch(requestDetailProvider(widget.requestId));
    final tasks = ref.watch(uploadQueueProvider(widget.requestId));
    final running = tasks.any((t) => t.phase == UploadPhase.uploading);
    final types = ref.watch(documentTypesProvider).valueOrNull ?? const <DocumentType>[];

    return PopScope(
      // Leaving would cancel uploads that are still running.
      canPop: !running,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) showMessage(context, l10n.t('uploadWaitToFinish'));
      },
      child: Scaffold(
        appBar: AppBar(title: Text(l10n.t('uploadTitle'))),
        body: AsyncValueView<RequestDetail>(
          value: detail,
          onRetry: () => ref.invalidate(requestDetailProvider(widget.requestId)),
          data: (request) => _body(context, request, tasks, types),
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: PrimaryButton(
              label: running ? l10n.t('uploadInProgress') : l10n.t('commonDone'),
              onPressed: running ? null : () => context.pop(),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, RequestDetail request, List<UploadTask> tasks, List<DocumentType> types) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final item = _item(request);
    final note = item?.note;
    final expiry = _expiryDate;
    final limitMb = UploadRules.maxBytes ~/ (1024 * 1024);

    if (!request.can('upload_documents')) {
      return EmptyStateView(
        icon: PhosphorIconsRegular.lockSimple,
        title: l10n.t('uploadNotPossibleTitle'),
        message: l10n.t('uploadNotPossibleBody'),
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: <Widget>[
        if (item != null) ...<Widget>[
          Semantics(
            header: true,
            child: Text(context.pick(item.label, item.labelAr), style: theme.textTheme.titleLarge),
          ),
          const SizedBox(height: 4),
          Text(
            '${context.pick(request.serviceName, request.serviceNameAr)} · ${request.requestNo}',
            style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
          ),
          if (item.isRejected && note != null && note.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.chatCenteredText, title: l10n.t('checklistRejectedWhy'), message: note),
            ),
          const SizedBox(height: 16),
        ] else ...<Widget>[
          Text(l10n.t('uploadAdditionalIntro')),
          const SizedBox(height: 12),
          SelectField(
            label: l10n.t('uploadDocumentType'),
            value: _documentTypeKey,
            options: <SelectOption>[
              for (final type in types) SelectOption(value: type.key, label: context.pick(type.name, type.nameAr)),
            ],
            onChanged: (value) => setState(() => _documentTypeKey = value),
          ),
          const SizedBox(height: 16),
        ],
        SectionCard(
          title: l10n.t('uploadAddTitle'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              FilledButton.icon(
                onPressed: _picking ? null : () => _takePhoto(request),
                icon: const Icon(PhosphorIconsRegular.camera),
                label: Text(l10n.t('uploadTakePhoto')),
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _picking ? null : () => _choosePhotos(request),
                icon: const Icon(PhosphorIconsRegular.images),
                label: Text(l10n.t('uploadChoosePhotos')),
              ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: _picking ? null : () => _chooseFiles(request),
                icon: const Icon(PhosphorIconsRegular.paperclip),
                label: Text(l10n.t('uploadChooseFiles')),
              ),
              const SizedBox(height: 12),
              Text(
                l10n.t('uploadRules', <String, Object?>{'limit': limitMb}),
                style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
              ),
            ],
          ),
        ),
        SectionCard(
          title: l10n.t('uploadExpiryTitle'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(l10n.t('uploadExpiryHelp'), style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
              const SizedBox(height: 8),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(expiry == null ? l10n.t('uploadExpiryNone') : Dates.calendarDate(expiry, l10n.languageCode)),
                  ),
                  if (expiry != null)
                    IconButton(
                      tooltip: l10n.t('commonClear'),
                      icon: const Icon(PhosphorIconsRegular.x),
                      onPressed: () => setState(() => _expiryDate = null),
                    ),
                  OutlinedButton(onPressed: _pickExpiry, child: Text(l10n.t('uploadExpiryChoose'))),
                ],
              ),
            ],
          ),
        ),
        if (tasks.isNotEmpty)
          SectionCard(
            title: l10n.t('uploadListTitle'),
            child: Column(
              children: <Widget>[
                for (final task in tasks) _UploadRow(task: task, requestId: widget.requestId),
              ],
            ),
          ),
        InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.shield, message: l10n.t('uploadSecurityNote')),
      ],
    );
  }
}

class _UploadRow extends ConsumerWidget {
  const _UploadRow({required this.task, required this.requestId});

  final UploadTask task;
  final String requestId;

  static String _size(int bytes) {
    if (bytes >= 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
    return '$bytes B';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final queue = ref.read(uploadQueueProvider(requestId).notifier);
    final percent = (task.progress * 100).round();
    final error = task.error;

    String status;
    Tone tone;
    if (task.phase == UploadPhase.uploading) {
      status = l10n.t('uploadStatusUploading', <String, Object?>{'percent': percent});
      tone = Tone.info;
    } else if (task.phase == UploadPhase.done) {
      status = l10n.t('uploadStatusDone');
      tone = Tone.success;
    } else if (task.phase == UploadPhase.failed) {
      status = error == null ? l10n.t('uploadStatusFailed') : describeError(l10n, error);
      tone = Tone.danger;
    } else {
      status = l10n.t('uploadStatusCancelled');
      tone = Tone.neutral;
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(task.file.isImage ? PhosphorIconsRegular.image : PhosphorIconsRegular.filePdf, color: tokens.mutedText),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(task.file.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodyMedium),
                    Text(_size(task.file.sizeBytes), style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
                  ],
                ),
              ),
              if (task.phase == UploadPhase.uploading)
                IconButton(
                  tooltip: l10n.t('commonCancel'),
                  icon: const Icon(PhosphorIconsRegular.x),
                  onPressed: () => queue.cancel(task.id),
                ),
              if (task.phase == UploadPhase.failed || task.phase == UploadPhase.cancelled) ...<Widget>[
                IconButton(
                  tooltip: l10n.t('commonRetry'),
                  icon: const Icon(PhosphorIconsRegular.arrowClockwise),
                  onPressed: () => queue.retry(task.id),
                ),
                IconButton(
                  tooltip: l10n.t('commonRemove'),
                  icon: const Icon(PhosphorIconsRegular.trash),
                  onPressed: () => queue.remove(task.id),
                ),
              ],
            ],
          ),
          if (task.phase == UploadPhase.uploading)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: LinearProgressIndicator(
                value: task.progress <= 0 ? null : task.progress,
                semanticsLabel: task.file.name,
                semanticsValue: '$percent%',
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(status, style: theme.textTheme.bodySmall?.copyWith(color: ToneColors.of(context, tone).foreground)),
          ),
        ],
      ),
    );
  }
}
