import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/data/auth_models.dart';
import '../../auth/data/auth_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

final _sessionsProvider = FutureProvider.autoDispose<List<AuthSession>>((ref) {
  return ref.watch(authRepositoryProvider).sessions();
});

/// Active sessions: every device and browser that is signed in to the
/// account, with a way to sign each of them out.
class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key});

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  bool _busy = false;

  Future<void> _refresh() async {
    ref.invalidate(_sessionsProvider);
    try {
      await ref.read(_sessionsProvider.future);
    } catch (_) {
      // Shown by the list.
    }
  }

  Future<void> _revoke(AuthSession session) async {
    final l10n = context.l10n;
    final confirmed = await showConfirmDialog(
      context,
      title: l10n.t('sessionsRevokeTitle'),
      message: l10n.t('sessionsRevokeBody'),
      confirmLabel: l10n.t('sessionsRevoke'),
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).revokeSession(session.id);
      ref.invalidate(_sessionsProvider);
      if (mounted) showMessage(context, l10n.t('sessionsRevoked'));
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revokeOthers() async {
    final l10n = context.l10n;
    final confirmed = await showConfirmDialog(
      context,
      title: l10n.t('sessionsRevokeOthersTitle'),
      message: l10n.t('sessionsRevokeOthersBody'),
      confirmLabel: l10n.t('sessionsRevokeOthers'),
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).revokeOtherSessions();
      ref.invalidate(_sessionsProvider);
      if (mounted) showMessage(context, l10n.t('sessionsRevoked'));
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final sessions = ref.watch(_sessionsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('sessionsTitle'))),
      body: AsyncValueView<List<AuthSession>>(
        value: sessions,
        onRetry: () => ref.invalidate(_sessionsProvider),
        data: (items) {
          final hasOthers = items.any((s) => !s.current);
          return RefreshableList(
            onRefresh: _refresh,
            children: <Widget>[
              Text(l10n.t('sessionsIntro')),
              const SizedBox(height: 12),
              for (final session in items)
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Icon(session.app == 'mobile' ? PhosphorIconsRegular.deviceMobile : PhosphorIconsRegular.desktop, color: tokens.mutedText),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              session.deviceName ?? l10n.tOr('sessionApp_${session.app}', session.app),
                              style: theme.textTheme.titleSmall,
                            ),
                          ),
                          if (session.current) StatusBadge(label: l10n.t('sessionsThisDevice'), tone: Tone.success),
                        ],
                      ),
                      const SizedBox(height: 8),
                      DetailRow(label: l10n.t('sessionsSignedIn'), value: Dates.dateTime(session.createdAt, l10n.languageCode)),
                      DetailRow(label: l10n.t('sessionsLastUsed'), value: Dates.dateTime(session.lastUsedAt, l10n.languageCode)),
                      if (!session.current)
                        Align(
                          alignment: AlignmentDirectional.centerEnd,
                          child: TextButton(
                            style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
                            onPressed: _busy ? null : () => _revoke(session),
                            child: Text(l10n.t('sessionsRevoke')),
                          ),
                        ),
                    ],
                  ),
                ),
              if (hasOthers)
                OutlinedButton.icon(
                  onPressed: _busy ? null : _revokeOthers,
                  icon: const Icon(PhosphorIconsRegular.signOut),
                  label: Text(l10n.t('sessionsRevokeOthers')),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// Change password (the current password is required).
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final TextEditingController _current = TextEditingController();
  final TextEditingController _next = TextEditingController();
  String? _currentError;
  String? _nextError;
  String? _formError;
  bool _busy = false;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final l10n = context.l10n;
    String? currentError;
    String? nextError;
    if (_current.text.isEmpty) currentError = l10n.t('validationPasswordRequired');
    if (!Validators.isStrongPassword(_next.text)) {
      nextError = l10n.t('validationPasswordWeak');
    } else if (_next.text == _current.text) {
      nextError = l10n.t('validationPasswordSame');
    }
    setState(() {
      _currentError = currentError;
      _nextError = nextError;
      _formError = null;
    });
    if (currentError != null || nextError != null) return;

    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).changePassword(currentPassword: _current.text, newPassword: _next.text);
      if (!mounted) return;
      showMessage(context, l10n.t('changePasswordDone'));
      context.pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        if (error.code == 'INVALID_CREDENTIALS') {
          _currentError = error.message.isNotEmpty ? error.message : l10n.t('changePasswordWrongCurrent');
        } else {
          _currentError = fields['currentPassword'];
          _nextError = fields['newPassword'];
          _formError = fields.isEmpty ? describeError(l10n, error) : null;
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _formError = describeError(l10n, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final formError = _formError;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('changePasswordTitle'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
        children: <Widget>[
          if (formError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
            ),
          PasswordField(
            controller: _current,
            label: l10n.t('fieldCurrentPassword'),
            errorText: _currentError,
            textInputAction: TextInputAction.next,
          ),
          PasswordField(
            controller: _next,
            label: l10n.t('fieldNewPassword'),
            helperText: l10n.t('fieldPasswordHelp'),
            errorText: _nextError,
            isNewPassword: true,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
          ),
          PrimaryButton(label: l10n.t('changePasswordSubmit'), loading: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}
