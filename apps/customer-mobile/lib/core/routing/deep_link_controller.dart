import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'deep_links.dart';

/// Holds the link the app was asked to open until it can be opened (for
/// example after sign-in). The root widget consumes it.
class DeepLinkController extends Notifier<DeepLinkTarget?> {
  @override
  DeepLinkTarget? build() => null;

  /// Parses and stores an incoming URI. Unknown links are ignored.
  void handleUri(Uri uri) {
    final config = ref.read(appConfigProvider);
    final parser = DeepLinkParser(scheme: config.deepLinkScheme, allowedHosts: config.deepLinkHosts);
    final target = parser.parse(uri);
    if (target != null) state = target;
  }

  void open(DeepLinkTarget target) {
    state = target;
  }

  void clear() {
    state = null;
  }
}

final deepLinkControllerProvider = NotifierProvider<DeepLinkController, DeepLinkTarget?>(DeepLinkController.new);
