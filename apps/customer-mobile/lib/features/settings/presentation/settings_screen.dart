import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/section_card.dart';
import '../../auth/application/auth_controller.dart';
import '../../notifications/application/push_controller.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/settings_controller.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

final _packageInfoProvider = FutureProvider<PackageInfo>((ref) => PackageInfo.fromPlatform());

/// Settings: language, theme, notifications, security, privacy, the centre
/// and the app itself.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final preferences = ref.watch(settingsControllerProvider);
    final settings = ref.read(settingsControllerProvider.notifier);
    final tenant = ref.watch(tenantControllerProvider);
    final config = ref.watch(appConfigProvider);
    final push = ref.watch(pushControllerProvider);
    final info = ref.watch(_packageInfoProvider).valueOrNull;
    final session = ref.watch(sessionProvider);

    Future<void> switchCentre() async {
      final confirmed = await showConfirmDialog(
        context,
        title: l10n.t('settingsSwitchCentreTitle'),
        message: l10n.t('settingsSwitchCentreBody', <String, Object?>{'centre': tenant?.displayName(l10n.languageCode) ?? ''}),
        confirmLabel: l10n.t('settingsSwitchCentre'),
        destructive: true,
      );
      if (!confirmed || !context.mounted) return;
      // Both notifiers are read before the first await: signing out closes
      // this screen, after which `ref` may no longer be used.
      final auth = ref.read(authControllerProvider.notifier);
      final tenants = ref.read(tenantControllerProvider.notifier);
      await auth.signOut();
      await tenants.clear();
    }

    Future<void> signOut() async {
      final confirmed = await showConfirmDialog(
        context,
        title: l10n.t('signOutTitle'),
        message: l10n.t('signOutBody'),
        confirmLabel: l10n.t('signOut'),
      );
      if (!confirmed || !context.mounted) return;
      await ref.read(authControllerProvider.notifier).signOut();
    }

    final String pushStatus;
    if (!push.configured) {
      pushStatus = l10n.t('settingsPushNotConfigured');
    } else if (push.permissionDenied) {
      pushStatus = l10n.t('settingsPushDenied');
    } else if (push.registered) {
      pushStatus = l10n.t('settingsPushOn');
    } else {
      pushStatus = l10n.t('settingsPushOff');
    }

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('settingsTitle'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: <Widget>[
          SectionCard(
            title: l10n.t('settingsLanguage'),
            child: SizedBox(
              width: double.infinity,
              child: SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment<String>(value: 'en', label: Text('English')),
                  ButtonSegment<String>(value: 'ar', label: Text('العربية')),
                ],
                selected: <String>{preferences.languageCode},
                onSelectionChanged: (selection) {
                  if (selection.isNotEmpty) settings.setLanguage(selection.first);
                },
              ),
            ),
          ),
          SectionCard(
            title: l10n.t('settingsTheme'),
            child: SizedBox(
              width: double.infinity,
              child: SegmentedButton<ThemeMode>(
                segments: <ButtonSegment<ThemeMode>>[
                  ButtonSegment<ThemeMode>(value: ThemeMode.system, label: Text(l10n.t('settingsThemeSystem'))),
                  ButtonSegment<ThemeMode>(value: ThemeMode.light, label: Text(l10n.t('settingsThemeLight'))),
                  ButtonSegment<ThemeMode>(value: ThemeMode.dark, label: Text(l10n.t('settingsThemeDark'))),
                ],
                selected: <ThemeMode>{preferences.themeMode},
                onSelectionChanged: (selection) {
                  if (selection.isNotEmpty) settings.setThemeMode(selection.first);
                },
              ),
            ),
          ),
          SectionCard(
            title: l10n.t('settingsNotifications'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Column(
              children: <Widget>[
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.slidersHorizontal),
                  title: Text(l10n.t('notificationPrefsTitle')),
                  trailing: const Icon(PhosphorIconsRegular.caretRight),
                  onTap: () => context.push<void>(Routes.notificationPrefs),
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.bell),
                  title: Text(l10n.t('settingsPush')),
                  subtitle: Text(pushStatus),
                  trailing: (push.configured && !push.registered)
                      ? TextButton(
                          onPressed: () => ref.read(pushControllerProvider.notifier).registerDevice(),
                          child: Text(l10n.t('settingsPushEnable')),
                        )
                      : null,
                ),
              ],
            ),
          ),
          SectionCard(
            title: l10n.t('settingsSecurity'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Column(
              children: <Widget>[
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.devices),
                  title: Text(l10n.t('sessionsTitle')),
                  trailing: const Icon(PhosphorIconsRegular.caretRight),
                  onTap: () => context.push<void>(Routes.sessions),
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.password),
                  title: Text(l10n.t('changePasswordTitle')),
                  trailing: const Icon(PhosphorIconsRegular.caretRight),
                  onTap: () => context.push<void>(Routes.changePassword),
                ),
              ],
            ),
          ),
          SectionCard(
            title: l10n.t('settingsPrivacy'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Column(
              children: <Widget>[
                if (session?.can('self.privacy') ?? false)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(PhosphorIconsRegular.shieldWarning),
                    title: Text(l10n.t('privacyTitle')),
                    subtitle: Text(l10n.t('settingsPrivacyHelp')),
                    trailing: const Icon(PhosphorIconsRegular.caretRight),
                    onTap: () => context.push<void>(Routes.privacy),
                  ),
                if (session?.hasCustomerProfile ?? false)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(PhosphorIconsRegular.listChecks),
                    title: Text(l10n.t('consentsTitle')),
                    trailing: const Icon(PhosphorIconsRegular.caretRight),
                    onTap: () => context.push<void>(Routes.consents),
                  ),
              ],
            ),
          ),
          SectionCard(
            title: l10n.t('settingsCentre'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Column(
              children: <Widget>[
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.storefront),
                  title: Text(tenant?.displayName(l10n.languageCode) ?? '—'),
                  subtitle: tenant == null ? null : Text(tenant.slug, textDirection: TextDirection.ltr),
                ),
                if (!config.isTenantLocked)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(PhosphorIconsRegular.arrowsLeftRight),
                    title: Text(l10n.t('settingsSwitchCentre')),
                    onTap: switchCentre,
                  ),
              ],
            ),
          ),
          SectionCard(
            title: l10n.t('settingsAbout'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Column(
              children: <Widget>[
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.info),
                  title: Text(l10n.t('settingsVersion')),
                  subtitle: Text(
                    info == null ? '—' : '${info.version} (${info.buildNumber}) · ${config.flavor}',
                    textDirection: TextDirection.ltr,
                  ),
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(PhosphorIconsRegular.article),
                  title: Text(l10n.t('settingsLicences')),
                  trailing: const Icon(PhosphorIconsRegular.caretRight),
                  onTap: () => showLicensePage(
                    context: context,
                    applicationName: tenant?.displayName(l10n.languageCode) ?? l10n.t('appName'),
                    applicationVersion: info?.version,
                  ),
                ),
              ],
            ),
          ),
          TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
            onPressed: signOut,
            icon: const Icon(PhosphorIconsRegular.signOut),
            label: Text(l10n.t('signOut')),
          ),
          // A white-label centre shows its own brand only.
          if (tenant == null || !tenant.isWhiteLabel)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                l10n.t('settingsPoweredBy'),
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
              ),
            ),
        ],
      ),
    );
  }
}
