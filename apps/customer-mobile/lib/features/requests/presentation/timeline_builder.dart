import '../../../core/utils/dates.dart';
import '../../../core/widgets/status_timeline.dart';
import '../data/request_models.dart';

/// Builds the entries of the status timeline of a request.
///
/// * what already happened comes from the customer-visible status history;
/// * the newest history entry is the current step (unless the request is
///   finished);
/// * a status reported by an outside party is its own entry and ALWAYS
///   carries its source label;
/// * the steps still to come are taken from the customer-visible workflow.
List<TimelineEntry> buildRequestTimeline(RequestDetail request, String languageCode) {
  final entries = <TimelineEntry>[];
  final history = request.history.where((h) => h.status != 'DRAFT' || request.isDraft).toList();

  for (var i = 0; i < history.length; i++) {
    final entry = history[i];
    final isLatest = i == history.length - 1;
    final label = entry.statusLabel.resolve(languageCode);
    final message = entry.message;
    // The API repeats the status wording as the message when the centre wrote
    // nothing specific; showing it twice would only be noise.
    final caption = (message != null && message.trim().isNotEmpty && message.trim() != entry.statusLabel.en.trim() && message.trim() != label.trim())
        ? message
        : null;
    entries.add(
      TimelineEntry(
        title: label,
        subtitle: Dates.dateTime(entry.at, languageCode),
        caption: caption,
        state: (isLatest && !request.isClosed && request.externalStatus == null) ? TimelineState.current : TimelineState.done,
      ),
    );
  }

  final external = request.externalStatus;
  if (external != null) {
    entries.add(
      TimelineEntry(
        title: external.status,
        subtitle: Dates.dateTime(external.at, languageCode),
        sourceLabel: external.sourceLabel.resolve(languageCode),
        state: request.isClosed ? TimelineState.done : TimelineState.current,
      ),
    );
  }

  if (!request.isClosed) {
    // Before the workflow has started (a draft) no step is current: every
    // step is still to come.
    var afterCurrent = !request.workflowSteps.any((step) => step.current);
    for (final step in request.workflowSteps) {
      if (step.current) {
        afterCurrent = true;
        continue;
      }
      if (!afterCurrent || step.isDone) continue;
      entries.add(
        TimelineEntry(
          title: languageCode == 'ar' && step.nameAr != null && step.nameAr!.trim().isNotEmpty ? step.nameAr! : step.name,
          state: TimelineState.upcoming,
        ),
      );
    }
  }
  return entries;
}
