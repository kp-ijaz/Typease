import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/data/auth_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Verify the phone number of the account with a one-time code sent by SMS.
/// A verified number can then be used to sign in with a code.
class VerifyPhoneScreen extends ConsumerStatefulWidget {
  const VerifyPhoneScreen({super.key});

  @override
  ConsumerState<VerifyPhoneScreen> createState() => _VerifyPhoneScreenState();
}

class _VerifyPhoneScreenState extends ConsumerState<VerifyPhoneScreen> {
  static const int _resendSeconds = 60;

  late final TextEditingController _phone;
  final TextEditingController _code = TextEditingController();
  String? _phoneError;
  String? _codeError;
  String? _sentTo;
  String? _devCode;
  bool _busy = false;
  int _secondsLeft = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    final current = ref.read(sessionProvider)?.user.phone;
    _phone = TextEditingController(text: (current == null || current.isEmpty) ? '+971' : current);
  }

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
    if (_busy) return;
    final l10n = context.l10n;
    final phone = Validators.normalisePhone(_phone.text);
    if (!Validators.isPhone(phone)) {
      setState(() => _phoneError = l10n.t('validationPhoneInvalid'));
      return;
    }
    setState(() {
      _busy = true;
      _phoneError = null;
    });
    try {
      final ack = await ref.read(authRepositoryProvider).requestPhoneVerification(phone);
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
      if (fields.containsKey('phone')) {
        setState(() => _phoneError = fields['phone']);
      } else {
        showError(context, error);
      }
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final phone = _sentTo;
    if (_busy || phone == null) return;
    final l10n = context.l10n;
    final code = _code.text.trim();
    if (!Validators.isOtp(code)) {
      setState(() => _codeError = l10n.t('validationCodeInvalid'));
      return;
    }
    setState(() {
      _busy = true;
      _codeError = null;
    });
    try {
      await ref.read(authRepositoryProvider).verifyPhone(phone: phone, code: code);
      await ref.read(authControllerProvider.notifier).reloadSession();
      if (!mounted) return;
      showMessage(context, l10n.t('phoneVerified'));
      context.pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'CODE_INVALID') {
        setState(() => _codeError = error.message.isNotEmpty ? error.message : l10n.t('validationCodeInvalid'));
      } else {
        showError(context, error);
      }
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final sentTo = _sentTo;
    final devCode = _devCode;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('phoneVerifyTitle'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
        children: <Widget>[
          if (sentTo == null) ...<Widget>[
            Text(l10n.t('phoneVerifyIntro')),
            const SizedBox(height: 16),
            AppTextField(
              controller: _phone,
              label: l10n.t('fieldPhone'),
              helperText: l10n.t('fieldPhoneHelp'),
              errorText: _phoneError,
              keyboardType: TextInputType.phone,
              forceLtr: true,
              prefixIcon: PhosphorIconsRegular.phone,
              onSubmitted: (_) => _requestCode(),
            ),
            PrimaryButton(label: l10n.t('otpSendCode'), onPressed: _requestCode, loading: _busy),
          ] else ...<Widget>[
            Text(l10n.t('otpVerifySubtitle', <String, Object?>{'phone': '⁦$sentTo⁩'})),
            const SizedBox(height: 16),
            if (devCode != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: InfoBanner(
                  tone: Tone.neutral,
                  icon: PhosphorIconsRegular.code,
                  message: l10n.t('devCodeNotice', <String, Object?>{'code': devCode}),
                ),
              ),
            CodeField(controller: _code, label: l10n.t('fieldCode'), errorText: _codeError, onSubmitted: (_) => _verify()),
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
              onPressed: _busy ? null : () => setState(() => _sentTo = null),
              child: Text(l10n.t('otpChangeNumber')),
            ),
          ],
        ],
      ),
    );
  }
}
