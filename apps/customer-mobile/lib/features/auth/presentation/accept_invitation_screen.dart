import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../data/auth_models.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'login_flow.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

final _invitationPreviewProvider = FutureProvider.autoDispose.family<InvitationPreview, String>((ref, token) {
  return ref.watch(authRepositoryProvider).previewInvitation(token);
});

/// Opened from a centre's invitation link (`.../accept-invitation?token=...`).
/// The invitation itself proves which centre and which customer record the
/// account belongs to; the person only chooses a password.
class AcceptInvitationScreen extends ConsumerStatefulWidget {
  const AcceptInvitationScreen({super.key, required this.token});

  final String token;

  @override
  ConsumerState<AcceptInvitationScreen> createState() => _AcceptInvitationScreenState();
}

class _AcceptInvitationScreenState extends ConsumerState<AcceptInvitationScreen> {
  final TextEditingController _name = TextEditingController();
  final TextEditingController _password = TextEditingController();
  String? _passwordError;
  String? _formError;
  bool _busy = false;
  bool _nameSeeded = false;

  @override
  void dispose() {
    _name.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit(InvitationPreview preview) async {
    if (_busy) return;
    final l10n = context.l10n;
    if (preview.needsPassword && !Validators.isStrongPassword(_password.text)) {
      setState(() => _passwordError = l10n.t('validationPasswordWeak'));
      return;
    }
    setState(() {
      _busy = true;
      _passwordError = null;
      _formError = null;
    });
    try {
      final result = await ref.read(authRepositoryProvider).acceptInvitation(
            token: widget.token,
            fullName: preview.needsPassword ? _name.text : null,
            password: preview.needsPassword ? _password.text : null,
          );
      if (!mounted) return;
      await continueSignIn(context, ref, result);
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _passwordError = fields['password'];
        _formError = fields.isEmpty ? describeSignInError(context, error) : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _formError = describeSignInError(context, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final preview = ref.watch(_invitationPreviewProvider(widget.token));
    final formError = _formError;

    return AuthScaffold(
      title: l10n.t('invitationTitle'),
      showBrand: false,
      children: <Widget>[
        AsyncValueView<InvitationPreview>(
          value: preview,
          onRetry: () => ref.invalidate(_invitationPreviewProvider(widget.token)),
          data: (invitation) {
            if (!_nameSeeded) {
              _nameSeeded = true;
              _name.text = invitation.fullName ?? '';
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      DetailRow(label: l10n.t('invitationCentre'), value: invitation.centreName),
                      DetailRow(label: l10n.t('fieldEmail'), value: invitation.email),
                    ],
                  ),
                ),
                if (formError != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
                  ),
                if (invitation.needsPassword) ...<Widget>[
                  AppTextField(
                    controller: _name,
                    label: l10n.t('fieldFullName'),
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                    prefixIcon: PhosphorIconsRegular.user,
                  ),
                  PasswordField(
                    controller: _password,
                    label: l10n.t('fieldNewPassword'),
                    helperText: l10n.t('fieldPasswordHelp'),
                    errorText: _passwordError,
                    isNewPassword: true,
                    textInputAction: TextInputAction.done,
                  ),
                ] else
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Text(l10n.t('invitationExistingAccount')),
                  ),
                PrimaryButton(label: l10n.t('invitationAccept'), onPressed: () => _submit(invitation), loading: _busy),
              ],
            );
          },
        ),
      ],
    );
  }
}
