import 'package:flutter/widgets.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Maps the icon names a centre can choose for its service categories (the
/// names of the web icon set, e.g. `file-text`) to Phosphor icons.
IconData categoryIcon(String? name) {
  switch (name) {
    case 'file-text':
      return PhosphorIconsRegular.fileText;
    case 'plane':
      return PhosphorIconsRegular.airplaneTilt;
    case 'home':
      return PhosphorIconsRegular.houseLine;
    case 'id-card':
      return PhosphorIconsRegular.identificationCard;
    case 'briefcase':
      return PhosphorIconsRegular.briefcase;
    case 'building':
      return PhosphorIconsRegular.buildings;
    case 'stamp':
      return PhosphorIconsRegular.stamp;
    case 'badge-check':
      return PhosphorIconsRegular.sealCheck;
    case 'languages':
      return PhosphorIconsRegular.translate;
    case 'printer':
      return PhosphorIconsRegular.printer;
    case 'folder':
      return PhosphorIconsRegular.folder;
    case 'star':
      return PhosphorIconsRegular.star;
    default:
      return PhosphorIconsRegular.squaresFour;
  }
}
