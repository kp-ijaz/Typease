import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/catalogue_models.dart';
import '../data/catalogue_repository.dart';

/// Search text and category of the catalogue screen.
@immutable
class CatalogueFilter {
  const CatalogueFilter({this.categoryKey, this.query = ''});

  final String? categoryKey;
  final String query;

  @override
  bool operator ==(Object other) {
    return other is CatalogueFilter && other.categoryKey == categoryKey && other.query == query;
  }

  @override
  int get hashCode => Object.hash(categoryKey, query);
}

/// The whole catalogue (categories with counts and all requestable services).
/// Used by Home for the category tiles and by the search.
final catalogueProvider = FutureProvider.autoDispose<Catalogue>((ref) {
  return ref.watch(catalogueRepositoryProvider).fetch();
});

/// The catalogue narrowed by category and / or search text (server-side).
final filteredCatalogueProvider = FutureProvider.autoDispose.family<Catalogue, CatalogueFilter>((ref, filter) {
  final query = filter.query.trim();
  return ref.watch(catalogueRepositoryProvider).fetch(
        categoryKey: filter.categoryKey,
        query: query.isEmpty ? null : query,
      );
});

final serviceDetailProvider = FutureProvider.autoDispose.family<CatalogueService, String>((ref, id) {
  return ref.watch(catalogueRepositoryProvider).service(id);
});
