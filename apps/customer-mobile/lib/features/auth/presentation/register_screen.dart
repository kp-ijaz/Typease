import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../../settings/application/settings_controller.dart';
import '../../tenant/application/tenant_controller.dart';
import '../data/auth_repository.dart';
import 'auth_scaffold.dart';
import 'login_flow.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Customer self-registration at the selected centre, with acceptance of the
/// terms and privacy notice and an optional marketing opt-in.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final TextEditingController _name = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _password = TextEditingController();
  Map<String, String> _errors = <String, String>{};
  String? _formError;
  bool _acceptTerms = false;
  bool _marketing = false;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _phone.dispose();
    _password.dispose();
    super.dispose();
  }

  Map<String, String> _validate() {
    final l10n = context.l10n;
    final errors = <String, String>{};
    if (_name.text.trim().length < 2) errors['fullName'] = l10n.t('validationNameRequired');
    final email = _email.text.trim();
    if (email.isEmpty) {
      errors['email'] = l10n.t('validationEmailRequired');
    } else if (!Validators.isEmail(email)) {
      errors['email'] = l10n.t('validationEmailInvalid');
    }
    final phone = Validators.normalisePhone(_phone.text);
    if (phone.isNotEmpty && !Validators.isPhone(phone)) errors['phone'] = l10n.t('validationPhoneInvalid');
    if (!Validators.isStrongPassword(_password.text)) errors['password'] = l10n.t('validationPasswordWeak');
    if (!_acceptTerms) errors['acceptTerms'] = l10n.t('validationTermsRequired');
    return errors;
  }

  Future<void> _submit() async {
    if (_busy) return;
    final tenant = ref.read(tenantControllerProvider);
    if (tenant == null) return;
    final errors = _validate();
    setState(() {
      _errors = errors;
      _formError = null;
    });
    if (errors.isNotEmpty) return;

    final email = _email.text.trim();
    final phone = Validators.normalisePhone(_phone.text);
    setState(() => _busy = true);
    try {
      await ref.read(authRepositoryProvider).register(
            tenantSlug: tenant.slug,
            fullName: _name.text,
            email: email,
            phone: phone.isEmpty ? null : phone,
            password: _password.text,
            preferredLanguage: ref.read(settingsControllerProvider).languageCode,
            marketingOptIn: _marketing,
          );
      if (!mounted) return;
      // Replace this screen so "back" does not return to a filled-in form.
      context.pushReplacement(Routes.verifyEmailFor(email));
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _errors = fields;
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
    final theme = Theme.of(context);
    final tenant = ref.watch(tenantControllerProvider);
    final formError = _formError;
    final termsError = _errors['acceptTerms'];
    final centreName = tenant?.displayName(l10n.languageCode) ?? '';

    return AuthScaffold(
      title: l10n.t('registerTitle'),
      subtitle: l10n.t('registerSubtitle', <String, Object?>{'centre': centreName}),
      children: <Widget>[
        if (formError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
          ),
        AutofillGroup(
          child: Column(
            children: <Widget>[
              AppTextField(
                controller: _name,
                label: l10n.t('fieldFullName'),
                errorText: _errors['fullName'],
                textInputAction: TextInputAction.next,
                textCapitalization: TextCapitalization.words,
                autofillHints: const <String>[AutofillHints.name],
                prefixIcon: PhosphorIconsRegular.user,
              ),
              AppTextField(
                controller: _email,
                label: l10n.t('fieldEmail'),
                errorText: _errors['email'],
                keyboardType: TextInputType.emailAddress,
                textInputAction: TextInputAction.next,
                autofillHints: const <String>[AutofillHints.email],
                forceLtr: true,
                prefixIcon: PhosphorIconsRegular.envelopeSimple,
              ),
              AppTextField(
                controller: _phone,
                label: l10n.t('fieldPhoneOptional'),
                helperText: l10n.t('fieldPhoneHelp'),
                errorText: _errors['phone'],
                keyboardType: TextInputType.phone,
                textInputAction: TextInputAction.next,
                autofillHints: const <String>[AutofillHints.telephoneNumber],
                forceLtr: true,
                prefixIcon: PhosphorIconsRegular.phone,
              ),
              PasswordField(
                controller: _password,
                label: l10n.t('fieldPassword'),
                helperText: l10n.t('fieldPasswordHelp'),
                errorText: _errors['password'],
                textInputAction: TextInputAction.done,
                isNewPassword: true,
              ),
            ],
          ),
        ),
        CheckboxListTile(
          value: _acceptTerms,
          onChanged: (value) => setState(() => _acceptTerms = value ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.t('registerAcceptTerms', <String, Object?>{'centre': centreName})),
          subtitle: termsError == null
              ? null
              : Text(termsError, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
        ),
        CheckboxListTile(
          value: _marketing,
          onChanged: (value) => setState(() => _marketing = value ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.t('registerMarketing')),
        ),
        const SizedBox(height: 12),
        PrimaryButton(label: l10n.t('registerSubmit'), onPressed: _submit, loading: _busy),
        const SizedBox(height: 8),
        Text(l10n.t('registerWhatNext'), style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
      ],
    );
  }
}
