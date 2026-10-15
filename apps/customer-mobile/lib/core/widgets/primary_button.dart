import 'package:flutter/material.dart';

/// The one primary action of a screen. Full width, 54 px high, shows progress
/// and ignores taps while [loading].
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.label, required this.onPressed, this.loading = false, this.icon});

  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final trailing = icon;
    final foreground = FilledButtonTheme.of(context).style?.foregroundColor?.resolve(const <WidgetState>{});
    final Widget content = loading
        ? SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2.4, color: foreground),
          )
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Flexible(child: Text(label, textAlign: TextAlign.center)),
              if (trailing != null) ...<Widget>[const SizedBox(width: 10), Icon(trailing, size: 20)],
            ],
          );
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        // Keeps its colour while loading instead of turning grey.
        onPressed: loading ? () {} : onPressed,
        child: AnimatedSwitcher(duration: const Duration(milliseconds: 180), child: content),
      ),
    );
  }
}
