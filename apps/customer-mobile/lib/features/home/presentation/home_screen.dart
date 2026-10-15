import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/illustration.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_bar_backdrop.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/application/auth_controller.dart';
import '../../catalogue/application/catalogue_providers.dart';
import '../../catalogue/data/catalogue_models.dart';
import '../../catalogue/presentation/category_grid.dart';
import '../../notifications/application/inbox_controller.dart';
import '../../requests/application/requests_providers.dart';
import '../../requests/data/request_models.dart';
import '../../requests/presentation/request_card.dart';
import '../../tenant/application/tenant_controller.dart';
import 'explore_screen.dart' show QuickAction;

/// Home: a brand hero with greeting and service search, shortcuts, what needs
/// the customer's action, request counts, service categories and the active
/// requests.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  Future<void> _refresh() async {
    ref.invalidate(catalogueProvider);
    ref.invalidate(actionRequestsProvider);
    ref.invalidate(activeRequestsProvider);
    ref.invalidate(requestCountsProvider);
    ref.invalidate(unreadCountProvider);
    try {
      await ref.read(activeRequestsProvider.future);
    } catch (_) {
      // The sections show their own error state.
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final catalogue = ref.watch(catalogueProvider);
    final actions = ref.watch(actionRequestsProvider);
    final active = ref.watch(activeRequestsProvider);
    final counts = ref.watch(requestCountsProvider).valueOrNull;

    return Scaffold(
      body: StatusBarBackdrop(
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.zero,
            children: <Widget>[
              const _HomeHero(),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: QuickAction(
                            icon: PhosphorIconsRegular.plusCircle,
                            label: l10n.t('navNew'),
                            onTap: () => context.push<void>(Routes.catalogue),
                          ),
                        ),
                        Expanded(
                          child: QuickAction(
                            icon: PhosphorIconsRegular.calendarDots,
                            label: l10n.t('homeShortcutAppointments'),
                            onTap: () => context.push<void>(Routes.appointments),
                          ),
                        ),
                        Expanded(
                          child: QuickAction(
                            icon: PhosphorIconsRegular.bellRinging,
                            label: l10n.t('homeShortcutReminders'),
                            onTap: () => context.push<void>(Routes.reminders),
                          ),
                        ),
                        Expanded(
                          child: QuickAction(
                            icon: PhosphorIconsRegular.headset,
                            label: l10n.t('homeShortcutSupport'),
                            onTap: () => context.push<void>(Routes.support),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 24),

                    // Things that wait for the customer come first.
                    AsyncValueView<List<RequestSummary>>(
                      value: actions,
                      loading: const SizedBox.shrink(),
                      onRetry: () => ref.invalidate(actionRequestsProvider),
                      data: (items) {
                        if (items.isEmpty) return const SizedBox.shrink();
                        return Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            _SectionHeading(title: l10n.t('homeActionTitle')),
                            for (final request in items) _ActionCard(request: request),
                            const SizedBox(height: 16),
                          ],
                        );
                      },
                    ),

                    if (counts != null) ...<Widget>[
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: _CountTile(
                              value: counts.open,
                              label: l10n.t('homeCountOpen'),
                              icon: PhosphorIconsRegular.clipboardText,
                              tone: Tone.info,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _CountTile(
                              value: counts.needingAction,
                              label: l10n.t('homeCountAction'),
                              icon: PhosphorIconsRegular.warningCircle,
                              tone: Tone.warning,
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _CountTile(
                              value: counts.drafts,
                              label: l10n.t('homeCountDrafts'),
                              icon: PhosphorIconsRegular.notePencil,
                              tone: Tone.neutral,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 28),
                    ],

                    _SectionHeading(
                      title: l10n.t('homeServicesTitle'),
                      actionLabel: l10n.t('homeSeeAll'),
                      onAction: () => context.push<void>(Routes.catalogue),
                    ),
                    AsyncValueView<Catalogue>(
                      value: catalogue,
                      onRetry: () => ref.invalidate(catalogueProvider),
                      loading: const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LoadingView()),
                      data: (data) {
                        final categories = data.usedCategories;
                        if (categories.isEmpty) return SectionCard(child: Text(l10n.t('homeNoServices')));
                        return CategoryGrid(categories: categories, limit: 6);
                      },
                    ),
                    const SizedBox(height: 28),

                    _SectionHeading(
                      title: l10n.t('homeActiveTitle'),
                      actionLabel: l10n.t('homeSeeAll'),
                      onAction: () => context.go(Routes.requests),
                    ),
                    AsyncValueView<List<RequestSummary>>(
                      value: active,
                      onRetry: () => ref.invalidate(activeRequestsProvider),
                      loading: const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LoadingView()),
                      data: (items) {
                        if (items.isEmpty) {
                          return SectionCard(
                            child: Column(
                              children: <Widget>[
                                const SpotIllustration(
                                  icon: PhosphorIconsRegular.clipboardText,
                                  satellites: <IconData>[PhosphorIconsRegular.plus, PhosphorIconsRegular.fileText],
                                  size: 150,
                                ),
                                const SizedBox(height: 8),
                                Text(
                                  l10n.t('homeNoActive'),
                                  textAlign: TextAlign.center,
                                  style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText),
                                ),
                                const SizedBox(height: 16),
                                PrimaryButton(
                                  label: l10n.t('homeStartRequest'),
                                  icon: PhosphorIconsRegular.plus,
                                  onPressed: () => context.push<void>(Routes.catalogue),
                                ),
                              ],
                            ),
                          );
                        }
                        return Column(children: <Widget>[for (final request in items) RequestCard(request: request)]);
                      },
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HomeHero extends ConsumerWidget {
  const _HomeHero();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final tenant = ref.watch(tenantControllerProvider);
    final session = ref.watch(sessionProvider);
    final rewriter = ref.watch(urlRewriterProvider);
    final unread = ref.watch(unreadCountProvider).valueOrNull ?? 0;
    final firstName = session?.user.firstName ?? '';
    final logoUrl = tenant?.logoUrl;
    final name = tenant?.displayName(l10n.languageCode) ?? l10n.t('appName');

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
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      BrandLogoTile(name: name, logoUrl: logoUrl == null ? null : rewriter.rewrite(logoUrl), size: 42),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(color: tokens.onBrand, fontWeight: FontWeight.w700),
                        ),
                      ),
                      _HeroIconButton(
                        tooltip: unread > 0
                            ? l10n.t('homeNotificationsUnread', <String, Object?>{'count': unread})
                            : l10n.t('homeNotifications'),
                        icon: PhosphorIconsRegular.bell,
                        badge: unread > 0 ? (unread > 99 ? '99+' : '$unread') : null,
                        onTap: () => context.push<void>(Routes.notifications),
                      ),
                    ],
                  ),
                  const SizedBox(height: 26),
                  Text(
                    firstName.isEmpty ? l10n.t('homeGreetingPlain') : l10n.t('homeGreeting', <String, Object?>{'name': firstName}),
                    style: theme.textTheme.bodyLarge?.copyWith(color: tokens.onBrand.withValues(alpha: 0.85)),
                  ),
                  const SizedBox(height: 4),
                  Semantics(
                    header: true,
                    child: Text(l10n.t('homeQuestion'), style: theme.textTheme.headlineSmall?.copyWith(color: tokens.onBrand)),
                  ),
                  const SizedBox(height: 18),
                  Material(
                    color: theme.colorScheme.surface,
                    borderRadius: BorderRadius.circular(AppTheme.radiusMd + 2),
                    child: InkWell(
                      key: const Key('home-search'),
                      borderRadius: BorderRadius.circular(AppTheme.radiusMd + 2),
                      onTap: () => context.push<void>(Routes.catalogue),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                        child: Row(
                          children: <Widget>[
                            Icon(PhosphorIconsRegular.magnifyingGlass, color: tokens.mutedText, size: 20),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(l10n.t('homeSearchHint'), style: theme.textTheme.bodyLarge?.copyWith(color: tokens.mutedText)),
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

class _HeroIconButton extends StatelessWidget {
  const _HeroIconButton({required this.icon, required this.tooltip, required this.onTap, this.badge});

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    final tokens = BrandTokens.of(context);
    final count = badge;
    return Tooltip(
      message: tooltip,
      child: Material(
        color: tokens.onBrand.withValues(alpha: 0.14),
        shape: CircleBorder(side: BorderSide(color: tokens.onBrand.withValues(alpha: 0.2))),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox.square(
            dimension: 44,
            child: Center(
              child: Badge(
                isLabelVisible: count != null,
                label: Text(count ?? ''),
                child: Icon(icon, color: tokens.onBrand, size: 22),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({required this.title, this.actionLabel, this.onAction});

  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final label = actionLabel;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Semantics(header: true, child: Text(title, style: Theme.of(context).textTheme.titleLarge)),
          ),
          if (label != null && onAction != null)
            TextButton(
                onPressed: onAction, style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)), child: Text(label)),
        ],
      ),
    );
  }
}

/// A request that waits for the customer, with the action spelled out.
class _ActionCard extends StatelessWidget {
  const _ActionCard({required this.request});

  final RequestSummary request;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final String action;
    final IconData icon;
    if (request.status == 'QUOTED') {
      action = l10n.t('homeActionQuotation');
      icon = PhosphorIconsRegular.invoice;
    } else if (request.status == 'AWAITING_PAYMENT') {
      action = l10n.t('homeActionPayment');
      icon = PhosphorIconsRegular.creditCard;
    } else {
      action = l10n.t('homeActionInformation');
      icon = PhosphorIconsRegular.fileArrowUp;
    }
    final serviceName = context.pick(request.serviceName, request.serviceNameAr);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InfoBanner(
        tone: Tone.warning,
        icon: icon,
        title: action,
        message: '$serviceName · ${request.requestNo}',
        action: OutlinedButton(
          onPressed: () => context.push<void>(Routes.request(request.id)),
          child: Text(l10n.t('homeActionOpen')),
        ),
      ),
    );
  }
}

class _CountTile extends StatelessWidget {
  const _CountTile({required this.value, required this.label, required this.icon, required this.tone});

  final int value;
  final String label;
  final IconData icon;
  final Tone tone;

  @override
  Widget build(BuildContext context) {
    final colors = ToneColors.of(context, tone);
    final theme = Theme.of(context);
    return Semantics(
      label: '$label: $value',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(AppTheme.radiusLg),
          border: Border.all(color: BrandTokens.of(context).border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(color: colors.background, borderRadius: BorderRadius.circular(AppTheme.radiusSm)),
              child: Icon(icon, size: 17, color: colors.foreground),
            ),
            const SizedBox(height: 10),
            Text('$value', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800, height: 1.1)),
            const SizedBox(height: 2),
            SizedBox(
              height: 30,
              child: Text(label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(color: BrandTokens.of(context).mutedText, height: 1.25)),
            ),
          ],
        ),
      ),
    );
  }
}
