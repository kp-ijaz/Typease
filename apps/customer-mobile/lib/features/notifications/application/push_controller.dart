import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers.dart';
import '../../../core/routing/deep_link_controller.dart';
import '../../../core/routing/deep_links.dart';
import '../../../core/storage/prefs_keys.dart';
import '../../auth/application/auth_controller.dart';
import '../data/notifications_repository.dart';
import 'inbox_controller.dart';

@immutable
class PushState {
  const PushState({required this.configured, this.registered = false, this.permissionDenied = false});

  /// False when the build has no Firebase configuration. Push is then simply
  /// absent; the in-app inbox works all the same.
  final bool configured;

  /// The device token is registered with the API for the signed-in user.
  final bool registered;
  final bool permissionDenied;

  PushState copyWith({bool? registered, bool? permissionDenied}) {
    return PushState(
      configured: configured,
      registered: registered ?? this.registered,
      permissionDenied: permissionDenied ?? this.permissionDenied,
    );
  }
}

/// Push notifications through Firebase Cloud Messaging.
///
/// Everything here is optional: Firebase is initialised only when the build
/// was made with `--dart-define=FIREBASE_ENABLED=true`, and every failure is
/// swallowed so that the app runs without push.
class PushController extends Notifier<PushState> {
  final List<StreamSubscription<dynamic>> _subscriptions = <StreamSubscription<dynamic>>[];
  bool _initialised = false;
  bool _listening = false;

  @override
  PushState build() {
    final config = ref.watch(appConfigProvider);
    ref.onDispose(() {
      for (final subscription in _subscriptions) {
        unawaited(subscription.cancel());
      }
      _subscriptions.clear();
    });
    // Register when the user signs in (also when a session is restored).
    ref.listen<AuthState>(authControllerProvider, (previous, next) {
      final wasSignedIn = previous?.isSignedIn ?? false;
      if (next.isSignedIn && !wasSignedIn) {
        unawaited(registerDevice());
      }
    });
    return PushState(configured: config.firebaseEnabled);
  }

  Future<bool> _ensureFirebase() async {
    if (_initialised) return true;
    final config = ref.read(appConfigProvider);
    if (!config.firebaseEnabled) return false;
    try {
      if (Firebase.apps.isEmpty) {
        if (config.hasExplicitFirebaseOptions) {
          await Firebase.initializeApp(
            options: FirebaseOptions(
              apiKey: config.firebaseApiKey,
              appId: config.firebaseAppId,
              messagingSenderId: config.firebaseMessagingSenderId,
              projectId: config.firebaseProjectId,
            ),
          );
        } else {
          // Uses google-services.json / GoogleService-Info.plist.
          await Firebase.initializeApp();
        }
      }
      _initialised = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Asks for permission, obtains the device token and registers it with
  /// `POST /me/devices`. Safe to call repeatedly.
  Future<void> registerDevice() async {
    if (!await _ensureFirebase()) return;
    try {
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission();
      final status = settings.authorizationStatus;
      if (status != AuthorizationStatus.authorized && status != AuthorizationStatus.provisional) {
        state = state.copyWith(permissionDenied: true, registered: false);
        return;
      }
      await messaging.setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);
      _listen(messaging);
      final token = await messaging.getToken();
      if (token != null && token.isNotEmpty) {
        await _register(token);
      }
    } catch (_) {
      // No push on this device (for example an emulator without Play services).
    }
  }

  Future<void> _register(String token) async {
    if (!ref.read(authControllerProvider).isSignedIn) return;
    try {
      await ref.read(notificationsRepositoryProvider).registerDevice(token: token, platform: _platform());
      await ref.read(sharedPreferencesProvider).setString(PrefsKeys.pushDeviceToken, token);
      state = state.copyWith(registered: true, permissionDenied: false);
    } catch (_) {
      // Tried again on the next start or token refresh.
    }
  }

  /// Removes this device's token from the server (`DELETE /me/devices`).
  /// Called before sign-out, while the session is still valid.
  Future<void> unregisterDevice() async {
    final prefs = ref.read(sharedPreferencesProvider);
    final token = prefs.getString(PrefsKeys.pushDeviceToken);
    if (token == null || token.isEmpty) return;
    try {
      await ref.read(notificationsRepositoryProvider).removeDevice(token);
    } catch (_) {
      // The server also drops tokens that Firebase reports as unregistered.
    }
    await prefs.remove(PrefsKeys.pushDeviceToken);
    state = state.copyWith(registered: false);
  }

  void _listen(FirebaseMessaging messaging) {
    if (_listening) return;
    _listening = true;
    _subscriptions.add(messaging.onTokenRefresh.listen((token) => unawaited(_register(token))));
    // A message while the app is open: refresh the bell and the inbox.
    _subscriptions.add(FirebaseMessaging.onMessage.listen((message) {
      ref.invalidate(unreadCountProvider);
      ref.invalidate(inboxProvider);
    }));
    // The user tapped a notification while the app was in the background.
    _subscriptions.add(FirebaseMessaging.onMessageOpenedApp.listen((message) => unawaited(_open(message.data))));
    // The app was started by tapping a notification.
    unawaited(_openInitial(messaging));
  }

  Future<void> _openInitial(FirebaseMessaging messaging) async {
    try {
      final message = await messaging.getInitialMessage();
      if (message != null) await _open(message.data);
    } catch (_) {
      // Nothing to open.
    }
  }

  /// Opens the screen a tapped notification refers to.
  ///
  /// The API currently puts only `notificationId` into the push payload, so
  /// the target is looked up in the inbox. `relatedType` / `relatedId` are
  /// used directly should a later server version send them.
  Future<void> _open(Map<String, dynamic> data) async {
    final links = ref.read(deepLinkControllerProvider.notifier);
    final direct = DeepLinkTarget.fromRelated(data['relatedType']?.toString(), data['relatedId']?.toString());
    if (direct != null) {
      links.open(direct);
      return;
    }
    final notificationId = data['notificationId']?.toString();
    if (notificationId != null && notificationId.isNotEmpty) {
      try {
        final inbox = await ref.read(notificationsRepositoryProvider).inbox(pageSize: 30);
        for (final item in inbox.items) {
          if (item.id != notificationId) continue;
          final target = DeepLinkTarget.fromRelated(item.relatedType, item.relatedId);
          if (target != null) {
            links.open(target);
            return;
          }
        }
      } catch (_) {
        // Fall through to the inbox.
      }
    }
    links.open(const DeepLinkTarget(kind: DeepLinkKind.notifications));
  }

  static String _platform() {
    try {
      if (Platform.isIOS) return 'ios';
    } catch (_) {
      // Not available in some test environments.
    }
    return 'android';
  }
}

final pushControllerProvider = NotifierProvider<PushController, PushState>(PushController.new);
