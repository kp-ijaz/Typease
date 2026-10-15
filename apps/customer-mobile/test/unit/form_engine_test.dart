// NOT YET EXECUTED: written without a Dart SDK (see README.md, "Verification status").
import 'package:flutter_test/flutter_test.dart';
import 'package:typease_customer/features/catalogue/data/catalogue_models.dart';
import 'package:typease_customer/features/requests/application/form_engine.dart';
import 'package:typease_customer/features/requests/data/form_schema.dart';

import '../support/fixtures.dart';

/// The published form of the "Visa application typing" starter service, as
/// returned by `GET /catalogue/:id`:
/// applicantName, nationality, dateOfBirth, mobile | visaType, sponsorType,
/// sponsorName (showIf sponsorType in [family, company]), passportExpiry,
/// insideCountry.
FormSchema visaForm() => CatalogueService.fromJson(fixture('service_detail')).form!;

const Map<String, Object?> validAnswers = <String, Object?>{
  'applicantName': 'Fatima Al Mansoori',
  'nationality': 'AE',
  'dateOfBirth': '1988-07-15',
  'mobile': '+971501110002',
  'visaType': 'visit',
  'sponsorType': 'family',
  'sponsorName': 'Ahmed Al Mansoori',
  'passportExpiry': '2030-01-01',
  'insideCountry': true,
};

FormSchema schemaOf(List<Map<String, dynamic>> fields) {
  return FormSchema.fromJson(<String, dynamic>{
    'steps': <Map<String, dynamic>>[
      <String, dynamic>{'key': 'only', 'title': 'Only step', 'fields': fields},
    ],
  });
}

void main() {
  group('parsing the real form', () {
    test('has two steps and nine fields with the right types', () {
      final form = visaForm();
      expect(form.steps.map((s) => s.key), <String>['applicant', 'visa']);
      expect(form.fields.length, 9);
      expect(form.fields.firstWhere((f) => f.key == 'nationality').type, FormFieldType.country);
      expect(form.fields.firstWhere((f) => f.key == 'visaType').options.map((o) => o.value), contains('tourist'));
      final sponsorName = form.fields.firstWhere((f) => f.key == 'sponsorName');
      expect(sponsorName.showIf, isNotNull);
      expect(sponsorName.showIf!.field, 'sponsorType');
      expect(sponsorName.showIf!.values, <String>['family', 'company']);
      expect(form.stepIndexOf('passportExpiry'), 1);
      expect(form.stepIndexOf('unknown'), -1);
      expect(form.steps.first.displayTitle('ar'), 'مقدم الطلب');
    });
  });

  group('showIf', () {
    test('a conditional field is hidden until its controlling field has a matching value', () {
      final form = visaForm();
      expect(FormEngine.visibleKeys(form, const <String, Object?>{}), isNot(contains('sponsorName')));
      expect(FormEngine.visibleKeys(form, const <String, Object?>{'sponsorType': 'family'}), contains('sponsorName'));
      expect(FormEngine.visibleKeys(form, const <String, Object?>{'sponsorType': 'company'}), contains('sponsorName'));
      expect(FormEngine.visibleKeys(form, const <String, Object?>{'sponsorType': 'self'}), isNot(contains('sponsorName')));
    });

    test('an invalid controlling value hides the dependent field', () {
      final form = visaForm();
      expect(FormEngine.visibleKeys(form, const <String, Object?>{'sponsorType': 'nope'}), isNot(contains('sponsorName')));
    });

    test('all unconditional fields are always visible, in form order', () {
      final keys = FormEngine.visibleKeys(visaForm(), const <String, Object?>{});
      expect(keys, <String>[
        'applicantName',
        'nationality',
        'dateOfBirth',
        'mobile',
        'visaType',
        'sponsorType',
        'passportExpiry',
        'insideCountry',
      ]);
    });

    test('a field is hidden when the field it depends on is itself hidden', () {
      final form = schemaOf(<Map<String, dynamic>>[
        <String, dynamic>{'key': 'a', 'label': 'A', 'type': 'checkbox'},
        <String, dynamic>{
          'key': 'b',
          'label': 'B',
          'type': 'select',
          'options': <Map<String, dynamic>>[
            <String, dynamic>{'value': 'x', 'label': 'X'},
            <String, dynamic>{'value': 'y', 'label': 'Y'},
          ],
          'showIf': <String, dynamic>{'field': 'a', 'in': <dynamic>[true]},
        },
        <String, dynamic>{
          'key': 'c',
          'label': 'C',
          'type': 'text',
          'required': true,
          'showIf': <String, dynamic>{'field': 'b', 'in': <dynamic>['x']},
        },
      ]);
      // b has a matching value but is hidden because a is not ticked: c stays hidden.
      expect(FormEngine.visibleKeys(form, const <String, Object?>{'a': false, 'b': 'x'}), <String>['a']);
      expect(FormEngine.visibleKeys(form, const <String, Object?>{'a': true, 'b': 'x'}), <String>['a', 'b', 'c']);
      expect(FormEngine.validate(form, const <String, Object?>{'a': false, 'b': 'x'}), isEmpty);
      expect(FormEngine.validate(form, const <String, Object?>{'a': true, 'b': 'x'}).keys, <String>['c']);
    });
  });

  group('validation', () {
    test('complete, valid answers have no issues', () {
      expect(FormEngine.validate(visaForm(), validAnswers), isEmpty);
    });

    test('an empty form reports every visible required field and nothing else', () {
      final issues = FormEngine.validate(visaForm(), const <String, Object?>{});
      expect(issues.keys.toSet(), <String>{
        'applicantName',
        'nationality',
        'dateOfBirth',
        'mobile',
        'visaType',
        'sponsorType',
        'passportExpiry',
      });
      expect(issues.values.every((i) => i.code == 'required'), isTrue);
    });

    test('a conditional required field is required once it is visible', () {
      final answers = Map<String, Object?>.of(validAnswers)..remove('sponsorName');
      expect(FormEngine.validate(visaForm(), answers).keys, <String>['sponsorName']);
      answers['sponsorType'] = 'self';
      expect(FormEngine.validate(visaForm(), answers), isEmpty);
    });

    test('draft saving accepts empty required fields but still checks what is filled in', () {
      final form = visaForm();
      expect(FormEngine.validate(form, const <String, Object?>{}, partial: true), isEmpty);
      final issues = FormEngine.validate(form, const <String, Object?>{'dateOfBirth': '15/07/1988'}, partial: true);
      expect(issues.keys, <String>['dateOfBirth']);
      expect(issues['dateOfBirth']!.code, 'date');
    });

    test('onlyKeys limits the report to one wizard step', () {
      final form = visaForm();
      final firstStep = form.steps.first.fields.map((f) => f.key).toSet();
      final issues = FormEngine.validate(form, const <String, Object?>{}, onlyKeys: firstStep);
      expect(issues.keys.toSet(), <String>{'applicantName', 'nationality', 'dateOfBirth', 'mobile'});
    });

    test('checks each field type', () {
      final form = visaForm();
      Map<String, FormIssue> check(String key, Object? value) {
        return FormEngine.validate(form, <String, Object?>{key: value}, partial: true);
      }

      expect(check('dateOfBirth', '2024-02-30')['dateOfBirth']!.code, 'date');
      expect(check('dateOfBirth', '2024-02-29'), isEmpty);
      expect(check('mobile', '050 123 4567')['mobile']!.code, 'phone');
      expect(check('mobile', '+971 50 123 4567'), isEmpty);
      expect(check('nationality', 'United Arab Emirates')['nationality']!.code, 'country');
      expect(check('nationality', 'ae'), isEmpty);
      expect(check('visaType', 'diplomatic')['visaType']!.code, 'option');
      expect(check('insideCountry', 'yes')['insideCountry']!.code, 'checkbox');
      final tooLong = check('applicantName', 'x' * 161)['applicantName']!;
      expect(tooLong.code, 'maxLength');
      expect(tooLong.limit, 160);
    });

    test('numbers, patterns, multiselect limits and required checkboxes', () {
      final form = schemaOf(<Map<String, dynamic>>[
        <String, dynamic>{'key': 'copies', 'label': 'Copies', 'type': 'number', 'min': 1, 'max': 10},
        <String, dynamic>{'key': 'plate', 'label': 'Plate', 'type': 'text', 'pattern': '[A-Z]{1,3}[0-9]{1,5}'},
        <String, dynamic>{
          'key': 'languages',
          'label': 'Languages',
          'type': 'multiselect',
          'min': 1,
          'max': 2,
          'options': <Map<String, dynamic>>[
            <String, dynamic>{'value': 'en', 'label': 'English'},
            <String, dynamic>{'value': 'ar', 'label': 'Arabic'},
            <String, dynamic>{'value': 'ur', 'label': 'Urdu'},
          ],
        },
        <String, dynamic>{'key': 'confirm', 'label': 'I confirm', 'type': 'checkbox', 'required': true},
        <String, dynamic>{'key': 'future', 'label': 'Future', 'type': 'signature'},
      ]);
      Map<String, FormIssue> check(Map<String, Object?> values) => FormEngine.validate(form, values, partial: true);

      expect(check(<String, Object?>{'copies': '0'})['copies']!.code, 'min');
      expect(check(<String, Object?>{'copies': '11'})['copies']!.code, 'max');
      expect(check(<String, Object?>{'copies': 'three'})['copies']!.code, 'number');
      expect(check(<String, Object?>{'copies': '3'}), isEmpty);
      expect(check(<String, Object?>{'copies': 3}), isEmpty);

      expect(check(<String, Object?>{'plate': 'AB123'}), isEmpty);
      // The pattern must match the WHOLE value.
      expect(check(<String, Object?>{'plate': 'AB123-extra'})['plate']!.code, 'pattern');

      expect(check(<String, Object?>{'languages': <String>['en', 'ar', 'ur']})['languages']!.code, 'maxChoices');
      expect(check(<String, Object?>{'languages': <String>['en', 'xx']})['languages']!.code, 'option');
      expect(check(<String, Object?>{'languages': <String>['en', 'en']}), isEmpty);

      // A required checkbox must be ticked; unticked counts as missing.
      expect(FormEngine.validate(form, const <String, Object?>{'confirm': false})['confirm']!.code, 'required');
      expect(FormEngine.validate(form, const <String, Object?>{'confirm': true}), isEmpty);

      // A field type this app version does not know is reported, not ignored.
      expect(form.fields.last.type, FormFieldType.unsupported);
      expect(check(<String, Object?>{'future': 'anything'})['future']!.code, 'unsupported');
    });
  });

  group('payload for PUT /requests/:id/fields', () {
    test('sends normalised values of visible fields', () {
      final payload = FormEngine.payload(visaForm(), <String, Object?>{
        'applicantName': '  Fatima Al Mansoori ',
        'nationality': 'ae',
        'mobile': '+971 50 111 0002',
        'sponsorType': 'family',
        'sponsorName': 'Ahmed',
      });
      expect(payload['applicantName'], 'Fatima Al Mansoori');
      expect(payload['nationality'], 'AE');
      expect(payload['mobile'], '+971501110002');
      expect(payload['sponsorName'], 'Ahmed');
    });

    test('clears the value of a field that became hidden', () {
      final payload = FormEngine.payload(visaForm(), const <String, Object?>{'sponsorType': 'self', 'sponsorName': 'Ahmed'});
      expect(payload.containsKey('sponsorName'), isTrue);
      expect(payload['sponsorName'], isNull);
      expect(payload['sponsorType'], 'self');
    });

    test('clears a value the customer emptied and leaves untouched fields out', () {
      final payload = FormEngine.payload(visaForm(), const <String, Object?>{'applicantName': '   '});
      expect(payload, <String, Object?>{'applicantName': null});
    });

    test('does not send invalid values', () {
      final payload = FormEngine.payload(visaForm(), const <String, Object?>{'dateOfBirth': 'tomorrow', 'visaType': 'visit'});
      expect(payload.containsKey('dateOfBirth'), isFalse);
      expect(payload['visaType'], 'visit');
    });

    test('onlyKeys limits the payload to one step', () {
      final form = visaForm();
      final firstStep = form.steps.first.fields.map((f) => f.key).toSet();
      final payload = FormEngine.payload(form, validAnswers, onlyKeys: firstStep);
      expect(payload.keys.toSet(), <String>{'applicantName', 'nationality', 'dateOfBirth', 'mobile'});
    });
  });
}
