import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n/l10n_ext.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// A labelled text input with an error line. Screens keep their own
/// controllers, so what the user typed survives a failed submit.
class AppTextField extends StatelessWidget {
  const AppTextField({
    super.key,
    required this.controller,
    required this.label,
    this.errorText,
    this.hintText,
    this.helperText,
    this.keyboardType,
    this.textInputAction,
    this.onSubmitted,
    this.onChanged,
    this.autofillHints,
    this.inputFormatters,
    this.maxLines = 1,
    this.maxLength,
    this.enabled = true,
    this.forceLtr = false,
    this.textCapitalization = TextCapitalization.none,
    this.prefixIcon,
  });

  final TextEditingController controller;
  final String label;
  final String? errorText;
  final String? hintText;
  final String? helperText;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onSubmitted;
  final ValueChanged<String>? onChanged;
  final Iterable<String>? autofillHints;
  final List<TextInputFormatter>? inputFormatters;
  final int maxLines;
  final int? maxLength;
  final bool enabled;

  /// Email addresses, phone numbers and codes are always typed left-to-right,
  /// also in the Arabic layout.
  final bool forceLtr;
  final TextCapitalization textCapitalization;
  final IconData? prefixIcon;

  @override
  Widget build(BuildContext context) {
    final icon = prefixIcon;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextField(
        controller: controller,
        enabled: enabled,
        keyboardType: keyboardType,
        textInputAction: textInputAction,
        onSubmitted: onSubmitted,
        onChanged: onChanged,
        autofillHints: autofillHints,
        inputFormatters: inputFormatters,
        maxLines: maxLines,
        minLines: maxLines > 1 ? 2 : null,
        maxLength: maxLength,
        textCapitalization: textCapitalization,
        textDirection: forceLtr ? TextDirection.ltr : null,
        decoration: InputDecoration(
          labelText: label,
          hintText: hintText,
          helperText: helperText,
          errorText: errorText,
          prefixIcon: icon == null ? null : Icon(icon),
        ),
      ),
    );
  }
}

/// Password input with a show / hide button.
class PasswordField extends StatefulWidget {
  const PasswordField({
    super.key,
    required this.controller,
    required this.label,
    this.errorText,
    this.helperText,
    this.textInputAction,
    this.onSubmitted,
    this.isNewPassword = false,
  });

  final TextEditingController controller;
  final String label;
  final String? errorText;
  final String? helperText;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onSubmitted;
  final bool isNewPassword;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _hidden = true;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextField(
        controller: widget.controller,
        obscureText: _hidden,
        enableSuggestions: false,
        autocorrect: false,
        textInputAction: widget.textInputAction,
        onSubmitted: widget.onSubmitted,
        textDirection: TextDirection.ltr,
        autofillHints: <String>[widget.isNewPassword ? AutofillHints.newPassword : AutofillHints.password],
        decoration: InputDecoration(
          labelText: widget.label,
          helperText: widget.helperText,
          errorText: widget.errorText,
          prefixIcon: const Icon(PhosphorIconsRegular.lockSimple),
          suffixIcon: IconButton(
            tooltip: _hidden ? l10n.t('commonShowPassword') : l10n.t('commonHidePassword'),
            icon: Icon(_hidden ? PhosphorIconsRegular.eye : PhosphorIconsRegular.eyeSlash),
            onPressed: () => setState(() => _hidden = !_hidden),
          ),
        ),
      ),
    );
  }
}

/// Six-digit code input (email / SMS / authenticator codes).
class CodeField extends StatelessWidget {
  const CodeField({
    super.key,
    required this.controller,
    required this.label,
    this.errorText,
    this.onSubmitted,
    this.digitsOnly = true,
    this.maxLength = 6,
  });

  final TextEditingController controller;
  final String label;
  final String? errorText;
  final ValueChanged<String>? onSubmitted;
  final bool digitsOnly;
  final int maxLength;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextField(
        controller: controller,
        autofocus: true,
        keyboardType: digitsOnly ? TextInputType.number : TextInputType.visiblePassword,
        textInputAction: TextInputAction.done,
        onSubmitted: onSubmitted,
        maxLength: maxLength,
        textAlign: TextAlign.center,
        textDirection: TextDirection.ltr,
        autofillHints: const <String>[AutofillHints.oneTimeCode],
        inputFormatters: digitsOnly ? <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly] : null,
        style: Theme.of(context).textTheme.headlineSmall?.copyWith(letterSpacing: 6),
        decoration: InputDecoration(labelText: label, errorText: errorText, counterText: ''),
      ),
    );
  }
}
