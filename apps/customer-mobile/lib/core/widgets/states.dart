import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/l10n_ext.dart';
import '../theme/brand_tokens.dart';
import 'feedback.dart';
import 'illustration.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Centred progress indicator with an accessible label.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    final text = label ?? context.l10n.t('commonLoading');
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            SizedBox.square(dimension: 28, child: CircularProgressIndicator(strokeWidth: 2.6, semanticsLabel: text)),
            const SizedBox(height: 14),
            Text(
              text,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: BrandTokens.of(context).mutedText),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Nothing here yet", with an optional next action.
class EmptyStateView extends StatelessWidget {
  const EmptyStateView({super.key, required this.icon, required this.title, this.message, this.action, this.tone});

  final IconData icon;

  /// Colour of the illustration; the brand colour when null.
  final Color? tone;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final text = message;
    final button = action;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            SpotIllustration(icon: icon, size: 168, tone: tone),
            const SizedBox(height: 20),
            Text(title, textAlign: TextAlign.center, style: theme.textTheme.titleLarge),
            if (text != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(text, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText)),
            ],
            if (button != null) ...<Widget>[const SizedBox(height: 24), button],
          ],
        ),
      ),
    );
  }
}

/// A failure with a way forward ("Try again").
class ErrorStateView extends StatelessWidget {
  const ErrorStateView({super.key, required this.error, this.onRetry});

  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final retry = onRetry;
    return EmptyStateView(
      icon: PhosphorIconsRegular.cloudWarning,
      tone: BrandTokens.of(context).danger,
      title: l10n.t('errorTitle'),
      message: describeError(l10n, error),
      action: retry == null
          ? null
          : OutlinedButton.icon(
              onPressed: retry,
              icon: const Icon(PhosphorIconsRegular.arrowClockwise),
              label: Text(l10n.t('commonRetry')),
            ),
    );
  }
}

/// Renders an [AsyncValue]: data when there is any (also while a refresh is
/// running or after a refresh failed), otherwise the error or loading state.
class AsyncValueView<T> extends StatelessWidget {
  const AsyncValueView({super.key, required this.value, required this.data, this.onRetry, this.loading});

  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;
  final Widget? loading;

  @override
  Widget build(BuildContext context) {
    final current = value;
    if (current.hasValue) return data(current.requireValue);
    if (current.hasError) return ErrorStateView(error: current.error!, onRetry: onRetry);
    return loading ?? const LoadingView();
  }
}

/// Pull-to-refresh wrapper whose child can always be dragged, also when the
/// content is shorter than the screen (empty and error states).
class RefreshableList extends StatelessWidget {
  const RefreshableList({super.key, required this.onRefresh, required this.children, this.padding});

  final Future<void> Function() onRefresh;
  final List<Widget> children;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: padding ?? const EdgeInsets.fromLTRB(20, 12, 20, 40),
        children: children,
      ),
    );
  }
}

/// A full-height slot for empty / error states inside a [RefreshableList].
class FillRemainingMessage extends StatelessWidget {
  const FillRemainingMessage({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.of(context).size.height * 0.6;
    return SizedBox(height: height, child: child);
  }
}
