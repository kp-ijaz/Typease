import '../../../core/utils/dates.dart';
import '../../../core/utils/validators.dart';
import '../data/form_schema.dart';

/// Why a value was not accepted. The UI turns the code into a localised
/// sentence (`formError_<code>` in the ARB files) using [label] and [limit].
class FormIssue {
  const FormIssue(this.code, {this.limit});

  /// `required`, `text`, `maxLength`, `minLength`, `pattern`, `number`,
  /// `min`, `max`, `date`, `email`, `phone`, `country`, `option`,
  /// `minChoices`, `maxChoices`, `checkbox`, `unsupported`.
  final String code;
  final num? limit;

  @override
  String toString() => limit == null ? 'FormIssue($code)' : 'FormIssue($code, $limit)';
}

class _Checked {
  const _Checked.ok(this.value) : issue = null;
  const _Checked.fail(this.issue) : value = null;

  final Object? value;
  final FormIssue? issue;
}

/// Client-side copy of the server's dynamic-form rules
/// (`buildFormValidator` / `visibleFormFieldKeys` in
/// packages/validation/src/catalogue.ts). It exists to give immediate
/// feedback and to decide which fields to draw; the server validates again
/// and its answer always wins.
class FormEngine {
  const FormEngine._();

  static const int _defaultTextLimit = 500;
  static const int _defaultTextareaLimit = 5000;

  static bool isEmptyValue(Object? value) {
    if (value == null) return true;
    if (value is String) return value.trim().isEmpty;
    if (value is List) return value.isEmpty;
    return false;
  }

  /// Is [field] shown, given the cleaned values of the fields before it?
  static bool _isShown(FormFieldDef field, Map<String, Object?> seen) {
    final rule = field.showIf;
    if (rule == null) return true;
    // A hidden or invalid controlling field has no value, so everything that
    // depends on it is hidden too.
    if (!seen.containsKey(rule.field)) return false;
    final current = seen[rule.field];
    final candidates = current is List ? current : <Object?>[current];
    for (final candidate in candidates) {
      final text = candidate?.toString();
      if (text != null && rule.values.contains(text)) return true;
    }
    return false;
  }

  /// Keys of the visible fields for [values], evaluating `showIf` chains in
  /// form order.
  static List<String> visibleKeys(FormSchema schema, Map<String, Object?> values) {
    final seen = <String, Object?>{};
    final keys = <String>[];
    for (final field in schema.fields) {
      if (!_isShown(field, seen)) continue;
      keys.add(field.key);
      final raw = values[field.key];
      if (isEmptyValue(raw)) continue;
      final checked = _check(field, raw);
      if (checked.issue == null) seen[field.key] = checked.value;
    }
    return keys;
  }

  /// Validates [values].
  ///
  /// * [partial]: required fields may be empty (saving a draft);
  /// * [onlyKeys]: report problems for these fields only (one wizard step).
  ///
  /// Returns `fieldKey -> issue` for every visible field with a problem.
  static Map<String, FormIssue> validate(
    FormSchema schema,
    Map<String, Object?> values, {
    bool partial = false,
    Set<String>? onlyKeys,
  }) {
    final issues = <String, FormIssue>{};
    final seen = <String, Object?>{};
    for (final field in schema.fields) {
      if (!_isShown(field, seen)) continue;
      final raw = values[field.key];
      final unticked = field.type == FormFieldType.checkbox && raw == false;
      final report = onlyKeys == null || onlyKeys.contains(field.key);
      if (isEmptyValue(raw) || (unticked && field.isRequired)) {
        if (field.isRequired && !partial) {
          if (report) issues[field.key] = const FormIssue('required');
        } else if (unticked) {
          seen[field.key] = false;
        }
        continue;
      }
      final checked = _check(field, raw);
      final issue = checked.issue;
      if (issue != null) {
        if (report) issues[field.key] = issue;
        continue;
      }
      seen[field.key] = checked.value;
    }
    return issues;
  }

  /// The values to send to the server: visible, filled-in and normalised.
  /// Fields that are hidden or were emptied are sent as null, which clears
  /// a previously saved value (`PUT /requests/:id/fields`).
  static Map<String, Object?> payload(FormSchema schema, Map<String, Object?> values, {Set<String>? onlyKeys}) {
    final out = <String, Object?>{};
    final seen = <String, Object?>{};
    for (final field in schema.fields) {
      final include = onlyKeys == null || onlyKeys.contains(field.key);
      if (!_isShown(field, seen)) {
        if (include && values.containsKey(field.key) && !isEmptyValue(values[field.key])) out[field.key] = null;
        continue;
      }
      final raw = values[field.key];
      if (isEmptyValue(raw)) {
        if (include && values.containsKey(field.key)) out[field.key] = null;
        continue;
      }
      final checked = _check(field, raw);
      if (checked.issue != null) {
        // Invalid values are not sent; validate() reports them to the user.
        continue;
      }
      seen[field.key] = checked.value;
      if (include) out[field.key] = checked.value;
    }
    return out;
  }

  static _Checked _check(FormFieldDef field, Object? raw) {
    switch (field.type) {
      case FormFieldType.text:
      case FormFieldType.textarea:
        if (raw is! String) return const _Checked.fail(FormIssue('text'));
        final value = raw.trim();
        final limit = field.maxLength ?? (field.type == FormFieldType.text ? _defaultTextLimit : _defaultTextareaLimit);
        if (value.length > limit) return _Checked.fail(FormIssue('maxLength', limit: limit));
        final max = field.max;
        final min = field.min;
        if (max != null && value.length > max) return _Checked.fail(FormIssue('maxLength', limit: max));
        if (min != null && value.length < min) return _Checked.fail(FormIssue('minLength', limit: min));
        final pattern = field.pattern;
        if (pattern != null && pattern.isNotEmpty) {
          RegExp expression;
          try {
            expression = RegExp('^(?:$pattern)\$', unicode: true);
          } catch (_) {
            // A pattern this device cannot compile is left to the server.
            return _Checked.ok(value);
          }
          if (!expression.hasMatch(value)) return const _Checked.fail(FormIssue('pattern'));
        }
        return _Checked.ok(value);
      case FormFieldType.number:
        num? value;
        if (raw is num) {
          value = raw;
        } else if (raw is String && RegExp(r'^-?\d+(\.\d+)?$').hasMatch(raw.trim())) {
          value = num.tryParse(raw.trim());
        }
        if (value == null || value.isNaN || value.isInfinite) return const _Checked.fail(FormIssue('number'));
        final min = field.min;
        final max = field.max;
        if (min != null && value < min) return _Checked.fail(FormIssue('min', limit: min));
        if (max != null && value > max) return _Checked.fail(FormIssue('max', limit: max));
        return _Checked.ok(value);
      case FormFieldType.date:
        if (raw is! String || !Dates.isValidIsoDate(raw.trim())) return const _Checked.fail(FormIssue('date'));
        return _Checked.ok(raw.trim());
      case FormFieldType.email:
        final value = raw is String ? raw.trim().toLowerCase() : '';
        if (!Validators.isEmail(value)) return const _Checked.fail(FormIssue('email'));
        return _Checked.ok(value);
      case FormFieldType.phone:
        final value = raw is String ? Validators.normalisePhone(raw) : '';
        if (!Validators.isPhone(value)) return const _Checked.fail(FormIssue('phone'));
        return _Checked.ok(value);
      case FormFieldType.country:
        final value = raw is String ? raw.trim().toUpperCase() : '';
        if (!RegExp(r'^[A-Z]{2,3}$').hasMatch(value)) return const _Checked.fail(FormIssue('country'));
        return _Checked.ok(value);
      case FormFieldType.select:
      case FormFieldType.radio:
        final value = raw is num ? raw.toString() : raw;
        if (value is! String || !field.options.any((o) => o.value == value)) {
          return const _Checked.fail(FormIssue('option'));
        }
        return _Checked.ok(value);
      case FormFieldType.multiselect:
        if (raw is! List || raw.any((v) => v is! String)) return const _Checked.fail(FormIssue('option'));
        final value = <String>[];
        for (final item in raw) {
          final text = item as String;
          if (!value.contains(text)) value.add(text);
        }
        if (value.any((v) => !field.options.any((o) => o.value == v))) return const _Checked.fail(FormIssue('option'));
        final min = field.min;
        final max = field.max;
        if (min != null && value.length < min) return _Checked.fail(FormIssue('minChoices', limit: min));
        if (max != null && value.length > max) return _Checked.fail(FormIssue('maxChoices', limit: max));
        return _Checked.ok(value);
      case FormFieldType.checkbox:
        if (raw is! bool) return const _Checked.fail(FormIssue('checkbox'));
        return _Checked.ok(raw);
      case FormFieldType.unsupported:
        return const _Checked.fail(FormIssue('unsupported'));
    }
  }
}
