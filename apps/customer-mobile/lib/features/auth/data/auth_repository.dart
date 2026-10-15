import 'dart:io' show Platform;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';
import 'auth_models.dart';

/// Calls of the Authentication module. Every sign-in call sends `app: "mobile"`
/// so that the refresh token is returned in the response body.
class AuthRepository {
  AuthRepository(this._api);

  final ApiClient _api;

  static const String _app = 'mobile';

  /// Shown to the user in "Active sessions". No device identifiers are sent.
  static String deviceName() {
    try {
      if (Platform.isAndroid) return 'Android app';
      if (Platform.isIOS) return 'iPhone / iPad app';
    } catch (_) {
      // Platform is unavailable in some test environments.
    }
    return 'Mobile app';
  }

  /// `POST /auth/login`
  Future<LoginResult> login({required String email, required String password, required String tenantSlug}) async {
    final json = await _api.post(
      '/auth/login',
      auth: false,
      body: <String, dynamic>{
        'email': email.trim().toLowerCase(),
        'password': password,
        'app': _app,
        'tenantSlug': tenantSlug,
        'deviceName': deviceName(),
      },
    );
    return LoginResult.fromJson(json);
  }

  /// `POST /auth/otp/request`. The answer is the same whether or not the
  /// number is registered.
  Future<DeliveryAck> requestOtp({required String phone, required String tenantSlug}) async {
    final json = await _api.post(
      '/auth/otp/request',
      auth: false,
      body: <String, dynamic>{'phone': phone, 'app': _app, 'tenantSlug': tenantSlug},
    );
    return DeliveryAck.fromJson(json);
  }

  /// `POST /auth/otp/verify`
  Future<LoginResult> verifyOtp({required String phone, required String code, required String tenantSlug}) async {
    final json = await _api.post(
      '/auth/otp/verify',
      auth: false,
      body: <String, dynamic>{
        'phone': phone,
        'code': code,
        'app': _app,
        'tenantSlug': tenantSlug,
        'deviceName': deviceName(),
      },
    );
    return LoginResult.fromJson(json);
  }

  /// `POST /auth/mfa/verify`
  Future<LoginResult> verifyMfa({required String challengeToken, required String code}) async {
    final json = await _api.post(
      '/auth/mfa/verify',
      auth: false,
      body: <String, dynamic>{'challengeToken': challengeToken, 'code': code.trim()},
    );
    return LoginResult.fromJson(json);
  }

  /// `POST /auth/select-tenant`
  Future<LoginResult> selectTenant({required String selectionToken, required String membershipId}) async {
    final json = await _api.post(
      '/auth/select-tenant',
      auth: false,
      body: <String, dynamic>{'selectionToken': selectionToken, 'membershipId': membershipId},
    );
    return LoginResult.fromJson(json);
  }

  /// `POST /auth/register`
  Future<DeliveryAck> register({
    required String tenantSlug,
    required String fullName,
    required String email,
    required String password,
    required String preferredLanguage,
    required bool marketingOptIn,
    String? phone,
  }) async {
    final body = <String, dynamic>{
      'tenantSlug': tenantSlug,
      'fullName': fullName.trim(),
      'email': email.trim().toLowerCase(),
      'password': password,
      'preferredLanguage': preferredLanguage,
      'acceptTerms': true,
      'marketingOptIn': marketingOptIn,
    };
    if (phone != null && phone.isNotEmpty) body['phone'] = phone;
    final json = await _api.post('/auth/register', auth: false, body: body);
    return DeliveryAck.fromJson(json);
  }

  /// `POST /auth/verify-email`
  Future<void> verifyEmail(String token) async {
    await _api.post('/auth/verify-email', auth: false, body: <String, dynamic>{'token': token});
  }

  /// `POST /auth/resend-verification`
  Future<DeliveryAck> resendVerification(String email) async {
    final json = await _api.post(
      '/auth/resend-verification',
      auth: false,
      body: <String, dynamic>{'email': email.trim().toLowerCase()},
    );
    return DeliveryAck.fromJson(json);
  }

  /// `POST /auth/password/forgot`
  Future<DeliveryAck> forgotPassword({required String email, required String tenantSlug}) async {
    final json = await _api.post(
      '/auth/password/forgot',
      auth: false,
      body: <String, dynamic>{'email': email.trim().toLowerCase(), 'app': _app, 'tenantSlug': tenantSlug},
    );
    return DeliveryAck.fromJson(json);
  }

  /// `POST /auth/password/reset`
  Future<void> resetPassword({required String token, required String password}) async {
    await _api.post('/auth/password/reset', auth: false, body: <String, dynamic>{'token': token, 'password': password});
  }

  /// `GET /auth/invitations/preview?token=`
  Future<InvitationPreview> previewInvitation(String token) async {
    final json = await _api.get('/auth/invitations/preview', auth: false, query: <String, dynamic>{'token': token});
    return InvitationPreview.fromJson(json);
  }

  /// `POST /auth/invitations/accept`
  Future<LoginResult> acceptInvitation({required String token, String? fullName, String? password}) async {
    final body = <String, dynamic>{'token': token, 'app': _app};
    if (fullName != null && fullName.trim().isNotEmpty) body['fullName'] = fullName.trim();
    if (password != null && password.isNotEmpty) body['password'] = password;
    final json = await _api.post('/auth/invitations/accept', auth: false, body: body);
    return LoginResult.fromJson(json);
  }

  /// `POST /auth/logout`. Best effort: the local session is cleared anyway.
  Future<void> logout(String refreshToken) async {
    await _api.post('/auth/logout', auth: false, body: <String, dynamic>{'refreshToken': refreshToken, 'app': _app});
  }

  /// `GET /auth/me`
  Future<SessionInfo> me() async => SessionInfo.fromJson(await _api.get('/auth/me'));

  /// `PATCH /auth/me`
  Future<void> updateAccount({String? fullName, String? preferredLanguage}) async {
    final body = <String, dynamic>{};
    if (fullName != null) body['fullName'] = fullName.trim();
    if (preferredLanguage != null) body['preferredLanguage'] = preferredLanguage;
    if (body.isEmpty) return;
    await _api.patch('/auth/me', body: body);
  }

  /// `POST /auth/password/change`
  Future<void> changePassword({required String currentPassword, required String newPassword}) async {
    await _api.post(
      '/auth/password/change',
      body: <String, dynamic>{'currentPassword': currentPassword, 'newPassword': newPassword},
    );
  }

  /// `POST /auth/phone/request-verification`
  Future<DeliveryAck> requestPhoneVerification(String phone) async {
    final json = await _api.post('/auth/phone/request-verification', body: <String, dynamic>{'phone': phone});
    return DeliveryAck.fromJson(json);
  }

  /// `POST /auth/phone/verify`
  Future<void> verifyPhone({required String phone, required String code}) async {
    await _api.post('/auth/phone/verify', body: <String, dynamic>{'phone': phone, 'code': code});
  }

  /// `GET /auth/sessions`
  Future<List<AuthSession>> sessions() async {
    final json = await _api.get('/auth/sessions');
    return asMapList(json).map(AuthSession.fromJson).toList(growable: false);
  }

  /// `DELETE /auth/sessions/:id`
  Future<void> revokeSession(String id) async {
    await _api.delete('/auth/sessions/$id');
  }

  /// `POST /auth/sessions/revoke-others`
  Future<int> revokeOtherSessions() async {
    final json = await _api.post('/auth/sessions/revoke-others');
    return asInt(asMap(json)['revoked']);
  }
}

final authRepositoryProvider = Provider<AuthRepository>((ref) => AuthRepository(ref.watch(apiClientProvider)));
