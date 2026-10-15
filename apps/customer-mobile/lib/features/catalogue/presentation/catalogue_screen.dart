import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/money.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/catalogue_providers.dart';
import '../data/catalogue_models.dart';
import 'category_icons.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Service catalogue: search and browse by category. Search is done by the
/// server (`GET /catalogue?q=&categoryKey=`).
class CatalogueScreen extends ConsumerStatefulWidget {
  const CatalogueScreen({super.key, this.initialCategory, this.initialQuery, this.renewalOf});

  final String? initialCategory;
  final String? initialQuery;

  /// Id of a document-expiry reminder when the customer is starting a renewal.
  final String? renewalOf;

  @override
  ConsumerState<CatalogueScreen> createState() => _CatalogueScreenState();
}

class _CatalogueScreenState extends ConsumerState<CatalogueScreen> {
  late final TextEditingController _search;
  String? _category;
  String _query = '';
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _category = widget.initialCategory;
    _query = widget.initialQuery ?? '';
    _search = TextEditingController(text: _query);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _onSearchChanged(String text) {
    // Show or hide the "clear" button at once.
    setState(() {});
    // Wait until the customer pauses typing before asking the server.
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      if (mounted) setState(() => _query = text.trim());
    });
  }

  CatalogueFilter get _filter => CatalogueFilter(categoryKey: _category, query: _query);

  Future<void> _refresh() async {
    ref.invalidate(catalogueProvider);
    ref.invalidate(filteredCatalogueProvider(_filter));
    try {
      await ref.read(filteredCatalogueProvider(_filter).future);
    } catch (_) {
      // Shown by the list.
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    // Categories always come from the unfiltered catalogue so that the chips
    // do not disappear while searching.
    final all = ref.watch(catalogueProvider);
    final filtered = ref.watch(filteredCatalogueProvider(_filter));
    final categories = all.valueOrNull?.usedCategories ?? const <ServiceCategory>[];
    final renewing = widget.renewalOf != null && widget.renewalOf!.isNotEmpty;

    return Scaffold(
      appBar: AppBar(title: Text(renewing ? l10n.t('catalogueRenewalTitle') : l10n.t('catalogueTitle'))),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 10),
            child: TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              onChanged: _onSearchChanged,
              onSubmitted: (text) => setState(() => _query = text.trim()),
              decoration: InputDecoration(
                hintText: l10n.t('catalogueSearchHint'),
                prefixIcon: const Icon(PhosphorIconsRegular.magnifyingGlass),
                suffixIcon: _search.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: l10n.t('commonClear'),
                        icon: const Icon(PhosphorIconsRegular.x),
                        onPressed: () {
                          _debounce?.cancel();
                          _search.clear();
                          setState(() => _query = '');
                        },
                      ),
              ),
            ),
          ),
          if (categories.isNotEmpty)
            SizedBox(
              height: 52,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                children: <Widget>[
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: ChoiceChip(
                      label: Text(l10n.t('catalogueAllCategories')),
                      selected: _category == null,
                      onSelected: (_) => setState(() => _category = null),
                    ),
                  ),
                  for (final category in categories)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: ChoiceChip(
                        avatar: Icon(
                          categoryIcon(category.icon),
                          size: 17,
                          color: _category == category.key ? Theme.of(context).chipTheme.secondaryLabelStyle?.color : null,
                        ),
                        label: Text(context.pick(category.name, category.nameAr)),
                        selected: _category == category.key,
                        onSelected: (_) => setState(() => _category = category.key),
                      ),
                    ),
                ],
              ),
            ),
          if (renewing)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: InfoBanner(icon: PhosphorIconsRegular.arrowsClockwise, message: l10n.t('catalogueRenewalHint')),
            ),
          Expanded(
            child: AsyncValueView<Catalogue>(
              value: filtered,
              onRetry: () => ref.invalidate(filteredCatalogueProvider(_filter)),
              data: (catalogue) {
                final services = catalogue.services;
                if (services.isEmpty) {
                  return RefreshableList(
                    onRefresh: _refresh,
                    children: <Widget>[
                      FillRemainingMessage(
                        child: EmptyStateView(
                          icon: PhosphorIconsRegular.magnifyingGlassMinus,
                          title: l10n.t('catalogueEmptyTitle'),
                          message: _query.isEmpty ? l10n.t('catalogueEmptyBody') : l10n.t('catalogueEmptySearch'),
                        ),
                      ),
                    ],
                  );
                }
                return RefreshableList(
                  onRefresh: _refresh,
                  children: <Widget>[
                    for (final service in services)
                      _ServiceTile(key: ValueKey<String>('service-${service.id}'), service: service, renewalOf: widget.renewalOf),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ServiceTile extends StatelessWidget {
  const _ServiceTile({super.key, required this.service, this.renewalOf});

  final CatalogueService service;
  final String? renewalOf;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final price = service.price;
    final hours = service.estimatedProcessingHours;
    return SectionCard(
      onTap: () => context.push<void>(Routes.service(service.id, renewalOf: renewalOf)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(color: tokens.brand.withValues(alpha: 0.09), borderRadius: BorderRadius.circular(AppTheme.radiusMd)),
            child: Icon(categoryIcon(service.categoryIcon), color: tokens.brand, size: 24),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(context.pick(service.name, service.nameAr), style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(
                  context.pick(service.categoryName, service.categoryNameAr),
                  style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 12,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    if (price != null)
                      Text(
                        // Always labelled as an estimate: the amount to pay is fixed on the quotation.
                        l10n.t('catalogueFromEstimate', <String, Object?>{'amount': Money.format(price.total, price.currency)}),
                        style: theme.textTheme.labelLarge?.copyWith(color: tokens.brand, fontSize: 13.5),
                      ),
                    if (hours != null)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          Icon(PhosphorIconsRegular.clock, size: 14, color: tokens.mutedText),
                          const SizedBox(width: 4),
                          Text(processingTimeLabel(context, hours), style: theme.textTheme.bodySmall),
                        ],
                      ),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Icon(PhosphorIconsRegular.caretRight, size: 18, color: tokens.mutedText),
          ),
        ],
      ),
    );
  }
}

/// "About 4 hours" / "About 2 days" from `estimatedProcessingHours`.
String processingTimeLabel(BuildContext context, int hours) {
  final l10n = context.l10n;
  if (hours < 24) return l10n.t('processingHours', <String, Object?>{'count': hours});
  final days = (hours / 24).ceil();
  return l10n.t('processingDays', <String, Object?>{'count': days});
}
