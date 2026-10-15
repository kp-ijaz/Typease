import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/l10n/app_localizations.dart';
import 'core/routing/app_router.dart';
import 'core/routing/deep_link_controller.dart';
import 'core/routing/deep_links.dart';
import 'core/routing/redirect_logic.dart';
import 'core/routing/routes.dart';
import 'core/theme/app_theme.dart';
import 'core/widgets/feedback.dart';
import 'features/auth/application/auth_controller.dart';
import 'features/auth/application/bootstrap.dart';
import 'features/auth/data/auth_repository.dart';
import 'features/finance/presentation/finance_actions.dart';
import 'features/notifications/application/push_controller.dart';
import 'features/settings/application/settings_controller.dart';
import 'features/tenant/application/tenant_controller.dart';

/// Root widget: theme and name from the selected centre, language and theme
/// mode from the device preferences, and handling of incoming links.
class TypEaseApp extends ConsumerStatefulWidget {
  const TypEaseApp({super.key, this.listenForLinks = true});

  /// False in tests, where the platform link plugin is not available.
  final bool listenForLinks;

  @override
  ConsumerState<TypEaseApp> createState() => _TypEaseAppState();
}

class _TypEaseAppState extends ConsumerState<TypEaseApp> {
  final GlobalKey<ScaffoldMessengerState> _messengerKey = GlobalKey<ScaffoldMessengerState>();
  StreamSubscription<Uri>? _linkSubscription;
  String? _lastLink;
  DateTime? _lastLinkAt;
  bool _processingLink = false;

  // Themes are rebuilt only when the centre's colours change.
  String? _themeKey;
  ThemeData? _lightTheme;
  ThemeData? _darkTheme;

  @override
  void initState() {
    super.initState();
    if (widget.listenForLinks) _listenForLinks();
  }

  @override
  void dispose() {
    _linkSubscription?.cancel();
    super.dispose();
  }

  void _listenForLinks() {
    try {
      final appLinks = AppLinks();
      _linkSubscription = appLinks.uriLinkStream.listen(_onLink, onError: (Object _) {});
      // The link that started the app (some platforms also deliver it on the
      // stream; duplicates are filtered in _onLink).
      unawaited(_readInitialLink(appLinks));
    } catch (_) {
      // Links are optional; the app works without them.
    }
  }

  Future<void> _readInitialLink(AppLinks appLinks) async {
    try {
      final uri = await appLinks.getInitialLink();
      if (uri != null) _onLink(uri);
    } catch (_) {
      // No initial link.
    }
  }

  void _onLink(Uri uri) {
    if (!mounted) return;
    final text = uri.toString();
    final now = DateTime.now();
    final previousAt = _lastLinkAt;
    if (text == _lastLink && previousAt != null && now.difference(previousAt) < const Duration(seconds: 3)) return;
    _lastLink = text;
    _lastLinkAt = now;
    ref.read(deepLinkControllerProvider.notifier).handleUri(uri);
  }

  AppLocalizations? get _l10n {
    final context = _messengerKey.currentContext;
    if (context == null) return null;
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  void _notify(String key, {bool isError = false}) {
    final l10n = _l10n;
    final messenger = _messengerKey.currentState;
    if (l10n == null || messenger == null) return;
    messenger.showSnackBar(SnackBar(content: Text(l10n.t(key)), duration: Duration(seconds: isError ? 6 : 4)));
  }

  void _notifyError(Object error) {
    final l10n = _l10n;
    final messenger = _messengerKey.currentState;
    if (l10n == null || messenger == null) return;
    messenger.showSnackBar(SnackBar(content: Text(describeError(l10n, error)), duration: const Duration(seconds: 6)));
  }

  /// Acts on the pending link as soon as the app is in a state where that is
  /// possible. Called whenever the link or the app gate changes.
  Future<void> _processPendingLink() async {
    if (_processingLink || !mounted) return;
    final target = ref.read(deepLinkControllerProvider);
    if (target == null) return;
    final gate = ref.read(appGateProvider);
    if (gate == AppGate.configError || gate == AppGate.booting || gate == AppGate.bootError || gate == AppGate.needsOnboarding) {
      return; // Tried again when the gate changes.
    }

    _processingLink = true;
    final links = ref.read(deepLinkControllerProvider.notifier);
    try {
      final tenants = ref.read(tenantControllerProvider.notifier);
      final currentTenant = ref.read(tenantControllerProvider);
      final signedIn = ref.read(authControllerProvider).isSignedIn;
      final slug = target.tenantSlug;
      final host = target.tenantHost;

      // 1. The centre named by the link.
      if (!signedIn) {
        if (slug != null && slug != currentTenant?.slug) {
          await tenants.select(slug);
        } else if (slug == null && host != null && currentTenant == null) {
          await tenants.selectByHost(host);
        }
      } else if (slug != null && currentTenant != null && slug != currentTenant.slug) {
        // Never switch centre behind the back of a signed-in user.
        links.clear();
        _notify('deepLinkOtherCentre', isError: true);
        return;
      }
      if (!mounted) return;

      final router = ref.read(routerProvider);
      final location = target.location;

      // 2. What the link asks for.
      if (target.kind == DeepLinkKind.centre) {
        links.clear();
        return;
      }
      if (target.kind == DeepLinkKind.verifyEmail) {
        links.clear();
        final token = target.token;
        if (token != null) {
          await ref.read(authRepositoryProvider).verifyEmail(token);
          if (!mounted) return;
          _notify('verifyEmailDone');
          if (ref.read(authControllerProvider).isSignedIn) {
            await ref.read(authControllerProvider.notifier).reloadSession();
          } else {
            router.go(Routes.login);
          }
        }
        return;
      }
      if (!target.requiresSession) {
        // Reset password / accept invitation: signed-out flows.
        links.clear();
        if (location != null && !ref.read(authControllerProvider).isSignedIn) router.go(location);
        return;
      }
      if (!ref.read(authControllerProvider).isSignedIn) {
        // Kept until the user has signed in; the sign-in screen is shown by
        // the router.
        return;
      }
      links.clear();
      if (location != null) {
        if (target.kind == DeepLinkKind.invoice) {
          // Typically the return from the payment gateway: show fresh data.
          refreshFinance(ref, invoiceId: target.id);
        }
        unawaited(router.push<void>(location));
      }
    } catch (error) {
      links.clear();
      _notifyError(error);
    } finally {
      _processingLink = false;
    }
  }

  void _ensureThemes(String? primary, String? secondary, String? accent) {
    final key = '$primary|$secondary|$accent';
    if (key == _themeKey && _lightTheme != null && _darkTheme != null) return;
    _themeKey = key;
    _lightTheme = AppTheme.build(brightness: Brightness.light, primaryHex: primary, secondaryHex: secondary, accentHex: accent);
    _darkTheme = AppTheme.build(brightness: Brightness.dark, primaryHex: primary, secondaryHex: secondary, accentHex: accent);
  }

  @override
  Widget build(BuildContext context) {
    final preferences = ref.watch(settingsControllerProvider);
    final tenant = ref.watch(tenantControllerProvider);
    final router = ref.watch(routerProvider);
    // Keeps push registration alive for the lifetime of the app.
    ref.watch(pushControllerProvider);

    ref.listen<DeepLinkTarget?>(deepLinkControllerProvider, (previous, next) {
      if (next != null) unawaited(_processPendingLink());
    });
    ref.listen<AppGate>(appGateProvider, (previous, next) {
      unawaited(_processPendingLink());
    });

    _ensureThemes(tenant?.primaryHex, tenant?.secondaryHex, tenant?.accentHex);

    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      scaffoldMessengerKey: _messengerKey,
      routerConfig: router,
      onGenerateTitle: (context) {
        final l10n = Localizations.of<AppLocalizations>(context, AppLocalizations);
        return tenant?.displayName(preferences.languageCode) ?? l10n?.t('appName') ?? 'TypEase';
      },
      theme: _lightTheme,
      darkTheme: _darkTheme,
      themeMode: preferences.themeMode,
      locale: preferences.locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }
}
