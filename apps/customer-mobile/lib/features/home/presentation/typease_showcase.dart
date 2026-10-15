import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/illustration.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_bar_backdrop.dart';
import '../../auth/presentation/auth_scaffold.dart';
import 'explore_screen.dart' show FeatureList, GuestBar;

/// The guest's home before any centre is chosen, under the TypEase brand:
/// what the app is, the kinds of services typing centres offer, how a request
/// works, public tracking, and the way in (the centre is asked for only when
/// signing in or registering).
class TypEaseShowcase extends StatelessWidget {
  const TypEaseShowcase({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    return Scaffold(
      body: StatusBarBackdrop(
        child: ListView(
          padding: EdgeInsets.zero,
          children: <Widget>[
            const _Hero(),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const _TrackCard(),
                  const SizedBox(height: 28),
                  _Heading(l10n.t('showcaseServicesTitle')),
                  Text(l10n.t('showcaseServicesBody'), style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText)),
                  const SizedBox(height: 14),
                  const _ServiceAreas(),
                  const SizedBox(height: 28),
                  _Heading(l10n.t('showcaseStepsTitle')),
                  const _Steps(),
                  const SizedBox(height: 28),
                  _Heading(l10n.t('exploreFeaturesTitle')),
                  Text(l10n.t('exploreFeaturesBody'), style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText)),
                  const SizedBox(height: 16),
                  const FeatureList(),
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: const GuestBar(canRegister: true),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final promises = <(IconData, String)>[
      (PhosphorIconsFill.lightning, l10n.t('showcasePromiseFast')),
      (PhosphorIconsFill.shieldCheck, l10n.t('showcasePromiseSecure')),
      (PhosphorIconsFill.usersThree, l10n.t('showcasePromiseCentres')),
    ];
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
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 26),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Row(
                    children: <Widget>[
                      TypEaseLogo(height: 34, onDark: true),
                      Spacer(),
                      LanguageToggle(),
                    ],
                  ),
                  const SizedBox(height: 30),
                  Semantics(
                    header: true,
                    child: Text(l10n.t('showcaseHeadline'), style: theme.textTheme.headlineMedium?.copyWith(color: tokens.onBrand)),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    l10n.t('showcaseSubline'),
                    style: theme.textTheme.bodyLarge?.copyWith(color: tokens.onBrand.withValues(alpha: 0.82)),
                  ),
                  const SizedBox(height: 20),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: <Widget>[
                      for (final (icon, label) in promises)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
                          decoration: BoxDecoration(
                            color: tokens.onBrand.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(99),
                            border: Border.all(color: tokens.onBrand.withValues(alpha: 0.18)),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: <Widget>[
                              Icon(icon, size: 14, color: tokens.accent),
                              const SizedBox(width: 6),
                              Text(label, style: theme.textTheme.labelMedium?.copyWith(color: tokens.onBrand)),
                            ],
                          ),
                        ),
                    ],
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

class _TrackCard extends StatelessWidget {
  const _TrackCard();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    return Material(
      color: theme.colorScheme.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppTheme.radiusLg), side: BorderSide(color: tokens.border)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: const Key('showcase-track'),
        onTap: () => context.push<void>(Routes.track),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: <Widget>[
              const SpotIllustration(icon: PhosphorIconsRegular.path, size: 64),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(l10n.t('trackHeadline'), style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(l10n.t('showcaseTrackBody'), style: theme.textTheme.bodySmall),
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

/// The kinds of services typing centres offer. Each centre has its own list
/// and prices, so a tap explains that and offers to sign in.
class _ServiceAreas extends StatelessWidget {
  const _ServiceAreas();

  static const List<(IconData, String)> _areas = <(IconData, String)>[
    (PhosphorIconsRegular.fileText, 'showcaseAreaTyping'),
    (PhosphorIconsRegular.airplaneTilt, 'showcaseAreaVisa'),
    (PhosphorIconsRegular.identificationCard, 'showcaseAreaEid'),
    (PhosphorIconsRegular.briefcase, 'showcaseAreaLabour'),
    (PhosphorIconsRegular.buildings, 'showcaseAreaBusiness'),
    (PhosphorIconsRegular.printer, 'showcaseAreaPrinting'),
  ];

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final tints = <(Color, Color)>[
      (tokens.info, tokens.infoContainer),
      (tokens.success, tokens.successContainer),
      (tokens.brand, tokens.brand.withValues(alpha: 0.08)),
      (tokens.danger, tokens.dangerContainer),
      (tokens.warning, tokens.warningContainer),
      (tokens.info, tokens.infoContainer),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        const spacing = 10.0;
        final width = ((constraints.maxWidth - spacing) / 2).floorToDouble();
        return Wrap(
          spacing: spacing,
          runSpacing: spacing,
          children: <Widget>[
            for (var i = 0; i < _areas.length; i++)
              SizedBox(
                width: width,
                child: Material(
                  color: theme.colorScheme.surface,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppTheme.radiusLg), side: BorderSide(color: tokens.border)),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => _explainCentre(context, l10n.t(_areas[i].$2)),
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(color: tints[i].$2, borderRadius: BorderRadius.circular(AppTheme.radiusMd)),
                            child: Icon(_areas[i].$1, color: tints[i].$1, size: 21),
                          ),
                          const SizedBox(height: 12),
                          FittedBox(
                            fit: BoxFit.scaleDown,
                            alignment: AlignmentDirectional.centerStart,
                            child: Text(l10n.t(_areas[i].$2), maxLines: 1, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            l10n.t('${_areas[i].$2}Hint'),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  void _explainCentre(BuildContext context, String area) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const SpotIllustration(
                icon: PhosphorIconsRegular.storefront,
                satellites: <IconData>[PhosphorIconsRegular.signIn, PhosphorIconsRegular.fileText],
                size: 150,
              ),
              const SizedBox(height: 8),
              Text(area, textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
              const SizedBox(height: 8),
              Text(
                l10n.t('showcaseAreaSheetBody'),
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(color: BrandTokens.of(context).mutedText),
              ),
              const SizedBox(height: 20),
              PrimaryButton(
                label: l10n.t('loginSubmit'),
                icon: PhosphorIconsRegular.arrowRight,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  context.push<void>(Routes.centreFor());
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Steps extends StatelessWidget {
  const _Steps();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final steps = <(IconData, String)>[
      (PhosphorIconsRegular.handTap, 'showcaseStep1'),
      (PhosphorIconsRegular.fileArrowUp, 'showcaseStep2'),
      (PhosphorIconsRegular.creditCard, 'showcaseStep3'),
      (PhosphorIconsRegular.path, 'showcaseStep4'),
      (PhosphorIconsRegular.sealCheck, 'showcaseStep5'),
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(AppTheme.radiusLg),
        border: Border.all(color: tokens.border),
      ),
      child: Column(
        children: <Widget>[
          for (var i = 0; i < steps.length; i++)
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Column(
                    children: <Widget>[
                      Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(gradient: tokens.brandGradient, shape: BoxShape.circle),
                        child: Icon(steps[i].$1, size: 18, color: tokens.onBrand),
                      ),
                      if (i < steps.length - 1)
                        Expanded(child: Container(width: 2, margin: const EdgeInsets.symmetric(vertical: 4), color: tokens.border)),
                    ],
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 18, top: 1),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(l10n.t(steps[i].$2), style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                          const SizedBox(height: 2),
                          Text(l10n.t('${steps[i].$2}Body'), style: theme.textTheme.bodySmall),
                        ],
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

class _Heading extends StatelessWidget {
  const _Heading(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Semantics(header: true, child: Text(title, style: Theme.of(context).textTheme.titleLarge)),
    );
  }
}
