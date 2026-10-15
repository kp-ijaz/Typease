import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/status_badge.dart';
import '../data/request_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// One request in a list: number, service, status and - when an outside
/// party reported a status - that status WITH its source.
class RequestCard extends StatelessWidget {
  const RequestCard({super.key, required this.request});

  final RequestSummary request;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final external = request.externalStatus;
    final serviceName = context.pick(request.serviceName, request.serviceNameAr);
    final when = request.isDraft
        ? l10n.t('requestStartedOn', <String, Object?>{'date': Dates.date(request.createdAt, l10n.languageCode)})
        : l10n.t('requestUpdatedOn', <String, Object?>{'date': Dates.date(request.updatedAt ?? request.submittedAt, l10n.languageCode)});

    return SectionCard(
      onTap: () {
        // A draft opens where the customer left off; everything else opens the case.
        context.push<void>(request.isDraft ? Routes.requestWizard(request.id) : Routes.request(request.id));
      },
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
                    Text(serviceName, style: theme.textTheme.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    Text(
                      request.requestNo,
                      textDirection: TextDirection.ltr,
                      style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Icon(PhosphorIconsRegular.caretRight, color: tokens.mutedText),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              StatusBadge(label: context.label(request.statusLabel), tone: toneFromString(request.tone)),
              if (request.overdue) StatusBadge(label: l10n.t('requestOverdue'), tone: Tone.warning, icon: PhosphorIconsRegular.clock),
            ],
          ),
          if (external != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: ExternalStatusLine(status: external),
            ),
          const SizedBox(height: 8),
          Text(when, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
        ],
      ),
    );
  }
}

/// A status reported by an authority or partner. The source label is part of
/// the widget and cannot be left out: a status typed by staff must never look
/// like an official confirmation.
class ExternalStatusLine extends StatelessWidget {
  const ExternalStatusLine({super.key, required this.status});

  final ExternalStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final color = status.isVerifiedOfficial ? tokens.success : tokens.warning;
    final source = context.label(status.sourceLabel);
    return Semantics(
      label: '${status.status}. $source',
      excludeSemantics: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(status.status, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 2),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(status.isVerifiedOfficial ? PhosphorIconsRegular.sealCheck : PhosphorIconsRegular.info, size: 14, color: color),
              const SizedBox(width: 4),
              Expanded(child: Text(source, style: theme.textTheme.bodySmall?.copyWith(color: color))),
            ],
          ),
        ],
      ),
    );
  }
}
