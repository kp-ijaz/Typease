import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/status_badge.dart';
import '../data/catalogue_models.dart';
import 'category_icons.dart';

/// Service category cards: three per row on phones, five on wide screens.
class CategoryGrid extends StatelessWidget {
  const CategoryGrid({super.key, required this.categories, this.limit});

  final List<ServiceCategory> categories;

  /// Show at most this many (Home shows a preview; "See all" opens the catalogue).
  final int? limit;

  @override
  Widget build(BuildContext context) {
    final tokens = BrandTokens.of(context);
    final tints = <ToneColors>[
      ToneColors(tokens.brand, tokens.brand.withValues(alpha: 0.09)),
      ToneColors(tokens.info, tokens.infoContainer),
      ToneColors(tokens.success, tokens.successContainer),
      ToneColors(tokens.warning, tokens.warningContainer),
      ToneColors(tokens.danger, tokens.dangerContainer),
    ];
    final shown = limit == null ? categories : categories.take(limit!).toList();
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 600 ? 5 : 3;
        const spacing = 10.0;
        // Rounded down so that floating-point error can never push a tile to the next row.
        final tileWidth = ((constraints.maxWidth - spacing * (columns - 1)) / columns).floorToDouble();
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: <Widget>[
            for (var i = 0; i < shown.length; i++)
              SizedBox(width: tileWidth, child: _CategoryTile(category: shown[i], colors: tints[i % tints.length])),
          ],
        );
      },
    );
  }
}

class _CategoryTile extends StatelessWidget {
  const _CategoryTile({required this.category, required this.colors});

  final ServiceCategory category;
  final ToneColors colors;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final name = context.pick(category.name, category.nameAr);
    void open() => context.push<void>(Routes.catalogueWith(category: category.key));
    return Semantics(
      button: true,
      label: name,
      excludeSemantics: true,
      onTap: open,
      child: Material(
        color: theme.colorScheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppTheme.radiusLg),
          side: BorderSide(color: tokens.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: open,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 14, 10, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(color: colors.background, borderRadius: BorderRadius.circular(AppTheme.radiusMd)),
                  child: Icon(categoryIcon(category.icon), color: colors.foreground, size: 22),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  height: 36,
                  child: Text(
                    name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelMedium?.copyWith(fontSize: 11.5, fontWeight: FontWeight.w600, height: 1.3),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  context.l10n.t('categoryServiceCount', <String, Object?>{'count': category.serviceCount}),
                  style: theme.textTheme.labelSmall?.copyWith(color: tokens.mutedText, fontWeight: FontWeight.w500),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
