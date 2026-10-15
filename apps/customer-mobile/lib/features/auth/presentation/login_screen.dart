import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/routing/routes.dart';
import '../../../core/storage/prefs_keys.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/auth_controller.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'login_flow.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Sign in with email and password. One primary action; the other ways in
/// (phone code, new account, forgotten password) are secondary links.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();
  String? _emailError;
  String? _passwordError;
  String? _formError;
  bool _busy = false;

  String? _returningName;

  @override
  void initState() {
    super.initState();
    final prefs = ref.read(sharedPreferencesProvider);
    _email.text = prefs.getString(PrefsKeys.lastSignInEmail) ?? '';
    final name = prefs.getString(PrefsKeys.lastSignInName);
    _returningName = name == null || name.isEmpty ? null : name;
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool _validate() {
    final l10n = context.l10n;
    final email = _email.text.trim();
    String? emailError;
    String? passwordError;
    if (email.isEmpty) {
      emailError = l10n.t('validationEmailRequired');
    } else if (!Validators.isEmail(email)) {
      emailError = l10n.t('validationEmailInvalid');
    }
    if (_password.text.isEmpty) passwordError = l10n.t('validationPasswordRequired');
    setState(() {
      _emailError = emailError;
      _passwordError = passwordError;
      _formError = null;
    });
    return emailError == null && passwordError == null;
  }

  Future<void> _submit() async {
    if (_busy || !_validate()) return;
    final tenant = ref.read(tenantControllerProvider);
    if (tenant == null) return;
    final email = _email.text.trim();
    setState(() => _busy = true);
    try {
      final result = await ref.read(authRepositoryProvider).login(
            email: email,
            password: _password.text,
            tenantSlug: tenant.slug,
          );
      if (!mounted) return;
      await continueSignIn(context, ref, result);
    } on ApiException catch (error) {
      if (!mounted) return;
      if (error.code == 'EMAIL_NOT_VERIFIED') {
        // Keep what was typed and take the user to "confirm your email".
        await context.push<void>(Routes.verifyEmailFor(email));
        return;
      }
      final fields = error.fieldErrorMap;
      setState(() {
        _emailError = fields['email'];
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
    final tenant = ref.watch(tenantControllerProvider);
    final auth = ref.watch(authControllerProvider);
    final locked = ref.watch(appConfigProvider).isTenantLocked;
    final formError = _formError;
    final canRegister = tenant?.feature('selfRegistration') ?? false;
    final centreName = tenant?.displayName(l10n.languageCode) ?? '';

    return AuthScaffold(
      eyebrow: _returningName == null ? l10n.t('loginWelcome') : l10n.t('loginWelcomeName', <String, Object?>{'name': _returningName}),
      title: l10n.t('loginTitle'),
      subtitle: l10n.t('loginSubtitle', <String, Object?>{'centre': centreName}),
      showBack: false,
      children: <Widget>[
        if (auth.sessionExpired)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.warning, icon: PhosphorIconsRegular.lockKey, message: l10n.t('loginSessionExpired')),
          ),
        if (formError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
          ),
        AutofillGroup(
          child: Column(
            children: <Widget>[
              AppTextField(
                key: const Key('login-email'),
                controller: _email,
                label: l10n.t('fieldEmail'),
                errorText: _emailError,
                keyboardType: TextInputType.emailAddress,
                textInputAction: TextInputAction.next,
                autofillHints: const <String>[AutofillHints.username, AutofillHints.email],
                forceLtr: true,
                prefixIcon: PhosphorIconsRegular.envelopeSimple,
              ),
              PasswordField(
                key: const Key('login-password'),
                controller: _password,
                label: l10n.t('fieldPassword'),
                errorText: _passwordError,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submit(),
              ),
            ],
          ),
        ),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: TextButton(
            onPressed: () => context.push<void>(Routes.forgotPassword),
            child: Text(l10n.t('loginForgotPassword')),
          ),
        ),
        const SizedBox(height: 8),
        PrimaryButton(
          key: const Key('login-submit'),
          label: l10n.t('loginSubmit'),
          icon: PhosphorIconsRegular.arrowRight,
          onPressed: _submit,
          loading: _busy,
        ),
        OrDivider(label: l10n.t('commonOr')),
        OutlinedButton.icon(
          onPressed: () => context.push<void>(Routes.otpLogin),
          icon: const Icon(PhosphorIconsRegular.chatText, size: 20),
          label: Text(l10n.t('loginWithPhone')),
        ),
        const SizedBox(height: 12),
        OptionTile(
          key: const Key('login-guest'),
          icon: PhosphorIconsRegular.compass,
          title: l10n.t('loginGuestTitle'),
          subtitle: l10n.t('loginGuestBody'),
          onTap: () => context.push<void>(Routes.explore),
        ),
        if (canRegister) ...<Widget>[
          const SizedBox(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Flexible(child: Text(l10n.t('loginNoAccount'), style: Theme.of(context).textTheme.bodyMedium)),
              TextButton(
                onPressed: () => context.push<void>(Routes.register),
                child: Text(l10n.t('loginCreateAccount')),
              ),
            ],
          ),
        ],
        if (!locked)
          Center(
            child: TextButton.icon(
              style: TextButton.styleFrom(foregroundColor: BrandTokens.of(context).mutedText),
              onPressed: () async {
                ref.read(authControllerProvider.notifier).acknowledgeExpiry();
                await ref.read(tenantControllerProvider.notifier).clear();
              },
              icon: const Icon(PhosphorIconsRegular.arrowsLeftRight, size: 18),
              label: Text(l10n.t('loginSwitchCentre')),
            ),
          ),
      ],
    );
  }
}
