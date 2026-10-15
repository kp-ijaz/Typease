import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../../tenant/application/tenant_controller.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Asks for the email address and sends a reset link. The answer is the same
/// whether or not the address is registered, so the screen never reveals
/// who has an account.
class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final TextEditingController _email = TextEditingController();
  String? _emailError;
  String? _formError;
  bool _busy = false;
  bool _sent = false;
  String? _devToken;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final l10n = context.l10n;
    final tenant = ref.read(tenantControllerProvider);
    if (tenant == null) return;
    final email = _email.text.trim();
    if (!Validators.isEmail(email)) {
      setState(() => _emailError = l10n.t('validationEmailInvalid'));
      return;
    }
    setState(() {
      _busy = true;
      _emailError = null;
      _formError = null;
    });
    try {
      final ack = await ref.read(authRepositoryProvider).forgotPassword(email: email, tenantSlug: tenant.slug);
      if (!mounted) return;
      setState(() {
        _sent = true;
        _devToken = kDebugMode ? ack.devToken : null;
      });
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _emailError = fields['email'];
        _formError = fields.isEmpty ? describeError(l10n, error) : null;
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
    final devToken = _devToken;

    if (_sent) {
      return AuthScaffold(
        title: l10n.t('forgotSentTitle'),
        subtitle: l10n.t('forgotSentBody'),
        children: <Widget>[
          PrimaryButton(label: l10n.t('forgotBackToLogin'), onPressed: () => context.go(Routes.login)),
          if (devToken != null) ...<Widget>[
            const SizedBox(height: 20),
            InfoBanner(
              tone: Tone.neutral,
              icon: PhosphorIconsRegular.code,
              message: l10n.t('devTokenNotice'),
              action: OutlinedButton(
                onPressed: () => context.push<void>(Routes.resetPasswordWith(devToken)),
                child: Text(l10n.t('devResetNow')),
              ),
            ),
          ],
        ],
      );
    }

    return AuthScaffold(
      title: l10n.t('forgotTitle'),
      subtitle: l10n.t('forgotSubtitle'),
      children: <Widget>[
        if (formError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
          ),
        AppTextField(
          controller: _email,
          label: l10n.t('fieldEmail'),
          errorText: _emailError,
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.done,
          autofillHints: const <String>[AutofillHints.email],
          forceLtr: true,
          prefixIcon: PhosphorIconsRegular.envelopeSimple,
          onSubmitted: (_) => _submit(),
        ),
        PrimaryButton(label: l10n.t('forgotSubmit'), onPressed: _submit, loading: _busy),
      ],
    );
  }
}

/// Opened from the reset link (`.../reset-password?token=...`): choose a new
/// password.
class ResetPasswordScreen extends ConsumerStatefulWidget {
  const ResetPasswordScreen({super.key, required this.token});

  final String token;

  @override
  ConsumerState<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends ConsumerState<ResetPasswordScreen> {
  final TextEditingController _password = TextEditingController();
  String? _passwordError;
  String? _formError;
  bool _busy = false;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final l10n = context.l10n;
    if (widget.token.isEmpty) {
      setState(() => _formError = l10n.t('resetLinkInvalid'));
      return;
    }
    if (!Validators.isStrongPassword(_password.text)) {
      setState(() => _passwordError = l10n.t('validationPasswordWeak'));
      return;
    }
    setState(() {
      _busy = true;
      _passwordError = null;
      _formError = null;
    });
    try {
      await ref.read(authRepositoryProvider).resetPassword(token: widget.token, password: _password.text);
      if (!mounted) return;
      showMessage(context, l10n.t('resetDone'));
      context.go(Routes.login);
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _passwordError = fields['password'];
        _formError = fields.isEmpty ? describeError(l10n, error) : null;
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
    return AuthScaffold(
      title: l10n.t('resetTitle'),
      subtitle: l10n.t('resetSubtitle'),
      children: <Widget>[
        if (formError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
          ),
        PasswordField(
          controller: _password,
          label: l10n.t('fieldNewPassword'),
          helperText: l10n.t('fieldPasswordHelp'),
          errorText: _passwordError,
          textInputAction: TextInputAction.done,
          isNewPassword: true,
          onSubmitted: (_) => _submit(),
        ),
        PrimaryButton(label: l10n.t('resetSubmit'), onPressed: _submit, loading: _busy),
      ],
    );
  }
}
