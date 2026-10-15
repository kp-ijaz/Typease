import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/widgets/feedback.dart';
import '../../documents/application/document_providers.dart';
import '../../documents/data/documents_repository.dart';
import '../../documents/data/upload_rules.dart';
import '../data/support_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Lets the customer attach documents to a support message: either documents
/// already in their vault, or a new file (which is uploaded to the vault
/// first, because ticket attachments are document references).
class AttachmentPicker extends ConsumerStatefulWidget {
  const AttachmentPicker({super.key, required this.attachments, required this.onChanged, this.enabled = true});

  final List<TicketAttachment> attachments;
  final ValueChanged<List<TicketAttachment>> onChanged;
  final bool enabled;

  @override
  ConsumerState<AttachmentPicker> createState() => _AttachmentPickerState();
}

class _AttachmentPickerState extends ConsumerState<AttachmentPicker> {
  double? _uploadProgress;

  void _add(TicketAttachment attachment) {
    if (widget.attachments.any((a) => a.documentId == attachment.documentId)) return;
    widget.onChanged(<TicketAttachment>[...widget.attachments, attachment]);
  }

  void _remove(TicketAttachment attachment) {
    widget.onChanged(widget.attachments.where((a) => a.documentId != attachment.documentId).toList());
  }

  Future<void> _chooseExisting() async {
    final l10n = context.l10n;
    final chosen = await showModalBottomSheet<TicketAttachment>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) {
        return Consumer(
          builder: (context, ref, _) {
            final documents = ref.watch(myDocumentsProvider);
            final maxHeight = MediaQuery.of(context).size.height * 0.7;
            return ConstrainedBox(
              constraints: BoxConstraints(maxHeight: maxHeight),
              child: documents.when(
                loading: () => const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
                error: (error, _) => Padding(padding: const EdgeInsets.all(24), child: Text(describeError(l10n, error))),
                data: (items) {
                  final usable = items.where((d) => d.status == 'AVAILABLE').toList();
                  if (usable.isEmpty) {
                    return Padding(padding: const EdgeInsets.all(24), child: Text(l10n.t('attachmentNoDocuments')));
                  }
                  return ListView(
                    shrinkWrap: true,
                    children: <Widget>[
                      for (final document in usable)
                        ListTile(
                          leading: const Icon(PhosphorIconsRegular.fileText),
                          title: Text(document.title),
                          subtitle: document.filename == null ? null : Text(document.filename!),
                          onTap: () => Navigator.of(sheetContext).pop(
                            TicketAttachment(documentId: document.id, title: document.title),
                          ),
                        ),
                    ],
                  );
                },
              ),
            );
          },
        );
      },
    );
    if (chosen != null) _add(chosen);
  }

  Future<void> _uploadNew() async {
    final l10n = context.l10n;
    try {
      final result = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: UploadRules.allowedExtensions);
      if (result == null || result.files.isEmpty || !mounted) return;
      final picked = result.files.first;
      final path = picked.path;
      if (path == null) return;
      final file = await DocumentsRepository.inspect(path: path, name: picked.name);
      if (!mounted) return;
      setState(() => _uploadProgress = 0);
      final summary = await ref.read(documentsRepositoryProvider).upload(
            file: file,
            target: UploadTarget(documentTypeKey: 'other', title: file.name),
            onProgress: (fraction) {
              if (mounted) setState(() => _uploadProgress = fraction);
            },
          );
      ref.invalidate(myDocumentsProvider);
      _add(TicketAttachment(documentId: summary.documentId, title: file.name));
    } on LocalFileRejected catch (rejected) {
      if (!mounted) return;
      showMessage(
        context,
        l10n.t('uploadRejected_${rejected.reason}', <String, Object?>{'name': rejected.name, 'limit': UploadRules.maxBytes ~/ (1024 * 1024)}),
        isError: true,
      );
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _uploadProgress = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final progress = _uploadProgress;
    final busy = progress != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (widget.attachments.isNotEmpty)
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: <Widget>[
              for (final attachment in widget.attachments)
                InputChip(
                  avatar: const Icon(PhosphorIconsRegular.paperclip, size: 16),
                  label: Text(attachment.title, overflow: TextOverflow.ellipsis),
                  onDeleted: widget.enabled ? () => _remove(attachment) : null,
                  deleteButtonTooltipMessage: l10n.t('commonRemove'),
                ),
            ],
          ),
        if (progress != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: LinearProgressIndicator(value: progress <= 0 ? null : progress, semanticsLabel: l10n.t('uploadInProgress')),
          ),
        Wrap(
          spacing: 8,
          children: <Widget>[
            TextButton.icon(
              onPressed: (!widget.enabled || busy) ? null : _chooseExisting,
              icon: const Icon(PhosphorIconsRegular.folderOpen, size: 18),
              label: Text(l10n.t('attachmentFromDocuments')),
            ),
            TextButton.icon(
              onPressed: (!widget.enabled || busy) ? null : _uploadNew,
              icon: const Icon(PhosphorIconsRegular.uploadSimple, size: 18),
              label: Text(l10n.t('attachmentUploadNew')),
            ),
          ],
        ),
      ],
    );
  }
}
