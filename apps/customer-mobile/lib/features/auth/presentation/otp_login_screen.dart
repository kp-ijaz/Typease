import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../../tenant/application/tenant_controller.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'login_flow.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Sign in with a one-time code sent to a verified phone number.
/// Step 1 asks for the number, step 2 (OTP verification) for the code.
class OtpLoginScreen extends ConsumerStatefulWidget {
  const OtpLoginScreen({super.key});

  @override
  ConsumerState<OtpLoginScreen> createState() => _OtpLoginScreenState();
}

class _OtpLoginScreenState extends ConsumerState<OtpLoginScreen> {
  static const int _resendSeconds = 60;

  final TextEditingController _phone = TextEditingController(text: '+971');
  final TextEditingController _code = TextEditingController();
  String? _phoneError;
  String? _codeError;
  String? _formError;
  String? _sentTo;
  String? _devCode;
  bool _busy = false;
  int _secondsLeft = 0;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  void _startCountdown() {
    _timer?.cancel();
    setState(() => _secondsLeft = _resendSeconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        _secondsLeft = _secondsLeft > 0 ? _secondsLeft - 1 : 0;
      });
      if (_secondsLeft == 0) timer.cancel();
    });
  }

  Future<void> _requestCode() async {
    final l10n = context.l10n;
    final tenant = ref.read(tenantControllerProvider);
    if (_busy || tenant == null) return;
    final phone = Validators.normalisePhone(_phone.text);
    if (!Validators.isPhone(phone)) {
      setState(() => _phoneError = l10n.t('validationPhoneInvalid'));
      return;
    }
    setState(() {
      _busy = true;
      _phoneError = null;
      _formError = null;
    });
    try {
      final ack = await ref.read(authRepositoryProvider).requestOtp(phone: phone, tenantSlug: tenant.slug);
      if (!mounted) return;
      setState(() {
        _sentTo = phone;
        _devCode = kDebugMode ? ack.devOtp : null;
        _code.clear();
        _codeError = null;
      });
      _startCountdown();
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _phoneError = fields['phone'];
        _formError = fields.isEmpty ? describeSignInError(context, error) : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _formError = describeSignInError(context, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final l10n = context.l10n;
    final tenant = ref.read(tenantControllerProvider);
    final phone = _sentTo;
    if (_busy || tenant == null || phone == null) return;
    final code = _code.text.trim();
    if (!Validators.isOtp(code)) {
      setState(() => _codeError = l10n.t('validationCodeInvalid'));
      return;
    }
    setState(() {
      _busy = true;
      _codeError = null;
      _formError = null;
    });
    try {
      final result = await ref.read(authRepositoryProvider).verifyOtp(phone: phone, code: code, tenantSlug: tenant.slug);
      if (!mounted) return;
      await continueSignIn(context, ref, result);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        if (error.code == 'CODE_INVALID') {
          _codeError = error.message.isNotEmpty ? error.message : l10n.t('validationCodeInvalid');
        } else {
          _formError = describeSignInError(context, error);
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
    final sentTo = _sentTo;
    final formError = _formError;
    final devCode = _devCode;

    if (sentTo == null) {
      return AuthScaffold(
        title: l10n.t('otpLoginTitle'),
        subtitle: l10n.t('otpLoginSubtitle'),
        children: <Widget>[
          if (formError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
            ),
          AppTextField(
            controller: _phone,
            label: l10n.t('fieldPhone'),
            helperText: l10n.t('fieldPhoneHelp'),
            errorText: _phoneError,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.done,
            autofillHints: const <String>[AutofillHints.telephoneNumber],
            forceLtr: true,
            prefixIcon: PhosphorIconsRegular.phone,
            onSubmitted: (_) => _requestCode(),
          ),
          PrimaryButton(label: l10n.t('otpSendCode'), onPressed: _requestCode, loading: _busy),
        ],
      );
    }

    return AuthScaffold(
      title: l10n.t('otpVerifyTitle'),
      subtitle: l10n.t('otpVerifySubtitle', <String, Object?>{'phone': '⁦$sentTo⁩'}),
      children: <Widget>[
        if (formError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
          ),
        if (devCode != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(
              tone: Tone.neutral,
              icon: PhosphorIconsRegular.code,
              message: l10n.t('devCodeNotice', <String, Object?>{'code': devCode}),
            ),
          ),
        CodeField(
          controller: _code,
          label: l10n.t('fieldCode'),
          errorText: _codeError,
          onSubmitted: (_) => _verify(),
        ),
        PrimaryButton(label: l10n.t('otpVerifySubmit'), onPressed: _verify, loading: _busy),
        const SizedBox(height: 12),
        TextButton(
          onPressed: (_secondsLeft > 0 || _busy) ? null : _requestCode,
          child: Text(
            _secondsLeft > 0
                ? l10n.t('otpResendIn', <String, Object?>{'seconds': _secondsLeft})
                : l10n.t('otpResend'),
          ),
        ),
        TextButton(
          onPressed: _busy
              ? null
              : () => setState(() {
                    _sentTo = null;
                    _devCode = null;
                    _formError = null;
                  }),
          child: Text(l10n.t('otpChangeNumber')),
        ),
      ],
    );
  }
}
