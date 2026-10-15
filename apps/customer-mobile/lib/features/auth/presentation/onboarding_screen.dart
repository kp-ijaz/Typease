import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/illustration.dart';
import '../../../core/widgets/primary_button.dart';
import '../../settings/application/settings_controller.dart';
import 'auth_scaffold.dart';

/// Three short pages shown once, on first launch.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final PageController _controller = PageController();
  int _page = 0;

  static const int _pageCount = 3;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _finish() async {
    // The router moves on as soon as the flag is stored.
    await ref.read(settingsControllerProvider.notifier).markOnboardingSeen();
  }

  Future<void> _next() async {
    if (_page >= _pageCount - 1) {
      await _finish();
      return;
    }
    await _controller.nextPage(duration: const Duration(milliseconds: 380), curve: Curves.easeOutCubic);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final pages = <_OnboardingPage>[
      _OnboardingPage(
        icon: PhosphorIconsRegular.handTap,
        satellites: const <IconData>[PhosphorIconsRegular.fileText, PhosphorIconsRegular.identificationCard, PhosphorIconsRegular.airplaneTilt],
        title: l10n.t('onboardingTitle1'),
        body: l10n.t('onboardingBody1'),
      ),
      _OnboardingPage(
        icon: PhosphorIconsRegular.fileArrowUp,
        satellites: const <IconData>[PhosphorIconsRegular.camera, PhosphorIconsRegular.shieldCheck, PhosphorIconsRegular.filePdf],
        title: l10n.t('onboardingTitle2'),
        body: l10n.t('onboardingBody2'),
      ),
      _OnboardingPage(
        icon: PhosphorIconsRegular.path,
        satellites: const <IconData>[PhosphorIconsRegular.bellRinging, PhosphorIconsRegular.checkCircle, PhosphorIconsRegular.creditCard],
        title: l10n.t('onboardingTitle3'),
        body: l10n.t('onboardingBody3'),
      ),
    ];
    final isLast = _page == _pageCount - 1;

    return Scaffold(
      body: Stack(
        children: <Widget>[
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: <Color>[theme.colorScheme.secondary.withValues(alpha: 0.10), theme.scaffoldBackgroundColor],
                  stops: const <double>[0, 0.6],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Column(
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 12, 0),
                  child: Row(
                    children: <Widget>[
                      const TypEaseLogo(height: 30),
                      const Spacer(),
                      const LanguageToggle(),
                      AnimatedOpacity(
                        opacity: isLast ? 0 : 1,
                        duration: const Duration(milliseconds: 200),
                        child: TextButton(
                          key: const Key('onboarding-skip'),
                          onPressed: isLast ? null : _finish,
                          child: Text(l10n.t('onboardingSkip')),
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: PageView(
                    controller: _controller,
                    onPageChanged: (index) => setState(() => _page = index),
                    children: pages,
                  ),
                ),
                Semantics(
                  label: l10n.t('onboardingProgress', <String, Object?>{'current': _page + 1, 'total': _pageCount}),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      for (var i = 0; i < _pageCount; i++)
                        AnimatedContainer(
                          duration: const Duration(milliseconds: 280),
                          curve: Curves.easeOutCubic,
                          width: i == _page ? 28 : 8,
                          height: 8,
                          margin: const EdgeInsets.symmetric(horizontal: 4),
                          decoration: BoxDecoration(
                            color: i == _page ? tokens.brand : tokens.border,
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 28, 24, 20),
                  child: PrimaryButton(
                    key: const Key('onboarding-next'),
                    label: isLast ? l10n.t('onboardingStart') : l10n.t('commonNext'),
                    icon: PhosphorIconsRegular.arrowRight,
                    onPressed: _next,
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

class _OnboardingPage extends StatelessWidget {
  const _OnboardingPage({required this.icon, required this.satellites, required this.title, required this.body});

  final IconData icon;
  final List<IconData> satellites;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              SpotIllustration(icon: icon, satellites: satellites, size: 260),
              const SizedBox(height: 36),
              Semantics(
                header: true,
                child: Text(title, textAlign: TextAlign.center, style: theme.textTheme.headlineMedium),
              ),
              const SizedBox(height: 14),
              Text(body, textAlign: TextAlign.center, style: theme.textTheme.bodyLarge?.copyWith(color: tokens.mutedText)),
            ],
          ),
        ),
      ),
    );
  }
}
