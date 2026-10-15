import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/money.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/illustration.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_bar_backdrop.dart';
import '../../auth/presentation/auth_scaffold.dart';
import '../../catalogue/application/catalogue_providers.dart';
import '../../catalogue/data/catalogue_models.dart';
import '../../catalogue/presentation/catalogue_screen.dart' show processingTimeLabel;
import '../../catalogue/presentation/category_grid.dart';
import '../../catalogue/presentation/category_icons.dart';
import '../../tenant/application/tenant_controller.dart';
import 'typease_showcase.dart';

/// The guest's home: the centre's showcase without signing in. Shows who the
/// centre is, what it offers (public catalogue, fees as estimates), public
/// request tracking, how to reach it, and what the app does once signed in.
class ExploreScreen extends ConsumerWidget {
  const ExploreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tenant = ref.watch(tenantControllerProvider);
    if (tenant == null) return const TypEaseShowcase();
    final catalogue = ref.watch(catalogueProvider);
    final canRegister = tenant.feature('selfRegistration');

    return Scaffold(
      body: StatusBarBackdrop(
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(catalogueProvider);
            try {
              await ref.read(catalogueProvider.future);
            } catch (_) {
              // Shown in the sections.
            }
          },
          child: CustomScrollView(
            slivers: <Widget>[
              const SliverToBoxAdapter(child: _ExploreHero()),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
                sliver: SliverList.list(
                  children: <Widget>[
                    const _QuickActions(),
                    const SizedBox(height: 28),
                    _Heading(
                      title: l10n.t('exploreCategoriesTitle'),
                      action: l10n.t('homeSeeAll'),
                      onAction: () => context.push<void>(Routes.catalogue),
                    ),
                    AsyncValueView<Catalogue>(
                      value: catalogue,
                      onRetry: () => ref.invalidate(catalogueProvider),
                      loading: const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LoadingView()),
                      data: (data) => data.usedCategories.isEmpty
                          ? Text(l10n.t('homeNoServices'), style: theme.textTheme.bodyMedium)
                          : CategoryGrid(categories: data.usedCategories, limit: 6),
                    ),
                    const SizedBox(height: 28),
                    _Heading(title: l10n.t('explorePopularTitle')),
                  ],
                ),
              ),
              SliverToBoxAdapter(
                child: SizedBox(
                  height: 176,
                  child: catalogue.maybeWhen(
                    data: (data) => ListView.separated(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      itemCount: data.services.length.clamp(0, 8),
                      separatorBuilder: (_, __) => const SizedBox(width: 12),
                      itemBuilder: (context, index) => _ServiceCard(service: data.services[index]),
                    ),
                    orElse: () => const SizedBox.shrink(),
                  ),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(20, 28, 20, 24),
                sliver: SliverList.list(
                  children: <Widget>[
                    _Heading(title: l10n.t('exploreFeaturesTitle')),
                    Text(l10n.t('exploreFeaturesBody'),
                        style: theme.textTheme.bodyMedium?.copyWith(color: BrandTokens.of(context).mutedText)),
                    const SizedBox(height: 16),
                    const FeatureList(),
                    const SizedBox(height: 20),
                    const _ContactCard(),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: GuestBar(canRegister: canRegister),
    );
  }
}

class _ExploreHero extends ConsumerWidget {
  const _ExploreHero();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final tenant = ref.watch(tenantControllerProvider);
    final rewriter = ref.watch(urlRewriterProvider);
    final logoUrl = tenant?.logoUrl;
    final name = tenant?.displayName(l10n.languageCode) ?? l10n.t('appName');
    final tagline = tenant?.tagline;

    return Container(
      decoration: BoxDecoration(
        gradient: tokens.brandGradient,
        borderRadius: const BorderRadius.vertical(bottom: Radius.circular(AppTheme.radiusXl + 4)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: <Widget>[
          Positioned.fill(child: HeroDecoration(color: tokens.onBrand)),
          SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: tokens.onBrand.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: tokens.onBrand.withValues(alpha: 0.22)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            Icon(PhosphorIconsRegular.eye, size: 14, color: tokens.onBrand),
                            const SizedBox(width: 6),
                            Text(
                              l10n.t('exploreGuestBadge'),
                              style: theme.textTheme.labelSmall?.copyWith(color: tokens.onBrand, letterSpacing: 0.4),
                            ),
                          ],
                        ),
                      ),
                      const Spacer(),
                      const LanguageToggle(),
                    ],
                  ),
                  const SizedBox(height: 24),
                  BrandLogoTile(name: name, logoUrl: logoUrl == null ? null : rewriter.rewrite(logoUrl), size: 60),
                  const SizedBox(height: 16),
                  Semantics(
                    header: true,
                    child: Text(name, style: theme.textTheme.headlineMedium?.copyWith(color: tokens.onBrand)),
                  ),
                  if (tagline != null && tagline.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(tagline, style: theme.textTheme.bodyLarge?.copyWith(color: tokens.onBrand.withValues(alpha: 0.86))),
                    ),
                  const SizedBox(height: 22),
                  // Looks like a search field; opens the catalogue with the keyboard.
                  Material(
                    color: theme.colorScheme.surface,
                    borderRadius: BorderRadius.circular(AppTheme.radiusMd + 2),
                    elevation: 0,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(AppTheme.radiusMd + 2),
                      onTap: () => context.push<void>(Routes.catalogue),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                        child: Row(
                          children: <Widget>[
                            Icon(PhosphorIconsRegular.magnifyingGlass, color: tokens.mutedText, size: 20),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                l10n.t('homeSearchHint'),
                                style: theme.textTheme.bodyLarge?.copyWith(color: tokens.mutedText),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _QuickActions extends ConsumerWidget {
  const _QuickActions();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final tenant = ref.watch(tenantControllerProvider);
    final phone = tenant?.supportPhone;
    final email = tenant?.supportEmail;
    return Row(
      children: <Widget>[
        Expanded(
          child: QuickAction(
            icon: PhosphorIconsRegular.squaresFour,
            label: l10n.t('exploreActionServices'),
            onTap: () => context.push<void>(Routes.catalogue),
          ),
        ),
        Expanded(
          child: QuickAction(
            icon: PhosphorIconsRegular.path,
            label: l10n.t('exploreActionTrack'),
            onTap: () => context.push<void>(Routes.track),
          ),
        ),
        Expanded(
          child: QuickAction(
            icon: PhosphorIconsRegular.phoneCall,
            label: l10n.t('exploreActionCall'),
            onTap: phone == null ? null : () => launchUrl(Uri(scheme: 'tel', path: phone)),
          ),
        ),
        Expanded(
          child: QuickAction(
            icon: PhosphorIconsRegular.envelopeSimple,
            label: l10n.t('exploreActionEmail'),
            onTap: email == null ? null : () => launchUrl(Uri(scheme: 'mailto', path: email)),
          ),
        ),
      ],
    );
  }
}

/// A round-cornered icon button with a caption, for rows of shortcuts.
class QuickAction extends StatelessWidget {
  const QuickAction({super.key, required this.icon, required this.label, required this.onTap, this.badge});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final enabled = onTap != null;
    final count = badge;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppTheme.radiusMd),
        onTap: onTap,
        child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              children: <Widget>[
                Badge(
                  isLabelVisible: count != null,
                  label: Text(count ?? ''),
                  child: Container(
                    width: 58,
                    height: 58,
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surface,
                      borderRadius: BorderRadius.circular(AppTheme.radiusLg),
                      border: Border.all(color: tokens.border),
                      boxShadow: AppTheme.softShadow(context, strength: 0.7),
                    ),
                    child: Icon(icon, color: tokens.brand, size: 25),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading({required this.title, this.action, this.onAction});

  final String title;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final label = action;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: <Widget>[
          Expanded(child: Semantics(header: true, child: Text(title, style: Theme.of(context).textTheme.titleLarge))),
          if (label != null && onAction != null)
            TextButton(
                onPressed: onAction, style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)), child: Text(label)),
        ],
      ),
    );
  }
}

class _ServiceCard extends StatelessWidget {
  const _ServiceCard({required this.service});

  final CatalogueService service;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final price = service.price;
    final hours = service.estimatedProcessingHours;
    return SizedBox(
      width: 230,
      child: Material(
        color: theme.colorScheme.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppTheme.radiusLg), side: BorderSide(color: tokens.border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => context.push<void>(Routes.service(service.id)),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Container(
                      width: 38,
                      height: 38,
                      decoration: BoxDecoration(
                          color: tokens.brand.withValues(alpha: 0.09), borderRadius: BorderRadius.circular(AppTheme.radiusSm + 2)),
                      child: Icon(categoryIcon(service.categoryIcon), size: 20, color: tokens.brand),
                    ),
                    const Spacer(),
                    if (hours != null)
                      Row(
                        children: <Widget>[
                          Icon(PhosphorIconsRegular.clock, size: 14, color: tokens.mutedText),
                          const SizedBox(width: 4),
                          Text(processingTimeLabel(context, hours), style: theme.textTheme.labelSmall?.copyWith(color: tokens.mutedText)),
                        ],
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  context.pick(service.name, service.nameAr),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                const Spacer(),
                if (price != null)
                  Text.rich(
                    TextSpan(
                      children: <InlineSpan>[
                        TextSpan(text: '${l10n.t('exploreFrom')} ', style: theme.textTheme.bodySmall),
                        TextSpan(
                          text: Money.format(price.total, price.currency),
                          style: theme.textTheme.titleSmall?.copyWith(color: tokens.brand, fontWeight: FontWeight.w800),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class FeatureList extends StatelessWidget {
  const FeatureList({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final features = <(IconData, String, String)>[
      (PhosphorIconsRegular.handTap, 'exploreFeature1Title', 'exploreFeature1Body'),
      (PhosphorIconsRegular.fileArrowUp, 'exploreFeature2Title', 'exploreFeature2Body'),
      (PhosphorIconsRegular.path, 'exploreFeature3Title', 'exploreFeature3Body'),
      (PhosphorIconsRegular.creditCard, 'exploreFeature4Title', 'exploreFeature4Body'),
      (PhosphorIconsRegular.calendarCheck, 'exploreFeature5Title', 'exploreFeature5Body'),
      (PhosphorIconsRegular.bellRinging, 'exploreFeature6Title', 'exploreFeature6Body'),
    ];
    return Column(
      children: <Widget>[
        for (final (icon, title, body) in features)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: FeatureRow(icon: icon, title: l10n.t(title), body: l10n.t(body)),
          ),
      ],
    );
  }
}

/// An icon well with a title and a line of explanation.
class FeatureRow extends StatelessWidget {
  const FeatureRow({super.key, required this.icon, required this.title, required this.body});

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(AppTheme.radiusLg),
        border: Border.all(color: tokens.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(gradient: tokens.brandGradient, borderRadius: BorderRadius.circular(AppTheme.radiusMd)),
            child: Icon(icon, color: tokens.onBrand, size: 21),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 3),
                Text(body, style: theme.textTheme.bodySmall?.copyWith(height: 1.45)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ContactCard extends ConsumerWidget {
  const _ContactCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final tenant = ref.watch(tenantControllerProvider);
    final phone = tenant?.supportPhone;
    final email = tenant?.supportEmail;
    if (phone == null && email == null) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: tokens.brand.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(AppTheme.radiusLg),
        border: Border.all(color: tokens.brand.withValues(alpha: 0.14)),
      ),
      child: Row(
        children: <Widget>[
          const SpotIllustration(icon: PhosphorIconsRegular.headset, size: 76),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(l10n.t('exploreContactTitle'), style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                if (phone != null)
                  Text(phone, textDirection: TextDirection.ltr, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                if (email != null) Text(email, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class GuestBar extends ConsumerWidget {
  const GuestBar({super.key, required this.canRegister});

  final bool canRegister;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    // Without a centre, both ways in ask for the centre code first.
    final hasCentre = ref.watch(tenantControllerProvider) != null;
    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(top: BorderSide(color: tokens.border)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
          child: Row(
            children: <Widget>[
              if (canRegister) ...<Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => context.push<void>(hasCentre ? Routes.register : Routes.centreFor(register: true)),
                    child: Text(l10n.t('guestCreateAccount')),
                  ),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: FilledButton(
                  key: const Key('explore-sign-in'),
                  onPressed: () => hasCentre ? context.go(Routes.login) : context.push<void>(Routes.centreFor()),
                  child: Text(l10n.t('loginSubmit')),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
