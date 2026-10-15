import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'login_flow.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Second step of sign-in for accounts with two-step verification: the API
/// answered `MFA_REQUIRED` with a short-lived challenge token.
class MfaScreen extends ConsumerStatefulWidget {
  const MfaScreen({super.key, required this.challengeToken});

  final String challengeToken;

  @override
  ConsumerState<MfaScreen> createState() => _MfaScreenState();
}

class _MfaScreenState extends ConsumerState<MfaScreen> {
  final TextEditingController _code = TextEditingController();
  String? _codeError;
  String? _formError;
  bool _busy = false;
  bool _useRecoveryCode = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final l10n = context.l10n;
    final code = _code.text.trim();
    if (code.length < 6) {
      setState(() => _codeError = l10n.t('validationCodeInvalid'));
      return;
    }
    if (widget.challengeToken.isEmpty) {
      setState(() => _formError = l10n.t('mfaExpired'));
      return;
    }
    setState(() {
      _busy = true;
      _codeError = null;
      _formError = null;
    });
    try {
      final result = await ref.read(authRepositoryProvider).verifyMfa(challengeToken: widget.challengeToken, code: code);
      if (!mounted) return;
      await continueSignIn(context, ref, result);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        if (error.code == 'MFA_CODE_INVALID') {
          _codeError = error.message.isNotEmpty ? error.message : l10n.t('validationCodeInvalid');
        } else {
          // Typically the challenge expired: the user starts sign-in again.
          _formError = error.message.isNotEmpty ? error.message : l10n.t('mfaExpired');
        }
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
    final formError = _formError;
    return AuthScaffold(
      title: l10n.t('mfaTitle'),
      subtitle: _useRecoveryCode ? l10n.t('mfaRecoverySubtitle') : l10n.t('mfaSubtitle'),
      children: <Widget>[
        if (formError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
          ),
        CodeField(
          controller: _code,
          label: _useRecoveryCode ? l10n.t('mfaRecoveryCode') : l10n.t('fieldCode'),
          errorText: _codeError,
          digitsOnly: !_useRecoveryCode,
          maxLength: _useRecoveryCode ? 20 : 6,
          onSubmitted: (_) => _submit(),
        ),
        PrimaryButton(label: l10n.t('mfaSubmit'), onPressed: _submit, loading: _busy),
        const SizedBox(height: 12),
        TextButton(
          onPressed: _busy
              ? null
              : () => setState(() {
                    _useRecoveryCode = !_useRecoveryCode;
                    _code.clear();
                    _codeError = null;
                  }),
          child: Text(_useRecoveryCode ? l10n.t('mfaUseAuthenticator') : l10n.t('mfaUseRecovery')),
        ),
      ],
    );
  }
}
