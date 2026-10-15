import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../documents/presentation/document_actions.dart';
import '../../profile/application/profile_providers.dart';
import '../../profile/data/profile_models.dart';
import '../../profile/data/profile_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Privacy: ask the centre for a copy of the personal data it holds, for a
/// correction, or for deletion, and follow those requests.
///
/// The app only files and shows the request. What the centre has to do, and
/// by when, is decided by the centre under the law that applies to it.
class PrivacyScreen extends ConsumerStatefulWidget {
  const PrivacyScreen({super.key});

  @override
  ConsumerState<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends ConsumerState<PrivacyScreen> {
  bool _busy = false;

  Future<void> _refresh() async {
    ref.invalidate(privacyRequestsProvider);
    try {
      await ref.read(privacyRequestsProvider.future);
    } catch (_) {
      // Shown by the list.
    }
  }

  Future<void> _file(String type) async {
    if (_busy) return;
    final l10n = context.l10n;
    String? details;
    if (type == 'EXPORT') {
      final confirmed = await showConfirmDialog(
        context,
        title: l10n.t('privacyExportTitle'),
        message: l10n.t('privacyExportBody'),
        confirmLabel: l10n.t('privacySendRequest'),
      );
      if (!confirmed) return;
    } else {
      details = await showTextInputDialog(
        context,
        title: type == 'DELETION' ? l10n.t('privacyDeletionTitle') : l10n.t('privacyCorrectionTitle'),
        message: type == 'DELETION' ? l10n.t('privacyDeletionBody') : l10n.t('privacyCorrectionBody'),
        fieldLabel: type == 'DELETION' ? l10n.t('privacyDeletionReason') : l10n.t('privacyCorrectionDetails'),
        confirmLabel: l10n.t('privacySendRequest'),
        minLength: type == 'CORRECTION' ? 5 : 0,
        maxLength: 2000,
        destructive: type == 'DELETION',
      );
      if (details == null) return;
    }
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(profileRepositoryProvider).createPrivacyRequest(type: type, details: details);
      ref.invalidate(privacyRequestsProvider);
      if (mounted) showMessage(context, l10n.t('privacyRequestSent'));
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'REQUEST_ALREADY_OPEN') {
        showMessage(context, error.message.isNotEmpty ? error.message : l10n.t('privacyAlreadyOpen'), isError: true);
      } else {
        showError(context, error);
      }
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
    final requests = ref.watch(privacyRequestsProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('privacyTitle'))),
      body: RefreshableList(
        onRefresh: _refresh,
        children: <Widget>[
          Text(l10n.t('privacyIntro')),
          const SizedBox(height: 12),
          SectionCard(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              children: <Widget>[
                ListTile(
                  leading: const Icon(PhosphorIconsRegular.downloadSimple),
                  title: Text(l10n.t('privacyExportAction')),
                  subtitle: Text(l10n.t('privacyExportHelp')),
                  enabled: !_busy,
                  onTap: () => _file('EXPORT'),
                ),
                const Divider(indent: 16, endIndent: 16),
                ListTile(
                  leading: const Icon(PhosphorIconsRegular.notePencil),
                  title: Text(l10n.t('privacyCorrectionAction')),
                  subtitle: Text(l10n.t('privacyCorrectionHelp')),
                  enabled: !_busy,
                  onTap: () => _file('CORRECTION'),
                ),
                const Divider(indent: 16, endIndent: 16),
                ListTile(
                  leading: Icon(PhosphorIconsRegular.trash, color: theme.colorScheme.error),
                  title: Text(l10n.t('privacyDeletionAction'), style: TextStyle(color: theme.colorScheme.error)),
                  subtitle: Text(l10n.t('privacyDeletionHelp')),
                  enabled: !_busy,
                  onTap: () => _file('DELETION'),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 8),
            child: Semantics(header: true, child: Text(l10n.t('privacyMyRequests'), style: theme.textTheme.titleMedium)),
          ),
          AsyncValueView<List<PrivacyRequest>>(
            value: requests,
            onRetry: () => ref.invalidate(privacyRequestsProvider),
            loading: const Padding(padding: EdgeInsets.all(24), child: LoadingView()),
            data: (items) {
              if (items.isEmpty) {
                return SectionCard(child: Text(l10n.t('privacyNoRequests'), style: theme.textTheme.bodyMedium));
              }
              return Column(
                children: <Widget>[
                  for (final request in items)
                    SectionCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Row(
                            children: <Widget>[
                              Expanded(
                                child: Text(l10n.tOr('privacyType_${request.type}', request.type), style: theme.textTheme.titleSmall),
                              ),
                              StatusBadge(
                                label: l10n.tOr('privacyStatus_${request.status}', request.status),
                                tone: request.status == 'COMPLETED'
                                    ? Tone.success
                                    : (request.status == 'REJECTED' ? Tone.danger : Tone.info),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            l10n.t('privacyFiledOn', <String, Object?>{'date': Dates.date(request.createdAt, l10n.languageCode)}),
                            style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                          ),
                          if (request.decisionNote != null && request.decisionNote!.trim().isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: InfoBanner(tone: Tone.neutral, title: l10n.t('privacyCentreAnswer'), message: request.decisionNote!),
                            ),
                          if (request.retentionException != null && request.retentionException!.trim().isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: InfoBanner(tone: Tone.warning, title: l10n.t('privacyNotYetPossible'), message: request.retentionException!),
                            ),
                          if (request.exportDocumentId != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: FilledButton.icon(
                                onPressed: () => openDocument(context, ref, request.exportDocumentId!, download: true),
                                icon: const Icon(PhosphorIconsRegular.downloadSimple),
                                label: Text(l10n.t('privacyDownloadExport')),
                              ),
                            ),
                        ],
                      ),
                    ),
                ],
              );
            },
          ),
          Text(l10n.t('privacyLegalNote'), style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
        ],
      ),
    );
  }
}
