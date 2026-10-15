import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/profile_models.dart';
import '../data/profile_repository.dart';

final profileProvider = FutureProvider.autoDispose<CustomerProfile>((ref) {
  return ref.watch(profileRepositoryProvider).profile();
});

final consentsProvider = FutureProvider.autoDispose<List<ConsentState>>((ref) {
  return ref.watch(profileRepositoryProvider).consents();
});

final privacyRequestsProvider = FutureProvider.autoDispose<List<PrivacyRequest>>((ref) {
  return ref.watch(profileRepositoryProvider).privacyRequests();
});
