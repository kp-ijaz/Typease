import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';
import 'profile_models.dart';

class ProfileRepository {
  ProfileRepository(this._api);

  final ApiClient _api;

  /// `GET /me/customer`
  Future<CustomerProfile> profile() async => CustomerProfile.fromJson(await _api.get('/me/customer'));

  /// `PATCH /me/customer` - only name, Arabic name, language, address and
  /// communication preferences can be changed by the customer.
  Future<CustomerProfile> update({
    String? fullName,
    String? fullNameAr,
    String? preferredLanguage,
    PostalAddress? address,
    Map<String, bool>? communicationPrefs,
  }) async {
    final body = <String, dynamic>{};
    if (fullName != null) body['fullName'] = fullName.trim();
    if (fullNameAr != null) body['fullNameAr'] = fullNameAr.trim();
    if (preferredLanguage != null) body['preferredLanguage'] = preferredLanguage;
    if (address != null) body['address'] = address.isEmpty ? null : address.toJson();
    if (communicationPrefs != null) body['communicationPrefs'] = communicationPrefs;
    return CustomerProfile.fromJson(await _api.patch('/me/customer', body: body));
  }

  /// `GET /me/consents`
  Future<List<ConsentState>> consents() async {
    final json = await _api.get('/me/consents');
    return asMapList(asMap(json)['consents']).map(ConsentState.fromJson).toList(growable: false);
  }

  /// `PUT /me/consents`
  Future<List<ConsentState>> saveConsent({required String purpose, required bool granted}) async {
    final json = await _api.put(
      '/me/consents',
      body: <String, dynamic>{
        'consents': <Map<String, dynamic>>[
          <String, dynamic>{'purpose': purpose, 'granted': granted},
        ],
      },
    );
    return asMapList(asMap(json)['consents']).map(ConsentState.fromJson).toList(growable: false);
  }

  /// `GET /privacy/my/requests`
  Future<List<PrivacyRequest>> privacyRequests() async {
    final json = await _api.get('/privacy/my/requests');
    return asMapList(json).map(PrivacyRequest.fromJson).toList(growable: false);
  }

  /// `POST /privacy/my/requests`
  Future<PrivacyRequest> createPrivacyRequest({required String type, String? details}) async {
    final body = <String, dynamic>{'type': type};
    if (details != null && details.trim().isNotEmpty) body['details'] = details.trim();
    return PrivacyRequest.fromJson(await _api.post('/privacy/my/requests', body: body));
  }
}

final profileRepositoryProvider = Provider<ProfileRepository>((ref) => ProfileRepository(ref.watch(apiClientProvider)));
