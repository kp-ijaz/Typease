import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';
import '../../auth/application/auth_controller.dart';
import '../../tenant/application/tenant_controller.dart';
import 'catalogue_models.dart';

class CatalogueRepository {
  CatalogueRepository(this._api, {this.guestSlug});

  final ApiClient _api;

  /// Set while nobody is signed in: the public catalogue of this centre is
  /// used instead (`GET /public/services?slug=`; fees are estimates).
  final String? guestSlug;

  /// `GET /catalogue?categoryKey=&q=`
  Future<Catalogue> fetch({String? categoryKey, String? query}) async {
    final slug = guestSlug;
    final json = slug != null
        ? await _api.get(
            '/public/services',
            query: <String, dynamic>{'slug': slug, 'categoryKey': categoryKey, 'q': query},
            auth: false,
          )
        : await _api.get('/catalogue', query: <String, dynamic>{'categoryKey': categoryKey, 'q': query});
    return Catalogue.fromJson(json);
  }

  /// `GET /catalogue/:id`
  Future<CatalogueService> service(String id) async {
    final slug = guestSlug;
    if (slug != null) {
      // The public answer wraps the service: `{centre, service}`.
      final json = asMap(await _api.get('/public/services/$id', query: <String, dynamic>{'slug': slug}, auth: false));
      return CatalogueService.fromJson(json['service']);
    }
    return CatalogueService.fromJson(await _api.get('/catalogue/$id'));
  }
}

final catalogueRepositoryProvider = Provider<CatalogueRepository>((ref) {
  final signedIn = ref.watch(authControllerProvider.select((auth) => auth.isSignedIn));
  final slug = ref.watch(tenantControllerProvider.select((tenant) => tenant?.slug));
  return CatalogueRepository(ref.watch(apiClientProvider), guestSlug: signedIn ? null : slug);
});
