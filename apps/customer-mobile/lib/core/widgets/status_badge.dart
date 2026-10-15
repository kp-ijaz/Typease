import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/brand_tokens.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// The five tones the API uses for request statuses (`tone` field).
enum Tone { neutral, info, warning, success, danger }

Tone toneFromString(String? value) {
  switch (value) {
    case 'info':
      return Tone.info;
    case 'warning':
      return Tone.warning;
    case 'success':
      return Tone.success;
    case 'danger':
      return Tone.danger;
    default:
      return Tone.neutral;
  }
}

class ToneColors {
  const ToneColors(this.foreground, this.background);

  final Color foreground;
  final Color background;

  static ToneColors of(BuildContext context, Tone tone) {
    final tokens = BrandTokens.of(context);
    switch (tone) {
      case Tone.info:
        return ToneColors(tokens.info, tokens.infoContainer);
      case Tone.warning:
        return ToneColors(tokens.warning, tokens.warningContainer);
      case Tone.success:
        return ToneColors(tokens.success, tokens.successContainer);
      case Tone.danger:
        return ToneColors(tokens.danger, tokens.dangerContainer);
      case Tone.neutral:
        return ToneColors(tokens.neutral, tokens.neutralContainer);
    }
  }
}

/// A small coloured label. The status is always written out; colour alone
/// never carries the meaning.
class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.label, this.tone = Tone.neutral, this.icon});

  final String label;
  final Tone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final colors = ToneColors.of(context, tone);
    final leading = icon;
    return Semantics(
      label: label,
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: colors.background,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: colors.foreground.withValues(alpha: 0.14)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (leading != null) ...<Widget>[
              Icon(leading, size: 14, color: colors.foreground),
              const SizedBox(width: 5),
            ] else ...<Widget>[
              Container(width: 6, height: 6, decoration: BoxDecoration(color: colors.foreground, shape: BoxShape.circle)),
              const SizedBox(width: 6),
            ],
            Flexible(
              child: Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(color: colors.foreground, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A tinted note: what happens next, a warning, an explanation.
class InfoBanner extends StatelessWidget {
  const InfoBanner({super.key, required this.message, this.tone = Tone.info, this.icon, this.title, this.action});

  final String message;
  final String? title;
  final Tone tone;
  final IconData? icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final colors = ToneColors.of(context, tone);
    final theme = Theme.of(context);
    final heading = title;
    final trailing = action;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: colors.background,
        borderRadius: BorderRadius.circular(AppTheme.radiusMd + 2),
        border: Border.all(color: colors.foreground.withValues(alpha: 0.12)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: colors.foreground.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(AppTheme.radiusSm),
            ),
            child: Icon(icon ?? PhosphorIconsRegular.info, color: colors.foreground, size: 19),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (heading != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2, top: 1),
                    child: Text(heading, style: theme.textTheme.titleSmall?.copyWith(color: colors.foreground, fontWeight: FontWeight.w700)),
                  ),
                Padding(
                  padding: EdgeInsets.only(top: heading == null ? 7 : 0),
                  child: Text(message, style: theme.textTheme.bodyMedium?.copyWith(height: 1.45)),
                ),
                if (trailing != null) Padding(padding: const EdgeInsets.only(top: 10), child: trailing),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
