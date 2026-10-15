// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:typease_customer/core/widgets/status_timeline.dart';
import 'package:typease_customer/features/requests/data/request_models.dart';
import 'package:typease_customer/features/requests/presentation/timeline_builder.dart';

import '../support/fixtures.dart';

const String _staffEnteredEn = 'Entered by staff (not verified by the authority)';
const String _staffEnteredAr = 'أدخلها الموظف (غير مؤكدة من الجهة)';

void main() {
  setUpAll(() async {
    await initializeDateFormatting();
  });

  test('a request waiting for the customer: history, current step with the centre message, steps to come', () {
    final request = RequestDetail.fromJson(fixture('request_awaiting_customer'));
    final entries = buildRequestTimeline(request, 'en');

    // The draft entry is not shown once the request was submitted.
    expect(entries.map((e) => e.title).take(3), <String>['Submitted', 'Documents under review', 'Action needed from you']);
    expect(entries.take(3).map((e) => e.state), <TimelineState>[TimelineState.done, TimelineState.done, TimelineState.current]);

    // The status wording is not repeated as a caption; a real message is shown.
    expect(entries[0].caption, isNull);
    expect(entries[1].caption, isNull);
    expect(entries[2].caption, startsWith('Please replace the following document'));

    // Six workflow steps follow the current one.
    final upcoming = entries.where((e) => e.state == TimelineState.upcoming).toList();
    expect(upcoming.map((e) => e.title), <String>[
      'Quotation',
      'Quotation approval',
      'Payment',
      'Prepare application',
      'Submission and external processing',
      'Final review and completion',
    ]);
    expect(entries, hasLength(9));
    expect(entries.where((e) => e.state == TimelineState.current), hasLength(1));
    // No status of an outside party: no source label anywhere.
    expect(entries.where((e) => e.sourceLabel != null), isEmpty);
    // Every past entry has a date.
    expect(entries.take(3).every((e) => e.subtitle != null && e.subtitle != '—'), isTrue);
  });

  test('a completed request: everything is done and nothing is upcoming', () {
    final request = RequestDetail.fromJson(fixture('request_completed'));
    final entries = buildRequestTimeline(request, 'en');

    expect(entries, hasLength(11));
    expect(entries.every((e) => e.state == TimelineState.done), isTrue);
    expect(entries.last.title, 'Completed');
    expect(entries.first.title, 'Submitted');
  });

  test('a draft shows the draft entry as the current step', () {
    final request = RequestDetail.fromJson(fixture('request_draft'));
    final entries = buildRequestTimeline(request, 'en');

    expect(entries.first.title, 'Draft — not submitted yet');
    expect(entries.first.state, TimelineState.current);
    expect(entries.where((e) => e.state == TimelineState.done), isEmpty);
    // The workflow has not started: all nine steps are still to come.
    final upcoming = entries.where((e) => e.state == TimelineState.upcoming).toList();
    expect(upcoming, hasLength(9));
    expect(upcoming.first.title, 'Application details');
    expect(upcoming.last.title, 'Final review and completion');
  });

  group('status reported by an outside party', () {
    test('is its own entry and carries the source label', () {
      final request = RequestDetail.fromJson(fixture('request_external'));
      final entries = buildRequestTimeline(request, 'en');

      final external = entries.where((e) => e.sourceLabel != null).toList();
      expect(external, hasLength(1));
      expect(external.single.title, 'Under process at the authority');
      expect(external.single.sourceLabel, _staffEnteredEn);
      expect(external.single.state, TimelineState.current);

      // The internal history before it is finished, the last workflow step is still to come.
      final index = entries.indexOf(external.single);
      expect(index, 6);
      expect(entries.take(index).every((e) => e.state == TimelineState.done), isTrue);
      expect(entries.take(index).last.title, 'Submitted — in processing');
      expect(entries.skip(index + 1).map((e) => e.title), <String>['Final review and completion']);
      expect(entries.last.state, TimelineState.upcoming);
      expect(entries.where((e) => e.state == TimelineState.current), hasLength(1));
    });

    test('in Arabic: labels, source label and step names are Arabic; the authority text is shown as entered', () {
      final request = RequestDetail.fromJson(fixture('request_external'));
      final entries = buildRequestTimeline(request, 'ar');

      expect(entries.first.title, 'تم الإرسال');
      final external = entries.singleWhere((e) => e.sourceLabel != null);
      expect(external.title, 'Under process at the authority');
      expect(external.sourceLabel, _staffEnteredAr);
      expect(entries.last.title, 'المراجعة النهائية والإنجاز');
    });

    test('a response without a source label still gets one - and never the "official" one by default', () {
      final json = Map<String, dynamic>.of(fixture('request_external') as Map<String, dynamic>);
      json['externalStatus'] = <String, dynamic>{'status': 'Approved', 'at': '2026-10-08T22:48:21.528Z'};
      final entries = buildRequestTimeline(RequestDetail.fromJson(json), 'en');

      final external = entries.singleWhere((e) => e.title == 'Approved');
      expect(external.sourceLabel, _staffEnteredEn);
    });

    test('a verified official status is labelled as such', () {
      final json = Map<String, dynamic>.of(fixture('request_external') as Map<String, dynamic>);
      json['externalStatus'] = <String, dynamic>{'status': 'Approved', 'source': 'VERIFIED_OFFICIAL'};
      final entries = buildRequestTimeline(RequestDetail.fromJson(json), 'en');

      expect(entries.singleWhere((e) => e.title == 'Approved').sourceLabel, 'Verified via official integration');
    });
  });

  test('every fixture: an entry never has an empty title, and external entries always have a source label', () {
    for (final name in <String>[
      'request_created',
      'request_draft',
      'request_submitted',
      'request_awaiting_customer',
      'request_quoted',
      'request_completed',
      'request_external',
    ]) {
      final request = RequestDetail.fromJson(fixture(name));
      for (final language in <String>['en', 'ar']) {
        final entries = buildRequestTimeline(request, language);
        expect(entries, isNotEmpty, reason: '$name/$language');
        expect(entries.every((e) => e.title.trim().isNotEmpty), isTrue, reason: '$name/$language');
        final external = request.externalStatus;
        if (external != null) {
          final entry = entries.singleWhere((e) => e.title == external.status);
          expect(entry.sourceLabel, isNotNull, reason: '$name/$language');
          expect(entry.sourceLabel!.trim(), isNotEmpty, reason: '$name/$language');
        }
      }
    }
  });
}
