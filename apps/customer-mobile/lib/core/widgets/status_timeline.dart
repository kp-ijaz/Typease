import 'package:flutter/material.dart';

import '../theme/brand_tokens.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

enum TimelineState { done, current, upcoming }

class TimelineEntry {
  const TimelineEntry({
    required this.title,
    required this.state,
    this.subtitle,
    this.caption,
    this.sourceLabel,
  });

  final String title;
  final TimelineState state;

  /// Usually the date and time.
  final String? subtitle;

  /// An extra message, e.g. what the centre asked for.
  final String? caption;

  /// Where a status came from. Set for statuses of an outside party so that a
  /// status typed by staff is never mistaken for an official confirmation.
  final String? sourceLabel;
}

/// Vertical status timeline (as in the brand mock-up: filled ticks for
/// finished steps, a highlighted dot for the current one, hollow dots for
/// what is still to come). Works in both text directions because it only uses
/// start / end aligned layout.
class StatusTimeline extends StatelessWidget {
  const StatusTimeline({super.key, required this.entries});

  final List<TimelineEntry> entries;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        for (var i = 0; i < entries.length; i++)
          _TimelineRow(entry: entries[i], isFirst: i == 0, isLast: i == entries.length - 1),
      ],
    );
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.entry, required this.isFirst, required this.isLast});

  final TimelineEntry entry;
  final bool isFirst;
  final bool isLast;

  Widget _buildDot(ColorScheme scheme, BrandTokens tokens) {
    if (entry.state == TimelineState.done) {
      return Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(color: tokens.success, shape: BoxShape.circle),
        child: Icon(PhosphorIconsBold.check, size: 14, color: scheme.surface),
      );
    }
    if (entry.state == TimelineState.current) {
      return Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          color: scheme.surface,
          shape: BoxShape.circle,
          border: Border.all(color: scheme.secondary, width: 6),
        ),
      );
    }
    return Container(
      width: 22,
      height: 22,
      decoration: BoxDecoration(
        color: scheme.surface,
        shape: BoxShape.circle,
        border: Border.all(color: tokens.mutedText, width: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final scheme = theme.colorScheme;

    final Widget dot = _buildDot(scheme, tokens);

    final muted = entry.state == TimelineState.upcoming;
    final titleStyle = theme.textTheme.titleSmall?.copyWith(color: muted ? tokens.mutedText : scheme.onSurface);
    final subtitle = entry.subtitle;
    final caption = entry.caption;
    final source = entry.sourceLabel;

    final semantics = StringBuffer(entry.title);
    if (subtitle != null) semantics.write(', $subtitle');
    if (source != null) semantics.write(', $source');

    return Semantics(
      container: true,
      label: semantics.toString(),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            SizedBox(
              width: 32,
              child: Column(
                children: <Widget>[
                  Container(width: 2, height: 4, color: isFirst ? Colors.transparent : tokens.border),
                  dot,
                  Expanded(child: Container(width: 2, color: isLast ? Colors.transparent : tokens.border)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 4, bottom: 16),
                child: ExcludeSemantics(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(entry.title, style: titleStyle),
                      if (subtitle != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(subtitle, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
                        ),
                      if (source != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Icon(PhosphorIconsRegular.info, size: 14, color: tokens.warning),
                              const SizedBox(width: 4),
                              Expanded(
                                child: Text(source, style: theme.textTheme.bodySmall?.copyWith(color: tokens.warning)),
                              ),
                            ],
                          ),
                        ),
                      if (caption != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(caption, style: theme.textTheme.bodyMedium),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
