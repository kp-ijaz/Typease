import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/core/network/api_client.dart';
import 'package:typease_customer/core/network/session_manager.dart';
import 'package:typease_customer/core/storage/token_store.dart';
import 'package:typease_customer/features/catalogue/data/catalogue_repository.dart';

import '../support/fake_adapter.dart';
import '../support/fixtures.dart';

void main() {
  late FakeAdapter adapter;
  late ApiClient client;

  setUp(() {
    adapter = FakeAdapter((request) {
      if (request.path.contains('/public/services/')) return FakeResponse(200, fixture('public_service_detail'));
      if (request.path.endsWith('/public/services')) return FakeResponse(200, fixture('public_catalogue'));
      return const FakeResponse(401, <String, dynamic>{'code': 'TOKEN_INVALID'});
    });
    client = ApiClient(
      baseUrl: 'https://api.example.test/api/v1',
      session: SessionManager(MemoryTokenStore()),
      languageCode: () => 'en',
      adapter: adapter,
    );
  });

  test('a guest reads the public catalogue of the chosen centre, without a token', () async {
    final catalogue = await CatalogueRepository(client, guestSlug: 'mobile-fixture').fetch(query: 'typing');
    expect(catalogue.services, isNotEmpty);
    final request = adapter.requests.single;
    expect(request.path, endsWith('/public/services'));
    expect(request.authorization, isNull);
  });

  test('a guest opens a service from the public detail (wrapped in {centre, service})', () async {
    final service = await CatalogueRepository(client, guestSlug: 'mobile-fixture').service('svc-1');
    expect(service.name, 'Tenancy contract typing');
    expect(service.requirements, hasLength(3));
    expect(service.price!.total, '78.75');
    expect(adapter.requests.single.path, endsWith('/public/services/svc-1'));
  });
}
