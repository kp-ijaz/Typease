import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/countries.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/brand_logo.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/application/auth_controller.dart';
import '../application/profile_providers.dart';
import '../data/profile_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Profile: who is signed in, the details the centre has on record, and the
/// way to everything personal (preferences, consents, settings).
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final session = ref.watch(sessionProvider);
    final profile = ref.watch(profileProvider);
    final user = session?.user;
    final hasCustomerRecord = session?.hasCustomerProfile ?? false;

    Future<void> refresh() async {
      ref.invalidate(profileProvider);
      try {
        await ref.read(authControllerProvider.notifier).reloadSession();
        if (hasCustomerRecord) await ref.read(profileProvider.future);
      } catch (_) {
        // Shown by the screen.
      }
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

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.t('profileTitle')),
        actions: <Widget>[
          IconButton(
            tooltip: l10n.t('settingsTitle'),
            icon: const Icon(PhosphorIconsRegular.gearSix),
            onPressed: () => context.push<void>(Routes.settings),
          ),
        ],
      ),
      body: RefreshableList(
        onRefresh: refresh,
        children: <Widget>[
          if (user != null)
            SectionCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      // The brand-coloured monogram doubles as the avatar.
                      BrandLogo(name: user.fullName, height: 56, showName: false),
                      const SizedBox(width: 14),
                      Expanded(child: Text(user.fullName, style: theme.textTheme.titleLarge)),
                    ],
                  ),
                  const SizedBox(height: 14),
                  _ContactLine(icon: PhosphorIconsRegular.envelopeSimple, value: user.email, verified: user.emailVerified),
                  if (user.phone != null) ...<Widget>[
                    const SizedBox(height: 6),
                    _ContactLine(icon: PhosphorIconsRegular.phone, value: user.phone!, verified: user.phoneVerified),
                  ],
                  if (!user.phoneVerified)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: OutlinedButton.icon(
                        onPressed: () => context.push<void>(Routes.verifyPhone),
                        icon: const Icon(PhosphorIconsRegular.sealCheck, size: 18),
                        label: Text(user.phone == null ? l10n.t('profileAddPhone') : l10n.t('profileVerifyPhone')),
                      ),
                    ),
                ],
              ),
            ),
          if (hasCustomerRecord)
            AsyncValueView<CustomerProfile>(
              value: profile,
              onRetry: () => ref.invalidate(profileProvider),
              loading: const Padding(padding: EdgeInsets.all(24), child: LoadingView()),
              data: (data) => _ProfileDetails(profile: data),
            )
          else
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: InfoBanner(tone: Tone.neutral, message: l10n.t('profileCompanyAccount')),
            ),
          SectionCard(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              children: <Widget>[
                if (hasCustomerRecord) ...<Widget>[
                  _NavTile(icon: PhosphorIconsRegular.megaphone, label: l10n.t('communicationTitle'), route: Routes.communication),
                  const Divider(indent: 16, endIndent: 16),
                  _NavTile(icon: PhosphorIconsRegular.listChecks, label: l10n.t('consentsTitle'), route: Routes.consents),
                  const Divider(indent: 16, endIndent: 16),
                ],
                _NavTile(icon: PhosphorIconsRegular.calendarDots, label: l10n.t('appointmentsTitle'), route: Routes.appointments),
                const Divider(indent: 16, endIndent: 16),
                _NavTile(icon: PhosphorIconsRegular.bellRinging, label: l10n.t('remindersTitle'), route: Routes.reminders),
                const Divider(indent: 16, endIndent: 16),
                _NavTile(icon: PhosphorIconsRegular.headset, label: l10n.t('supportTitle'), route: Routes.support),
                const Divider(indent: 16, endIndent: 16),
                _NavTile(icon: PhosphorIconsRegular.gearSix, label: l10n.t('settingsTitle'), route: Routes.settings),
              ],
            ),
          ),
          TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
            onPressed: signOut,
            icon: const Icon(PhosphorIconsRegular.signOut),
            label: Text(l10n.t('signOut')),
          ),
          const SizedBox(height: 8),
          Text(
            l10n.t('profileRecordNote'),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
          ),
        ],
      ),
    );
  }
}

class _ContactLine extends StatelessWidget {
  const _ContactLine({required this.icon, required this.value, required this.verified});

  final IconData icon;
  final String value;
  final bool verified;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final tokens = BrandTokens.of(context);
    return Row(
      children: <Widget>[
        Icon(icon, size: 18, color: tokens.mutedText),
        const SizedBox(width: 8),
        Expanded(child: Text(value, textDirection: TextDirection.ltr, textAlign: TextAlign.start)),
        StatusBadge(
          label: verified ? l10n.t('profileVerified') : l10n.t('profileNotVerified'),
          tone: verified ? Tone.success : Tone.warning,
        ),
      ],
    );
  }
}

class _ProfileDetails extends StatelessWidget {
  const _ProfileDetails({required this.profile});

  final CustomerProfile profile;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final language = l10n.languageCode;
    final address = profile.address;
    final nationality = profile.nationality;
    return Column(
      children: <Widget>[
        SectionCard(
          title: l10n.t('profileDetailsTitle'),
          trailing: TextButton(onPressed: () => context.push<void>(Routes.editProfile), child: Text(l10n.t('commonEdit'))),
          child: Column(
            children: <Widget>[
              DetailRow(label: l10n.t('profileCustomerNo'), value: profile.customerNo),
              DetailRow(label: l10n.t('fieldFullName'), value: profile.fullName),
              if (profile.fullNameAr != null && profile.fullNameAr!.isNotEmpty)
                DetailRow(label: l10n.t('fieldFullNameAr'), value: profile.fullNameAr!),
              DetailRow(label: l10n.t('profileLanguage'), value: profile.preferredLanguage == 'ar' ? 'العربية' : 'English'),
              if (nationality != null && nationality.isNotEmpty)
                DetailRow(label: l10n.t('profileNationality'), value: Countries.nameOf(nationality, language)),
              if (profile.dateOfBirth != null)
                DetailRow(label: l10n.t('profileDateOfBirth'), value: Dates.calendarDate(profile.dateOfBirth, language)),
              if (address != null && !address.isEmpty) DetailRow(label: l10n.t('profileAddress'), value: address.oneLine),
            ],
          ),
        ),
        if (profile.hasEmiratesId || profile.hasPassport)
          SectionCard(
            title: l10n.t('profileIdentityTitle'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (profile.hasEmiratesId) ...<Widget>[
                  DetailRow(label: l10n.t('profileEmiratesId'), value: profile.emiratesIdMasked ?? '••••'),
                  if (profile.emiratesIdExpiry != null)
                    DetailRow(label: l10n.t('profileExpires'), value: Dates.calendarDate(profile.emiratesIdExpiry, language)),
                ],
                if (profile.hasPassport) ...<Widget>[
                  DetailRow(label: l10n.t('profilePassport'), value: profile.passportNoMasked ?? '••••'),
                  if (profile.passportExpiry != null)
                    DetailRow(label: l10n.t('profileExpires'), value: Dates.calendarDate(profile.passportExpiry, language)),
                ],
                const SizedBox(height: 6),
                // Full numbers are never sent to the app.
                Text(l10n.t('profileIdentityNote'), style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
      ],
    );
  }
}

class _NavTile extends StatelessWidget {
  const _NavTile({required this.icon, required this.label, required this.route});

  final IconData icon;
  final String label;
  final String route;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(label),
      trailing: const Icon(PhosphorIconsRegular.caretRight),
      onTap: () => context.push<void>(route),
    );
  }
}
