// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:typease_customer/core/widgets/status_timeline.dart';
import 'package:typease_customer/features/requests/data/request_models.dart';
import 'package:typease_customer/features/requests/presentation/timeline_builder.dart';

import '../support/fixtures.dart';
import '../support/test_app.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

const String _externalStatus = 'Under process at the authority';
const String _staffEnteredEn = 'Entered by staff (not verified by the authority)';
const String _staffEnteredAr = 'أدخلها الموظف (غير مؤكدة من الجهة)';

Future<void> pumpTimeline(WidgetTester tester, String language) async {
  // TE-000002 of the fixture centre: submitted to an authority, with a status
  // that a member of staff typed in.
  final request = RequestDetail.fromJson(fixture('request_external'));
  final entries = buildRequestTimeline(request, language);
  await tester.pumpWidget(
    testApp(
      Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: StatusTimeline(entries: entries),
        ),
      ),
      languageCode: language,
    ),
  );
  await tester.pump();
  await tester.pump();
}

void main() {
  setUpAll(() async {
    await initializeDateFormatting();
  });

  testWidgets('Arabic: the timeline is mirrored and the external status shows its source label', (tester) async {
    await pumpTimeline(tester, 'ar');

    expect(Directionality.of(tester.element(find.byType(StatusTimeline))), TextDirection.rtl);

    // Arabic wording of the internal history and of the step still to come.
    expect(find.text('تم الإرسال'), findsOneWidget);
    expect(find.text('تم التقديم — قيد المعالجة'), findsOneWidget);
    expect(find.text('المراجعة النهائية والإنجاز'), findsOneWidget);

    // The authority's status is shown as entered, together with where it came from.
    expect(find.text(_externalStatus), findsOneWidget);
    expect(find.text(_staffEnteredAr), findsOneWidget);
    expect(find.text(_staffEnteredEn), findsNothing);
    expect(find.byIcon(PhosphorIconsRegular.info), findsOneWidget);

    // Six finished steps have a tick.
    expect(find.byIcon(PhosphorIconsBold.check), findsNWidgets(6));

    // Right-to-left: the marker column is on the right of the text.
    final firstTick = tester.getCenter(find.byIcon(PhosphorIconsBold.check).first);
    final firstTitle = tester.getCenter(find.text('تم الإرسال'));
    expect(firstTick.dx, greaterThan(firstTitle.dx));

    // Order from top to bottom: history, external status with its label, upcoming step.
    final submitted = tester.getTopLeft(find.text('تم الإرسال')).dy;
    final external = tester.getTopLeft(find.text(_externalStatus)).dy;
    final label = tester.getTopLeft(find.text(_staffEnteredAr)).dy;
    final upcoming = tester.getTopLeft(find.text('المراجعة النهائية والإنجاز')).dy;
    expect(submitted, lessThan(external));
    expect(external, lessThan(label));
    expect(label, lessThan(upcoming));

    expect(tester.takeException(), isNull);
  });

  testWidgets('English: same content, marker column on the left', (tester) async {
    await pumpTimeline(tester, 'en');

    expect(Directionality.of(tester.element(find.byType(StatusTimeline))), TextDirection.ltr);
    expect(find.text('Submitted'), findsOneWidget);
    expect(find.text(_externalStatus), findsOneWidget);
    expect(find.text(_staffEnteredEn), findsOneWidget);
    expect(find.text('Final review and completion'), findsOneWidget);

    final firstTick = tester.getCenter(find.byIcon(PhosphorIconsBold.check).first);
    final firstTitle = tester.getCenter(find.text('Submitted'));
    expect(firstTick.dx, lessThan(firstTitle.dx));
  });

  testWidgets('screen readers hear the status together with its source', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpTimeline(tester, 'ar');

    // One label per row: title, date and - for an external status - the source.
    expect(find.bySemanticsLabel(RegExp('^$_externalStatus, .*أدخلها الموظف')), findsWidgets);

    handle.dispose();
  });

  testWidgets('a status entry without a source label shows no source row', (tester) async {
    await tester.pumpWidget(
      testApp(
        const Scaffold(
          body: StatusTimeline(
            entries: <TimelineEntry>[
              TimelineEntry(title: 'Submitted', state: TimelineState.done, subtitle: 'Oct 8, 2026'),
              TimelineEntry(title: 'Being prepared', state: TimelineState.current, caption: 'We are typing your application.'),
              TimelineEntry(title: 'Completed', state: TimelineState.upcoming),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Submitted'), findsOneWidget);
    expect(find.text('Oct 8, 2026'), findsOneWidget);
    expect(find.text('We are typing your application.'), findsOneWidget);
    expect(find.byIcon(PhosphorIconsBold.check), findsOneWidget);
    expect(find.byIcon(PhosphorIconsRegular.info), findsNothing);
  });
}
