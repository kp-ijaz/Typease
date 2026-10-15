import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/states.dart';
import '../application/requests_providers.dart';
import '../data/request_models.dart';
import 'request_card.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Request history ("My requests") with two filters: active and completed.
class RequestHistoryScreen extends ConsumerStatefulWidget {
  const RequestHistoryScreen({super.key});

  @override
  ConsumerState<RequestHistoryScreen> createState() => _RequestHistoryScreenState();
}

class _RequestHistoryScreenState extends ConsumerState<RequestHistoryScreen> {
  bool _loadingMore = false;

  Future<void> _refresh() async {
    ref.invalidate(requestListProvider);
    try {
      await ref.read(requestListProvider.future);
    } catch (_) {
      // Shown by the list.
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      await ref.read(requestListProvider.notifier).loadMore();
    } catch (error) {
      if (mounted) showError(context, error);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final filter = ref.watch(requestFilterProvider);
    final list = ref.watch(requestListProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('requestsTitle'))),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push<void>(Routes.catalogue),
        icon: const Icon(PhosphorIconsBold.plus),
        label: Text(l10n.t('requestsNew')),
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: SizedBox(
              width: double.infinity,
              child: SegmentedButton<RequestFilter>(
                segments: <ButtonSegment<RequestFilter>>[
                  ButtonSegment<RequestFilter>(value: RequestFilter.active, label: Text(l10n.t('requestsActive'))),
                  ButtonSegment<RequestFilter>(value: RequestFilter.completed, label: Text(l10n.t('requestsCompleted'))),
                ],
                selected: <RequestFilter>{filter},
                onSelectionChanged: (selection) {
                  if (selection.isEmpty) return;
                  ref.read(requestFilterProvider.notifier).state = selection.first;
                },
              ),
            ),
          ),
          Expanded(
            child: AsyncValueView<PagedList<RequestSummary>>(
              value: list,
              onRetry: () => ref.invalidate(requestListProvider),
              data: (page) {
                if (page.items.isEmpty) {
                  return RefreshableList(
                    onRefresh: _refresh,
                    children: <Widget>[
                      FillRemainingMessage(
                        child: EmptyStateView(
                          icon: PhosphorIconsRegular.clipboardText,
                          title: filter == RequestFilter.active ? l10n.t('requestsEmptyActive') : l10n.t('requestsEmptyCompleted'),
                          message: filter == RequestFilter.active ? l10n.t('requestsEmptyActiveBody') : null,
                          action: filter == RequestFilter.active
                              ? FilledButton.icon(
                                  onPressed: () => context.push<void>(Routes.catalogue),
                                  icon: const Icon(PhosphorIconsBold.plus),
                                  label: Text(l10n.t('homeStartRequest')),
                                )
                              : null,
                        ),
                      ),
                    ],
                  );
                }
                return RefreshableList(
                  onRefresh: _refresh,
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                  children: <Widget>[
                    for (final request in page.items) RequestCard(request: request),
                    if (page.hasMore)
                      Center(
                        child: _loadingMore
                            ? const Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator())
                            : OutlinedButton(onPressed: _loadMore, child: Text(l10n.t('commonLoadMore'))),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
