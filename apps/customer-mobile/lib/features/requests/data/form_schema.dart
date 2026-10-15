import '../../../core/utils/json.dart';

/// Dynamic service form (`FormSchema` in packages/types/src/catalogue.ts).
class FormOption {
  const FormOption({required this.value, required this.label, this.labelAr});

  factory FormOption.fromJson(Object? json) {
    final map = asMap(json);
    return FormOption(
      value: asString(map['value']),
      label: asString(map['label'], asString(map['value'])),
      labelAr: asStringOrNull(map['labelAr']),
    );
  }

  final String value;
  final String label;
  final String? labelAr;
}

/// "Only show this field when [field] has one of the values [values]".
class ShowIf {
  const ShowIf({required this.field, required this.values});

  final String field;

  /// Kept as strings: the server compares `String(a) === String(b)`.
  final List<String> values;

  static ShowIf? fromJson(Object? json) {
    final map = asMapOrNull(json);
    if (map == null) return null;
    final field = asStringOrNull(map['field']);
    if (field == null || field.isEmpty) return null;
    return ShowIf(field: field, values: asStringList(map['in']));
  }
}

/// The field types the API defines. [unsupported] covers types added to the
/// server after this app version was built.
enum FormFieldType { text, textarea, number, date, email, phone, select, multiselect, checkbox, radio, country, unsupported }

FormFieldType formFieldTypeFromString(String value) {
  switch (value) {
    case 'text':
      return FormFieldType.text;
    case 'textarea':
      return FormFieldType.textarea;
    case 'number':
      return FormFieldType.number;
    case 'date':
      return FormFieldType.date;
    case 'email':
      return FormFieldType.email;
    case 'phone':
      return FormFieldType.phone;
    case 'select':
      return FormFieldType.select;
    case 'multiselect':
      return FormFieldType.multiselect;
    case 'checkbox':
      return FormFieldType.checkbox;
    case 'radio':
      return FormFieldType.radio;
    case 'country':
      return FormFieldType.country;
    default:
      return FormFieldType.unsupported;
  }
}

class FormFieldDef {
  const FormFieldDef({
    required this.key,
    required this.label,
    required this.type,
    required this.isRequired,
    required this.options,
    required this.sensitive,
    this.labelAr,
    this.placeholder,
    this.help,
    this.showIf,
    this.prefillFrom,
    this.min,
    this.max,
    this.maxLength,
    this.pattern,
  });

  factory FormFieldDef.fromJson(Object? json) {
    final map = asMap(json);
    final min = map['min'];
    final max = map['max'];
    return FormFieldDef(
      key: asString(map['key']),
      label: asString(map['label'], asString(map['key'])),
      labelAr: asStringOrNull(map['labelAr']),
      type: formFieldTypeFromString(asString(map['type'])),
      isRequired: asBool(map['required']),
      placeholder: asStringOrNull(map['placeholder']),
      help: asStringOrNull(map['help']),
      options: asMapList(map['options']).map(FormOption.fromJson).toList(growable: false),
      showIf: ShowIf.fromJson(map['showIf']),
      prefillFrom: asStringOrNull(map['prefillFrom']),
      sensitive: asBool(map['sensitive']),
      min: min is num ? min : null,
      max: max is num ? max : null,
      maxLength: asIntOrNull(map['maxLength']),
      pattern: asStringOrNull(map['pattern']),
    );
  }

  final String key;
  final String label;
  final String? labelAr;
  final FormFieldType type;
  final bool isRequired;
  final String? placeholder;
  final String? help;
  final List<FormOption> options;
  final ShowIf? showIf;
  final String? prefillFrom;
  final bool sensitive;
  final num? min;
  final num? max;
  final int? maxLength;
  final String? pattern;

  bool get hasOptions => type == FormFieldType.select || type == FormFieldType.radio || type == FormFieldType.multiselect;

  String displayLabel(String languageCode) => pickLanguage(languageCode, label, labelAr);
}

class FormStepDef {
  const FormStepDef({required this.key, required this.title, required this.fields, this.titleAr, this.description});

  factory FormStepDef.fromJson(Object? json) {
    final map = asMap(json);
    return FormStepDef(
      key: asString(map['key']),
      title: asString(map['title']),
      titleAr: asStringOrNull(map['titleAr']),
      description: asStringOrNull(map['description']),
      fields: asMapList(map['fields']).map(FormFieldDef.fromJson).where((f) => f.key.isNotEmpty).toList(growable: false),
    );
  }

  final String key;
  final String title;
  final String? titleAr;
  final String? description;
  final List<FormFieldDef> fields;

  String displayTitle(String languageCode) => pickLanguage(languageCode, title, titleAr);
}

class FormSchema {
  const FormSchema({required this.steps});

  factory FormSchema.fromJson(Object? json) {
    final map = asMap(json);
    return FormSchema(steps: asMapList(map['steps']).map(FormStepDef.fromJson).toList(growable: false));
  }

  static const FormSchema empty = FormSchema(steps: <FormStepDef>[]);

  final List<FormStepDef> steps;

  /// All fields in display order.
  List<FormFieldDef> get fields {
    final out = <FormFieldDef>[];
    for (final step in steps) {
      out.addAll(step.fields);
    }
    return out;
  }

  bool get isEmpty => fields.isEmpty;

  /// Index of the step that contains [fieldKey], or -1.
  int stepIndexOf(String fieldKey) {
    for (var i = 0; i < steps.length; i++) {
      for (final field in steps[i].fields) {
        if (field.key == fieldKey) return i;
      }
    }
    return -1;
  }
}
