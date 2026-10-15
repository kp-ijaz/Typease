import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../theme/app_theme.dart';
import '../theme/brand_tokens.dart';

/// The centre's logo when it has one, otherwise a monogram tile and its name.
///
/// No image of any centre is bundled with the app; the logo URL comes from
/// the tenant configuration. While it loads, or if it cannot be loaded, the
/// monogram is shown instead.
class BrandLogo extends StatelessWidget {
  const BrandLogo({super.key, required this.name, this.logoUrl, this.height = 40, this.onBrand = false, this.showName = true});

  final String name;
  final String? logoUrl;
  final double height;

  /// True when drawn on the brand-coloured header.
  final bool onBrand;

  /// False to show only the logo / monogram.
  final bool showName;

  @override
  Widget build(BuildContext context) {
    final url = logoUrl;
    final fallback = _Monogram(name: name, height: height, onBrand: onBrand, showName: showName);
    if (url == null || url.isEmpty) return Semantics(header: true, child: fallback);
    return Semantics(
      image: true,
      label: name,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(height * 0.22),
        child: Image.network(
          url,
          height: height,
          fit: BoxFit.contain,
          excludeFromSemantics: true,
          errorBuilder: (context, error, stackTrace) => fallback,
          loadingBuilder: (context, child, progress) => progress == null ? child : fallback,
        ),
      ),
    );
  }
}

class _Monogram extends StatelessWidget {
  const _Monogram({required this.name, required this.height, required this.onBrand, required this.showName});

  final String name;
  final double height;
  final bool onBrand;
  final bool showName;

  String get _initials {
    final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return '';
    final first = words.first.characters.first;
    final second = words.length > 1 ? words[1].characters.first : '';
    return (first + second).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final textColor = onBrand ? tokens.onBrand : theme.colorScheme.onSurface;
    final tile = Container(
      width: height,
      height: height,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(height * 0.28),
        gradient: onBrand ? null : tokens.brandGradient,
        color: onBrand ? tokens.onBrand.withValues(alpha: 0.16) : null,
        border: onBrand ? Border.all(color: tokens.onBrand.withValues(alpha: 0.28)) : null,
      ),
      child: Text(
        _initials,
        style: theme.textTheme.titleMedium?.copyWith(
          color: tokens.onBrand,
          fontSize: height * 0.36,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
          height: 1,
        ),
      ),
    );
    if (!showName) return tile;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        tile,
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.titleMedium?.copyWith(color: textColor, fontWeight: FontWeight.w800, letterSpacing: -0.2),
          ),
        ),
      ],
    );
  }
}

/// The centre's logo on a white rounded tile, for brand-coloured headers
/// where a logo with a transparent background would otherwise disappear.
class BrandLogoTile extends StatelessWidget {
  const BrandLogoTile({super.key, required this.name, this.logoUrl, this.size = 56});

  final String name;
  final String? logoUrl;
  final double size;

  @override
  Widget build(BuildContext context) {
    final url = logoUrl;
    if (url == null || url.isEmpty) return BrandLogo(name: name, height: size, showName: false, onBrand: true);
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(size * 0.12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(AppTheme.radiusMd + 2),
        boxShadow: <BoxShadow>[BoxShadow(color: Colors.black.withValues(alpha: 0.12), blurRadius: 18, offset: const Offset(0, 8))],
      ),
      child: BrandLogo(name: name, logoUrl: url, height: size * 0.76, showName: false),
    );
  }
}

/// The TypEase logo itself (vector, from packages/branding), for everything
/// shown before a centre is chosen: onboarding, the guest showcase, splash.
class TypEaseLogo extends StatelessWidget {
  const TypEaseLogo({super.key, this.height = 36, this.onDark = false, this.markOnly = false});

  final double height;

  /// White word mark, for brand-coloured backgrounds.
  final bool onDark;

  /// Only the "TD" document mark, without the word.
  final bool markOnly;

  @override
  Widget build(BuildContext context) {
    final name = markOnly
        ? (onDark ? 'typease-mark-on-dark' : 'typease-mark')
        : (onDark ? 'typease-logo-on-dark' : 'typease-logo');
    return SvgPicture.asset('assets/brand/$name.svg', height: height, semanticsLabel: 'TypEase');
  }
}
