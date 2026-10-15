import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/illustration.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/bootstrap.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Shown while the centre configuration and the session are restored.
/// If the server cannot be reached it explains why and offers "Try again".
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final boot = ref.watch(bootstrapProvider);
    final tenant = ref.watch(tenantControllerProvider);
    final rewriter = ref.watch(urlRewriterProvider);
    final logoUrl = tenant?.logoUrl;

    final Widget status;
    if (boot.hasError && !boot.isLoading) {
      status = Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(PhosphorIconsRegular.cloudSlash, size: 40, color: tokens.onBrand),
          const SizedBox(height: 12),
          Text(
            describeError(l10n, boot.error!),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyLarge?.copyWith(color: tokens.onBrand),
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: () => ref.invalidate(bootstrapProvider),
            icon: const Icon(PhosphorIconsRegular.arrowClockwise),
            label: Text(l10n.t('commonRetry')),
          ),
        ],
      );
    } else {
      status = Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          CircularProgressIndicator(color: tokens.onBrand, semanticsLabel: l10n.t('splashLoading')),
          const SizedBox(height: 16),
          Text(l10n.t('splashLoading'), style: theme.textTheme.bodyMedium?.copyWith(color: tokens.onBrand)),
        ],
      );
    }

    return Scaffold(
      backgroundColor: tokens.brand,
      body: DecoratedBox(
        decoration: BoxDecoration(gradient: tokens.brandGradient),
        child: Stack(
          children: <Widget>[
            Positioned.fill(child: HeroDecoration(color: tokens.onBrand)),
            SafeArea(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      if (tenant == null)
                        const TypEaseLogo(height: 60, onDark: true)
                      else
                        BrandLogo(
                          name: tenant.displayName(l10n.languageCode),
                          logoUrl: logoUrl == null ? null : rewriter.rewrite(logoUrl),
                          height: 72,
                          onBrand: true,
                        ),
                      if (tenant == null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(l10n.t('appTagline'), style: theme.textTheme.bodyMedium?.copyWith(color: tokens.onBrand)),
                        ),
                      const SizedBox(height: 40),
                      status,
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

/// A release build that was made without `API_BASE_URL`. This is a build
/// mistake, not something the user can fix, so the screen says so plainly.
class ConfigErrorScreen extends StatelessWidget {
  const ConfigErrorScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(PhosphorIconsRegular.wrench, size: 56, color: theme.colorScheme.error),
                const SizedBox(height: 16),
                Text(l10n.t('configErrorTitle'), textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
                const SizedBox(height: 8),
                Text(l10n.t('configErrorBody'), textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
