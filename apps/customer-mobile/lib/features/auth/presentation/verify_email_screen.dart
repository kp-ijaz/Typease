import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// "Check your inbox": shown after registration, and when someone tries to
/// sign in before confirming their email address. The confirmation link in
/// the email opens the centre's portal (or this app, when app links are set
/// up); afterwards the customer signs in.
class VerifyEmailScreen extends ConsumerStatefulWidget {
  const VerifyEmailScreen({super.key, required this.email});

  final String email;

  @override
  ConsumerState<VerifyEmailScreen> createState() => _VerifyEmailScreenState();
}

class _VerifyEmailScreenState extends ConsumerState<VerifyEmailScreen> {
  static const int _resendSeconds = 60;

  bool _busy = false;
  int _secondsLeft = 0;
  Timer? _timer;

  /// Only ever set in debug builds against a development API.
  String? _devToken;

  @override
  void dispose() {
    _timer?.cancel();
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

  Future<void> _resend() async {
    if (_busy || widget.email.isEmpty) return;
    final l10n = context.l10n;
    setState(() => _busy = true);
    try {
      final ack = await ref.read(authRepositoryProvider).resendVerification(widget.email);
      if (!mounted) return;
      setState(() => _devToken = kDebugMode ? ack.devToken : null);
      _startCountdown();
      showMessage(context, l10n.t('verifyEmailResent'));
    } catch (error) {
      if (!mounted) return;
      showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmWithDevToken() async {
    final token = _devToken;
    if (token == null || _busy) return;
    final l10n = context.l10n;
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).verifyEmail(token);
      if (!mounted) return;
      showMessage(context, l10n.t('verifyEmailDone'));
      context.go(Routes.login);
    } catch (error) {
      if (!mounted) return;
      showError(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final devToken = _devToken;
    return AuthScaffold(
      title: l10n.t('verifyEmailTitle'),
      subtitle: l10n.t('verifyEmailSubtitle', <String, Object?>{'email': '⁦${widget.email}⁩'}),
      children: <Widget>[
        InfoBanner(icon: PhosphorIconsRegular.envelopeSimpleOpen, message: l10n.t('verifyEmailSteps')),
        const SizedBox(height: 20),
        PrimaryButton(label: l10n.t('verifyEmailContinue'), onPressed: () => context.go(Routes.login)),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: (_secondsLeft > 0 || _busy) ? null : _resend,
          child: Text(
            _secondsLeft > 0
                ? l10n.t('verifyEmailResendIn', <String, Object?>{'seconds': _secondsLeft})
                : l10n.t('verifyEmailResend'),
          ),
        ),
        if (devToken != null) ...<Widget>[
          const SizedBox(height: 20),
          InfoBanner(
            tone: Tone.neutral,
            icon: PhosphorIconsRegular.code,
            message: l10n.t('devTokenNotice'),
            action: OutlinedButton(onPressed: _busy ? null : _confirmWithDevToken, child: Text(l10n.t('devConfirmNow'))),
          ),
        ],
      ],
    );
  }
}
