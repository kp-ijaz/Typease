import 'package:flutter/material.dart';

import '../errors/api_exception.dart';
import '../l10n/app_localizations.dart';
import '../l10n/l10n_ext.dart';
import '../theme/brand_tokens.dart';

/// Turns any error into one plain-language sentence for the user.
///
/// Server messages are already written for end users and are shown as they
/// are. Transport failures have no server message, so the app supplies one.
String describeError(AppLocalizations l10n, Object error) {
  if (error is ApiException) {
    switch (error.kind) {
      case ApiErrorKind.network:
        return error.code == 'BAD_CERTIFICATE' ? l10n.t('errorSecureConnection') : l10n.t('errorNoConnection');
      case ApiErrorKind.timeout:
        return l10n.t('errorTimeout');
      case ApiErrorKind.cancelled:
        return l10n.t('errorCancelled');
      case ApiErrorKind.rateLimited:
        return error.message.isNotEmpty ? error.message : l10n.t('errorRateLimited');
      case ApiErrorKind.server:
        return error.message.isNotEmpty ? error.message : l10n.t('errorServer');
      case ApiErrorKind.unauthorized:
        if (error.isSessionExpired) return l10n.t('errorSessionExpired');
        return error.message.isNotEmpty ? error.message : l10n.t('errorUnknown');
      case ApiErrorKind.forbidden:
      case ApiErrorKind.notFound:
      case ApiErrorKind.validation:
      case ApiErrorKind.conflict:
      case ApiErrorKind.unknown:
        return error.message.isNotEmpty ? error.message : l10n.t('errorUnknown');
    }
  }
  return l10n.t('errorUnknown');
}

void showMessage(BuildContext context, String message, {bool isError = false}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  final tokens = BrandTokens.of(context);
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? tokens.danger : null,
        duration: Duration(seconds: isError ? 6 : 4),
      ),
    );
}

void showError(BuildContext context, Object error) {
  showMessage(context, describeError(context.l10n, error), isError: true);
}

/// Asks before a destructive or irreversible action. Returns true on confirm.
Future<bool> showConfirmDialog(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final l10n = context.l10n;
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      final scheme = Theme.of(dialogContext).colorScheme;
      return AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.t('commonCancel')),
          ),
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError)
                : null,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      );
    },
  );
  return result ?? false;
}

/// Asks for a short text (a reason, a note). Returns null when cancelled.
Future<String?> showTextInputDialog(
  BuildContext context, {
  required String title,
  required String fieldLabel,
  required String confirmLabel,
  String? message,
  int minLength = 0,
  int maxLength = 500,
  bool destructive = false,
}) {
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => _TextInputDialog(
      title: title,
      message: message,
      fieldLabel: fieldLabel,
      confirmLabel: confirmLabel,
      minLength: minLength,
      maxLength: maxLength,
      destructive: destructive,
    ),
  );
}

class _TextInputDialog extends StatefulWidget {
  const _TextInputDialog({
    required this.title,
    required this.fieldLabel,
    required this.confirmLabel,
    required this.minLength,
    required this.maxLength,
    required this.destructive,
    this.message,
  });

  final String title;
  final String? message;
  final String fieldLabel;
  final String confirmLabel;
  final int minLength;
  final int maxLength;
  final bool destructive;

  @override
  State<_TextInputDialog> createState() => _TextInputDialogState();
}

class _TextInputDialogState extends State<_TextInputDialog> {
  final TextEditingController _controller = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final value = _controller.text.trim();
    if (value.length < widget.minLength) {
      setState(() {
        _error = context.l10n.t('validationMinLength', <String, Object?>{'count': widget.minLength});
      });
      return;
    }
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final scheme = Theme.of(context).colorScheme;
    final message = widget.message;
    return AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (message != null) ...<Widget>[Text(message), const SizedBox(height: 12)],
            TextField(
              controller: _controller,
              autofocus: true,
              minLines: 2,
              maxLines: 4,
              maxLength: widget.maxLength,
              decoration: InputDecoration(labelText: widget.fieldLabel, errorText: _error),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(l10n.t('commonCancel'))),
        FilledButton(
          style: widget.destructive
              ? FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError)
              : null,
          onPressed: _submit,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
