import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Bottom navigation of the signed-in app, as in the brand mock-up:
/// Home, My requests, New request (+), Payments, Profile.
class HomeShell extends StatelessWidget {
  const HomeShell({super.key, required this.location, required this.child});

  /// The current route path, used to highlight the right tab.
  final String location;
  final Widget child;

  int get _selectedIndex {
    if (location.startsWith(Routes.requests)) return 1;
    if (location.startsWith(Routes.payments)) return 3;
    if (location.startsWith(Routes.profile)) return 4;
    return 0;
  }

  void _onSelected(BuildContext context, int index) {
    switch (index) {
      case 0:
        context.go(Routes.home);
      case 1:
        context.go(Routes.requests);
      case 2:
        // Not a tab: starting a request opens the catalogue on top.
        context.push<void>(Routes.catalogue);
      case 3:
        context.go(Routes.payments);
      case 4:
        context.go(Routes.profile);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final tokens = BrandTokens.of(context);
    return Scaffold(
      body: child,
      bottomNavigationBar: DecoratedBox(
        decoration: BoxDecoration(border: Border(top: BorderSide(color: tokens.border))),
        child: NavigationBar(
          selectedIndex: _selectedIndex,
          onDestinationSelected: (index) => _onSelected(context, index),
          destinations: <Widget>[
            NavigationDestination(
              key: const Key('nav-home'),
              icon: const Icon(PhosphorIconsRegular.house),
              selectedIcon: const Icon(PhosphorIconsFill.house),
              label: l10n.t('navHome'),
            ),
            NavigationDestination(
              key: const Key('nav-requests'),
              icon: const Icon(PhosphorIconsRegular.clipboardText),
              selectedIcon: const Icon(PhosphorIconsFill.clipboardText),
              label: l10n.t('navRequests'),
            ),
            NavigationDestination(
              key: const Key('nav-new'),
              icon: Container(
                width: 48,
                height: 40,
                decoration: BoxDecoration(
                  gradient: tokens.brandGradient,
                  borderRadius: BorderRadius.circular(AppTheme.radiusMd),
                  boxShadow: <BoxShadow>[
                    BoxShadow(color: tokens.brand.withValues(alpha: 0.35), blurRadius: 12, offset: const Offset(0, 5)),
                  ],
                ),
                child: Icon(PhosphorIconsBold.plus, color: tokens.onBrand, size: 22),
              ),
              label: l10n.t('navNew'),
              tooltip: l10n.t('navNewTooltip'),
            ),
            NavigationDestination(
              key: const Key('nav-payments'),
              icon: const Icon(PhosphorIconsRegular.receipt),
              selectedIcon: const Icon(PhosphorIconsFill.receipt),
              label: l10n.t('navPayments'),
            ),
            NavigationDestination(
              key: const Key('nav-profile'),
              icon: const Icon(PhosphorIconsRegular.userCircle),
              selectedIcon: const Icon(PhosphorIconsFill.userCircle),
              label: l10n.t('navProfile'),
            ),
          ],
        ),
      ),
    );
  }
}
