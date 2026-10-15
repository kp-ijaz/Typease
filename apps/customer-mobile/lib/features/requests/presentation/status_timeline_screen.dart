import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../../core/widgets/status_timeline.dart';
import '../application/requests_providers.dart';
import '../data/request_models.dart';
import 'timeline_builder.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Status timeline of a request, as in the brand mock-up: finished steps with
/// a tick and their date, the current step highlighted, later steps greyed.
/// A status that comes from an authority or partner is always shown with the
/// label that says where it came from.
class StatusTimelineScreen extends ConsumerWidget {
  const StatusTimelineScreen({super.key, required this.requestId});

  final String requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final detail = ref.watch(requestDetailProvider(requestId));

    Future<void> refresh() async {
      ref.invalidate(requestDetailProvider(requestId));
      try {
        await ref.read(requestDetailProvider(requestId).future);
      } catch (_) {
        // Shown by the screen.
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('timelineTitle'))),
      body: AsyncValueView<RequestDetail>(
        value: detail,
        onRetry: () => ref.invalidate(requestDetailProvider(requestId)),
        data: (request) {
          final language = l10n.languageCode;
          final theme = Theme.of(context);
          final tokens = BrandTokens.of(context);
          final entries = buildRequestTimeline(request, language);
          final hasExternal = request.externalStatus != null;
          return RefreshableList(
            onRefresh: refresh,
            children: <Widget>[
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(context.pick(request.serviceName, request.serviceNameAr), style: theme.textTheme.titleMedium),
                    const SizedBox(height: 2),
                    Text(
                      request.requestNo,
                      textDirection: TextDirection.ltr,
                      style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                    ),
                    const SizedBox(height: 16),
                    if (entries.isEmpty) Text(l10n.t('timelineEmpty')) else StatusTimeline(entries: entries),
                  ],
                ),
              ),
              if (hasExternal)
                InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.info, message: l10n.t('timelineExternalNote')),
              const SizedBox(height: 12),
              SectionCard(
                child: Column(
                  children: <Widget>[
                    DetailRow(label: l10n.t('requestSubmitted'), value: Dates.date(request.submittedAt, language)),
                    if (!request.isClosed)
                      DetailRow(label: l10n.t('requestEstimatedCompletion'), value: Dates.date(request.targetDate, language)),
                    if (request.completedAt != null)
                      DetailRow(label: l10n.t('requestCompleted'), value: Dates.date(request.completedAt, language)),
                  ],
                ),
              ),
              Text(l10n.t('timelineEstimateNote'), style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
            ],
          );
        },
      ),
    );
  }
}
