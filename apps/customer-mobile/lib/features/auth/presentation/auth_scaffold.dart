import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/illustration.dart';
import '../../settings/application/settings_controller.dart';
import '../../tenant/application/tenant_controller.dart';

/// Common frame of the signed-out screens: a soft brand-tinted header with
/// the centre's logo (or an illustration), a heading, a short explanation and
/// the form. Scrolls when the keyboard is open and stays narrow on tablets.
class AuthScaffold extends ConsumerWidget {
  const AuthScaffold({
    super.key,
    required this.title,
    required this.children,
    this.subtitle,
    this.showBack = true,
    this.showBrand = true,
    this.eyebrow,
    this.hero,
  });

  final String title;
  final String? subtitle;
  final List<Widget> children;
  final bool showBack;
  final bool showBrand;

  /// Small label above the title ("Welcome back").
  final String? eyebrow;

  /// Shown instead of the logo, e.g. a [SpotIllustration].
  final Widget? hero;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final l10n = context.l10n;
    final tenant = ref.watch(tenantControllerProvider);
    final rewriter = ref.watch(urlRewriterProvider);
    final description = subtitle;
    final logoUrl = tenant?.logoUrl;
    final label = eyebrow;
    final canPop = showBack && context.canPop();

    return Scaffold(
      body: Stack(
        children: <Widget>[
          // Brand wash behind the header.
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 320,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[theme.colorScheme.secondary.withValues(alpha: 0.10), theme.scaffoldBackgroundColor.withValues(alpha: 0)],
                ),
              ),
              child: HeroDecoration(color: theme.colorScheme.secondary),
            ),
          ),
          SafeArea(
            child: Column(
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 12, 0),
                  child: Row(
                    children: <Widget>[
                      if (canPop)
                        IconButton(
                          tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                          onPressed: () => context.pop(),
                          icon: const Icon(PhosphorIconsRegular.arrowLeft),
                        )
                      else
                        const SizedBox(width: 12),
                      const Spacer(),
                      const LanguageToggle(),
                    ],
                  ),
                ),
                Expanded(
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 480),
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(24, 12, 24, 32),
                        children: <Widget>[
                          if (hero != null)
                            Padding(padding: const EdgeInsets.only(bottom: 20), child: Center(child: hero))
                          else if (showBrand)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 28),
                              child: Align(
                                alignment: AlignmentDirectional.centerStart,
                                child: tenant == null
                                    ? const TypEaseLogo(height: 44)
                                    : BrandLogo(
                                  name: tenant.displayName(l10n.languageCode),
                                  logoUrl: logoUrl == null ? null : rewriter.rewrite(logoUrl),
                                  height: 52,
                                ),
                              ),
                            ),
                          if (label != null)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 8),
                              child: Text(
                                label.toUpperCase(),
                                style: theme.textTheme.labelMedium?.copyWith(color: tokens.brand, letterSpacing: 1.2, fontWeight: FontWeight.w800),
                              ),
                            ),
                          Semantics(header: true, child: Text(title, style: theme.textTheme.headlineMedium)),
                          if (description != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 10),
                              child: Text(description, style: theme.textTheme.bodyLarge?.copyWith(color: tokens.mutedText)),
                            ),
                          const SizedBox(height: 28),
                          ...children,
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Switches between English and Arabic from any signed-out screen.
class LanguageToggle extends ConsumerWidget {
  const LanguageToggle({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final current = ref.watch(settingsControllerProvider).languageCode;
    final next = current == 'ar' ? 'en' : 'ar';
    // The button is labelled in the language it switches TO.
    final label = next == 'ar' ? 'العربية' : 'English';
    return Material(
      color: theme.colorScheme.surface,
      shape: StadiumBorder(side: BorderSide(color: tokens.border)),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: () => ref.read(settingsControllerProvider.notifier).setLanguage(next),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(PhosphorIconsRegular.globeHemisphereEast, size: 17, color: tokens.mutedText),
              const SizedBox(width: 6),
              Text(label, style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
            ],
          ),
        ),
      ),
    );
  }
}

/// "────  or  ────" between alternative ways to continue.
class OrDivider extends StatelessWidget {
  const OrDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final tokens = BrandTokens.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Row(
        children: <Widget>[
          Expanded(child: Divider(color: tokens.border)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: tokens.mutedText)),
          ),
          Expanded(child: Divider(color: tokens.border)),
        ],
      ),
    );
  }
}

/// A full-width secondary option with an icon well, e.g. "Browse as a guest".
class OptionTile extends StatelessWidget {
  const OptionTile({super.key, required this.icon, required this.title, required this.onTap, this.subtitle});

  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final detail = subtitle;
    return Material(
      color: theme.colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppTheme.radiusLg),
        side: BorderSide(color: tokens.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: <Widget>[
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: tokens.brand.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(AppTheme.radiusMd),
                ),
                child: Icon(icon, color: tokens.brand, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(title, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    if (detail != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(detail, style: theme.textTheme.bodySmall),
                      ),
                  ],
                ),
              ),
              Icon(PhosphorIconsRegular.caretRight, size: 18, color: tokens.mutedText),
            ],
          ),
        ),
      ),
    );
  }
}
