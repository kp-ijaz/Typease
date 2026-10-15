import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../application/profile_providers.dart';
import '../data/profile_models.dart';
import '../data/profile_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Communication preferences: on which channels the centre may contact the
/// customer about their requests. Stored on the customer record.
class CommunicationScreen extends ConsumerStatefulWidget {
  const CommunicationScreen({super.key});

  @override
  ConsumerState<CommunicationScreen> createState() => _CommunicationScreenState();
}

class _CommunicationScreenState extends ConsumerState<CommunicationScreen> {
  String? _savingChannel;

  static const List<String> _channels = <String>['email', 'sms', 'whatsapp', 'push'];

  static IconData _icon(String channel) {
    switch (channel) {
      case 'email':
        return PhosphorIconsRegular.envelopeSimple;
      case 'sms':
        return PhosphorIconsRegular.chatText;
      case 'whatsapp':
        return PhosphorIconsRegular.chatCircle;
      default:
        return PhosphorIconsRegular.bell;
    }
  }

  Future<void> _toggle(String channel, bool enabled) async {
    if (_savingChannel != null) return;
    setState(() => _savingChannel = channel);
    try {
      await ref.read(profileRepositoryProvider).update(communicationPrefs: <String, bool>{channel: enabled});
      ref.invalidate(profileProvider);
      // WhatsApp mirrors a consent decision on the server.
      ref.invalidate(consentsProvider);
      await ref.read(profileProvider.future);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _savingChannel = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final profile = ref.watch(profileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('communicationTitle'))),
      body: AsyncValueView<CustomerProfile>(
        value: profile,
        onRetry: () => ref.invalidate(profileProvider),
        data: (data) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: <Widget>[
            Text(l10n.t('communicationIntro')),
            const SizedBox(height: 12),
            SectionCard(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(
                children: <Widget>[
                  for (final channel in _channels)
                    SwitchListTile(
                      secondary: Icon(_icon(channel)),
                      title: Text(l10n.t('channel_$channel')),
                      subtitle: Text(l10n.t('channelHelp_$channel')),
                      value: data.communicationPrefs.valueOf(channel),
                      onChanged: _savingChannel == null ? (value) => _toggle(channel, value) : null,
                    ),
                ],
              ),
            ),
            InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.shieldCheck, message: l10n.t('communicationSecurityNote')),
          ],
        ),
      ),
    );
  }
}

/// Consents: what the customer allows the centre to do with their data, one
/// switch per purpose. Withdrawing asks for confirmation; the consent needed
/// to deliver the service cannot be switched off here.
class ConsentsScreen extends ConsumerStatefulWidget {
  const ConsentsScreen({super.key});

  @override
  ConsumerState<ConsentsScreen> createState() => _ConsentsScreenState();
}

class _ConsentsScreenState extends ConsumerState<ConsentsScreen> {
  String? _savingPurpose;

  Future<void> _toggle(ConsentState consent, bool granted) async {
    if (_savingPurpose != null) return;
    final l10n = context.l10n;
    if (!granted) {
      final confirmed = await showConfirmDialog(
        context,
        title: l10n.t('consentWithdrawTitle'),
        message: l10n.t('consentWithdrawBody', <String, Object?>{
          'purpose': l10n.tOr('consent_${consent.purpose}', consent.description),
        }),
        confirmLabel: l10n.t('consentWithdraw'),
        destructive: true,
      );
      if (!confirmed || !mounted) return;
    }
    setState(() => _savingPurpose = consent.purpose);
    try {
      await ref.read(profileRepositoryProvider).saveConsent(purpose: consent.purpose, granted: granted);
      ref.invalidate(consentsProvider);
      ref.invalidate(profileProvider);
      await ref.read(consentsProvider.future);
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _savingPurpose = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final consents = ref.watch(consentsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('consentsTitle'))),
      body: AsyncValueView<List<ConsentState>>(
        value: consents,
        onRetry: () => ref.invalidate(consentsProvider),
        data: (items) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: <Widget>[
            Text(l10n.t('consentsIntro')),
            const SizedBox(height: 12),
            for (final consent in items)
              SectionCard(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: SwitchListTile(
                  title: Text(l10n.tOr('consent_${consent.purpose}', consent.purpose)),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      // The centre's own description of the purpose.
                      Text(consent.description),
                      if (consent.isRequired)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(
                            l10n.t('consentRequiredNote'),
                            style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                          ),
                        ),
                    ],
                  ),
                  value: consent.granted,
                  onChanged: (consent.isRequired || _savingPurpose != null) ? null : (value) => _toggle(consent, value),
                ),
              ),
            Text(l10n.t('consentsHistoryNote'), style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
          ],
        ),
      ),
    );
  }
}
