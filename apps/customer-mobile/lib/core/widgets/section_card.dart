import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/brand_tokens.dart';

/// White rounded panel with an optional heading. Used for every content block
/// so that screens look alike.
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.child, this.title, this.trailing, this.padding, this.onTap});

  final Widget child;
  final String? title;
  final Widget? trailing;
  final EdgeInsetsGeometry? padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final heading = title;
    final action = trailing;
    final content = Padding(
      padding: padding ?? const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (heading != null || action != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: heading == null
                        ? const SizedBox.shrink()
                        : Semantics(header: true, child: Text(heading, style: theme.textTheme.titleMedium)),
                  ),
                  if (action != null) action,
                ],
              ),
            ),
          child,
        ],
      ),
    );
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppTheme.radiusLg),
      side: BorderSide(color: tokens.border),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: theme.colorScheme.surface,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: onTap == null ? content : InkWell(onTap: onTap, child: content),
      ),
    );
  }
}

/// "Label ........ value" row for detail panels.
class DetailRow extends StatelessWidget {
  const DetailRow({super.key, required this.label, required this.value, this.emphasise = false});

  final String label;
  final String value;
  final bool emphasise;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final valueStyle = emphasise ? theme.textTheme.titleMedium : theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(flex: 4, child: Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText))),
          const SizedBox(width: 12),
          Expanded(flex: 5, child: Text(value, textAlign: TextAlign.end, style: valueStyle)),
        ],
      ),
    );
  }
}
