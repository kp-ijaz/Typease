import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../theme/brand_tokens.dart';

/// A spot illustration drawn in code: a gradient badge holding [icon], soft
/// halo rings, and up to three small floating chips with [satellites].
///
/// Drawn rather than bundled so it always takes the centre's own colours
/// (white label) and stays crisp at any size.
class SpotIllustration extends StatelessWidget {
  const SpotIllustration({
    super.key,
    required this.icon,
    this.satellites = const <IconData>[],
    this.size = 220,
    this.tone,
  });

  final IconData icon;
  final List<IconData> satellites;
  final double size;

  /// Main colour; defaults to the centre's brand colour.
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final tokens = BrandTokens.of(context);
    final theme = Theme.of(context);
    final main = tone ?? tokens.brand;
    final deep = Color.lerp(main, Colors.black, 0.32)!;
    final badge = size * 0.42;
    // Chip positions around the badge (fractions of the canvas), start side first.
    const anchors = <Offset>[Offset(0.10, 0.20), Offset(0.80, 0.30), Offset(0.66, 0.80)];

    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          clipBehavior: Clip.none,
          children: <Widget>[
            Positioned.fill(child: CustomPaint(painter: _HaloPainter(color: main, accent: tokens.accent))),
            Center(
              child: Container(
                width: badge,
                height: badge,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(badge * 0.32),
                  gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: <Color>[main, deep]),
                  boxShadow: <BoxShadow>[
                    BoxShadow(color: main.withValues(alpha: 0.35), blurRadius: 28, offset: const Offset(0, 14)),
                  ],
                ),
                child: Icon(icon, size: badge * 0.46, color: tokens.onBrand),
              ),
            ),
            for (var i = 0; i < math.min(satellites.length, anchors.length); i++)
              PositionedDirectional(
                start: anchors[i].dx * size - 22,
                top: anchors[i].dy * size - 22,
                child: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surface,
                    borderRadius: BorderRadius.circular(AppTheme.radiusMd),
                    border: Border.all(color: tokens.border),
                    boxShadow: AppTheme.softShadow(context),
                  ),
                  child: Icon(satellites[i], size: 22, color: i.isEven ? main : tokens.accent),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _HaloPainter extends CustomPainter {
  _HaloPainter({required this.color, required this.accent});

  final Color color;
  final Color accent;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide / 2;
    canvas.drawCircle(center, radius * 0.98, Paint()..color = color.withValues(alpha: 0.06));
    canvas.drawCircle(center, radius * 0.72, Paint()..color = color.withValues(alpha: 0.08));
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = color.withValues(alpha: 0.16);
    canvas.drawCircle(center, radius * 0.86, ring);
    // A few sparkles.
    final dot = Paint()..color = accent.withValues(alpha: 0.7);
    canvas.drawCircle(center + Offset(radius * 0.62, -radius * 0.70), 4, dot);
    canvas.drawCircle(center + Offset(-radius * 0.78, radius * 0.46), 3, dot..color = color.withValues(alpha: 0.45));
    canvas.drawCircle(center + Offset(radius * 0.20, radius * 0.92), 2.5, dot..color = accent.withValues(alpha: 0.5));
  }

  @override
  bool shouldRepaint(_HaloPainter oldDelegate) => oldDelegate.color != color || oldDelegate.accent != accent;
}

/// Decorative soft circles for the corners of brand-coloured hero panels.
class HeroDecoration extends StatelessWidget {
  const HeroDecoration({super.key, required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Stack(
        children: <Widget>[
          PositionedDirectional(
            end: -60,
            top: -70,
            child: _circle(220, color.withValues(alpha: 0.10)),
          ),
          PositionedDirectional(
            end: 40,
            top: 60,
            child: _circle(90, color.withValues(alpha: 0.08)),
          ),
          PositionedDirectional(
            start: -40,
            bottom: -80,
            child: _circle(180, color.withValues(alpha: 0.06)),
          ),
        ],
      ),
    );
  }

  Widget _circle(double size, Color fill) =>
      Container(width: size, height: size, decoration: BoxDecoration(shape: BoxShape.circle, color: fill));
}
