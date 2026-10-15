import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/page.dart';
import '../data/request_models.dart';
import '../data/requests_repository.dart';

/// The two tabs of the history screen.
enum RequestFilter { active, completed }

/// The selected tab.
final requestFilterProvider = StateProvider.autoDispose<RequestFilter>((ref) => RequestFilter.active);

/// A loaded list with "load more".
class PagedList<T> {
  const PagedList({required this.items, required this.page, required this.totalPages, required this.total});

  factory PagedList.first(Page<T> page) {
    return PagedList<T>(items: page.items, page: page.page, totalPages: page.totalPages, total: page.total);
  }

  final List<T> items;
  final int page;
  final int totalPages;
  final int total;

  bool get hasMore => page < totalPages;

  PagedList<T> append(Page<T> next) {
    return PagedList<T>(
      items: <T>[...items, ...next.items],
      page: next.page,
      totalPages: next.totalPages,
      total: next.total,
    );
  }
}

/// The customer's requests for the selected tab.
class RequestListController extends AutoDisposeAsyncNotifier<PagedList<RequestSummary>> {
  static const int _pageSize = 20;

  bool _loadingMore = false;

  List<String> _statuses(RequestFilter filter) {
    return filter == RequestFilter.active ? kActiveRequestStatuses : kClosedRequestStatuses;
  }

  @override
  Future<PagedList<RequestSummary>> build() async {
    final filter = ref.watch(requestFilterProvider);
    final page = await ref.watch(requestsRepositoryProvider).list(statuses: _statuses(filter), pageSize: _pageSize);
    return PagedList<RequestSummary>.first(page);
  }

  /// Appends the next page. Errors are rethrown for the caller to show; the
  /// rows already loaded stay on screen.
  Future<void> loadMore() async {
    final current = state.valueOrNull;
    if (current == null || !current.hasMore || _loadingMore) return;
    _loadingMore = true;
    try {
      final filter = ref.read(requestFilterProvider);
      final next = await ref.read(requestsRepositoryProvider).list(
            statuses: _statuses(filter),
            page: current.page + 1,
            pageSize: _pageSize,
          );
      state = AsyncData<PagedList<RequestSummary>>(current.append(next));
    } finally {
      _loadingMore = false;
    }
  }
}

final requestListProvider =
    AsyncNotifierProvider.autoDispose<RequestListController, PagedList<RequestSummary>>(RequestListController.new);

/// Numbers for the home screen.
final requestCountsProvider = FutureProvider.autoDispose<RequestCounts>((ref) {
  return ref.watch(requestsRepositoryProvider).counts();
});

/// The newest active requests (home screen summary).
final activeRequestsProvider = FutureProvider.autoDispose<List<RequestSummary>>((ref) async {
  final page = await ref.watch(requestsRepositoryProvider).list(statuses: kActiveRequestStatuses, pageSize: 5);
  return page.items;
});

/// Requests that wait for the customer (home screen "needs your action").
final actionRequestsProvider = FutureProvider.autoDispose<List<RequestSummary>>((ref) async {
  final page = await ref.watch(requestsRepositoryProvider).list(
        statuses: const <String>['AWAITING_CUSTOMER', 'QUOTED', 'AWAITING_PAYMENT'],
        pageSize: 10,
      );
  return page.items;
});

/// One request, by id.
final requestDetailProvider = FutureProvider.autoDispose.family<RequestDetail, String>((ref, id) {
  return ref.watch(requestsRepositoryProvider).detail(id);
});
