import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// For screens whose brand header runs under the status bar: once the header
/// has scrolled away, a frosted backdrop fades in behind the clock and the
/// status icons switch from light to dark, so content never collides with them.
class StatusBarBackdrop extends StatefulWidget {
  const StatusBarBackdrop({super.key, required this.child, this.threshold = 140});

  final Widget child;

  /// Scroll offset after which the header is considered gone.
  final double threshold;

  @override
  State<StatusBarBackdrop> createState() => _StatusBarBackdropState();
}

class _StatusBarBackdropState extends State<StatusBarBackdrop> {
  bool _covered = false;

  bool _onScroll(ScrollNotification notification) {
    if (notification.depth == 0 && notification.metrics.axis == Axis.vertical) {
      final covered = notification.metrics.pixels > widget.threshold;
      if (covered != _covered) setState(() => _covered = covered);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final style = _covered && !dark ? SystemUiOverlayStyle.dark : SystemUiOverlayStyle.light;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: style,
      child: NotificationListener<ScrollNotification>(
        onNotification: _onScroll,
        child: Stack(
          children: <Widget>[
            widget.child,
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: MediaQuery.paddingOf(context).top,
              child: IgnorePointer(
                child: AnimatedOpacity(
                  opacity: _covered ? 1 : 0,
                  duration: const Duration(milliseconds: 200),
                  child: ClipRect(
                    child: BackdropFilter(
                      filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
                      child: ColoredBox(color: theme.scaffoldBackgroundColor.withValues(alpha: 0.86)),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
