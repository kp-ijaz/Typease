import 'package:flutter/material.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/status_badge.dart';
import '../../documents/data/document_models.dart';
import '../data/request_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// One line of the document checklist: what is needed, its state, why a
/// document was rejected, and the actions that are possible now.
class ChecklistTile extends StatelessWidget {
  const ChecklistTile({
    super.key,
    required this.item,
    this.assist,
    this.onUpload,
    this.onReuse,
    this.onView,
    this.busy = false,
  });

  final ChecklistItem item;

  /// Reuse suggestions and hints for this line, when loaded.
  final AssistItem? assist;

  /// Null when the customer cannot upload for this line now.
  final VoidCallback? onUpload;

  /// Called with a document already on file that the customer chose to reuse.
  final ValueChanged<AssistCandidate>? onReuse;

  /// Opens the attached document.
  final VoidCallback? onView;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final document = item.document;
    final note = item.note;
    final upload = onUpload;
    final reuse = onReuse;
    final view = onView;
    final candidates = assist?.candidates ?? const <AssistCandidate>[];
    final canChange = !item.isLocked && upload != null;
    final needsFile = item.isMissing || item.isRejected;

    final Tone tone;
    final IconData icon;
    final String statusLabel;
    switch (item.status) {
      case 'VERIFIED':
        tone = Tone.success;
        icon = PhosphorIconsRegular.checkCircle;
        statusLabel = l10n.t('checklistVerified');
      case 'UPLOADED':
        tone = Tone.info;
        icon = PhosphorIconsRegular.hourglass;
        statusLabel = l10n.t('checklistUploaded');
      case 'REJECTED':
        tone = Tone.danger;
        icon = PhosphorIconsRegular.xCircle;
        statusLabel = l10n.t('checklistRejected');
      case 'WAIVED':
        tone = Tone.neutral;
        icon = PhosphorIconsRegular.minusCircle;
        statusLabel = l10n.t('checklistWaived');
      default:
        tone = item.isMandatory ? Tone.warning : Tone.neutral;
        icon = PhosphorIconsRegular.circle;
        statusLabel = item.isMandatory ? l10n.t('checklistMissing') : l10n.t('checklistMissingOptional');
    }

    String uploadLabel;
    if (item.isRejected) {
      uploadLabel = l10n.t('checklistUploadNew');
    } else if (item.isMissing) {
      uploadLabel = l10n.t('checklistAdd');
    } else {
      uploadLabel = l10n.t('checklistReplace');
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(icon, color: ToneColors.of(context, tone).foreground),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.pick(item.label, item.labelAr), style: theme.textTheme.titleSmall),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: <Widget>[
                        StatusBadge(label: statusLabel, tone: tone),
                        if (item.isInput && !item.isMandatory) StatusBadge(label: l10n.t('commonOptional')),
                      ],
                    ),
                    if (document != null && document.expiryDate != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          l10n.t('checklistExpires', <String, Object?>{'date': Dates.calendarDate(document.expiryDate, l10n.languageCode)}),
                          style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                        ),
                      ),
                    if (item.isRejected && note != null && note.trim().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.chatCenteredText, title: l10n.t('checklistRejectedWhy'), message: note),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (busy)
            const Padding(padding: EdgeInsets.only(top: 8), child: LinearProgressIndicator())
          else
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 34, top: 4),
              child: Wrap(
                spacing: 8,
                children: <Widget>[
                  if (canChange)
                    needsFile
                        ? FilledButton.tonalIcon(onPressed: upload, icon: const Icon(PhosphorIconsRegular.uploadSimple, size: 18), label: Text(uploadLabel))
                        : TextButton.icon(onPressed: upload, icon: const Icon(PhosphorIconsRegular.uploadSimple, size: 18), label: Text(uploadLabel)),
                  if (canChange && needsFile && reuse != null && candidates.isNotEmpty)
                    TextButton.icon(
                      onPressed: () => _chooseCandidate(context, candidates, reuse),
                      icon: const Icon(PhosphorIconsRegular.folderOpen, size: 18),
                      label: Text(l10n.t('checklistReuse')),
                    ),
                  if (document != null && document.isAvailable && view != null)
                    TextButton.icon(
                      onPressed: view,
                      icon: const Icon(PhosphorIconsRegular.eye, size: 18),
                      label: Text(item.isCompletion ? l10n.t('checklistOpen') : l10n.t('checklistView')),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _chooseCandidate(
    BuildContext context,
    List<AssistCandidate> candidates,
    ValueChanged<AssistCandidate> onChosen,
  ) async {
    final l10n = context.l10n;
    final chosen = await showModalBottomSheet<AssistCandidate>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) {
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(l10n.t('checklistReuseTitle'), style: Theme.of(sheetContext).textTheme.titleMedium),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(l10n.t('checklistReuseBody')),
              ),
              for (final candidate in candidates)
                ListTile(
                  leading: const Icon(PhosphorIconsRegular.fileText),
                  title: Text(candidate.title),
                  subtitle: Text(
                    candidate.expiryDate == null
                        ? l10n.tOr('verification_${candidate.verificationStatus}', candidate.verificationStatus)
                        : l10n.t('checklistExpires', <String, Object?>{'date': Dates.calendarDate(candidate.expiryDate, l10n.languageCode)}),
                  ),
                  onTap: () => Navigator.of(sheetContext).pop(candidate),
                ),
            ],
          ),
        );
      },
    );
    if (chosen != null) onChosen(chosen);
  }
}
