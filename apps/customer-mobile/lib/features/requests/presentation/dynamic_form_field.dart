import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/countries.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/select_field.dart';
import '../application/form_engine.dart';
import '../data/form_schema.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Turns a [FormIssue] into a sentence, e.g. "Date of birth is required."
String describeFormIssue(AppLocalizations l10n, FormFieldDef field, FormIssue issue) {
  return l10n.tOr(
    'formError_${issue.code}',
    l10n.t('formError_generic', <String, Object?>{'label': field.displayLabel(l10n.languageCode)}),
    <String, Object?>{'label': field.displayLabel(l10n.languageCode), 'limit': issue.limit},
  );
}

/// How a stored form value reads on the review step.
String describeFormValue(AppLocalizations l10n, FormFieldDef field, Object? value) {
  if (FormEngine.isEmptyValue(value)) return '—';
  final language = l10n.languageCode;
  String optionLabel(String raw) {
    for (final option in field.options) {
      if (option.value == raw) return option.labelAr != null && language == 'ar' ? option.labelAr! : option.label;
    }
    return raw;
  }

  switch (field.type) {
    case FormFieldType.checkbox:
      return value == true ? l10n.t('commonYes') : l10n.t('commonNo');
    case FormFieldType.select:
    case FormFieldType.radio:
      return optionLabel(value.toString());
    case FormFieldType.multiselect:
      if (value is List) return value.map((v) => optionLabel(v.toString())).join(', ');
      return value.toString();
    case FormFieldType.country:
      return Countries.nameOf(value.toString(), language);
    case FormFieldType.date:
      return Dates.calendarDate(value.toString(), language);
    case FormFieldType.text:
    case FormFieldType.textarea:
    case FormFieldType.number:
    case FormFieldType.email:
    case FormFieldType.phone:
    case FormFieldType.unsupported:
      return value.toString();
  }
}

/// One field of a dynamic service form, drawn from its definition.
///
/// Text-like fields use a [TextEditingController] owned by the wizard, so the
/// typed text survives rebuilds, step changes and failed saves.
class DynamicFormField extends StatelessWidget {
  const DynamicFormField({
    super.key,
    required this.field,
    required this.value,
    required this.onChanged,
    this.controller,
    this.errorText,
    this.enabled = true,
  });

  final FormFieldDef field;
  final Object? value;
  final ValueChanged<Object?> onChanged;

  /// Required for text, textarea, number, email and phone fields.
  final TextEditingController? controller;
  final String? errorText;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final language = l10n.languageCode;
    final baseLabel = field.displayLabel(language);
    // Required fields are marked in words for screen readers and with "*".
    final label = field.isRequired ? '$baseLabel *' : baseLabel;
    final help = field.help;

    switch (field.type) {
      case FormFieldType.text:
      case FormFieldType.textarea:
      case FormFieldType.number:
      case FormFieldType.email:
      case FormFieldType.phone:
        return _text(context, label, help);
      case FormFieldType.date:
        return _DateInput(
          label: label,
          helperText: help,
          errorText: errorText,
          value: value is String ? value as String : null,
          enabled: enabled,
          onChanged: onChanged,
        );
      case FormFieldType.select:
        return Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: SelectField(
            label: label,
            helperText: help,
            errorText: errorText,
            enabled: enabled,
            allowClear: !field.isRequired,
            value: value?.toString(),
            options: <SelectOption>[
              for (final option in field.options)
                SelectOption(value: option.value, label: pickOptionLabel(option, language)),
            ],
            onChanged: onChanged,
          ),
        );
      case FormFieldType.country:
        return Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: SelectField(
            label: label,
            helperText: help,
            errorText: errorText,
            enabled: enabled,
            allowClear: !field.isRequired,
            value: value?.toString().toUpperCase(),
            options: <SelectOption>[
              for (final country in Countries.sorted(language))
                SelectOption(value: country.code, label: country.name(language)),
            ],
            onChanged: onChanged,
          ),
        );
      case FormFieldType.radio:
        return _ChoiceGroup(
          label: label,
          helperText: help,
          errorText: errorText,
          children: <Widget>[
            for (final option in field.options)
              _ChoiceTile(
                label: pickOptionLabel(option, language),
                selected: value?.toString() == option.value,
                multiple: false,
                enabled: enabled,
                onTap: () => onChanged(option.value),
              ),
          ],
        );
      case FormFieldType.multiselect:
        final selected = <String>[
          if (value is List)
            for (final item in value as List) item.toString(),
        ];
        return _ChoiceGroup(
          label: label,
          helperText: help,
          errorText: errorText,
          children: <Widget>[
            for (final option in field.options)
              _ChoiceTile(
                label: pickOptionLabel(option, language),
                selected: selected.contains(option.value),
                multiple: true,
                enabled: enabled,
                onTap: () {
                  final next = List<String>.of(selected);
                  if (next.contains(option.value)) {
                    next.remove(option.value);
                  } else {
                    next.add(option.value);
                  }
                  onChanged(next);
                },
              ),
          ],
        );
      case FormFieldType.checkbox:
        return _ChoiceGroup(
          label: null,
          helperText: help,
          errorText: errorText,
          children: <Widget>[
            _ChoiceTile(
              label: label,
              selected: value == true,
              multiple: true,
              enabled: enabled,
              onTap: () => onChanged(value != true),
            ),
          ],
        );
      case FormFieldType.unsupported:
        return Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: InputDecorator(
            decoration: InputDecoration(labelText: label, errorText: errorText, enabled: false),
            child: Text(l10n.t('formUnsupportedField')),
          ),
        );
    }
  }

  Widget _text(BuildContext context, String label, String? help) {
    final isArea = field.type == FormFieldType.textarea;
    TextInputType keyboard = TextInputType.text;
    List<TextInputFormatter>? formatters;
    var forceLtr = false;
    if (field.type == FormFieldType.number) {
      keyboard = const TextInputType.numberWithOptions(signed: true, decimal: true);
      formatters = <TextInputFormatter>[FilteringTextInputFormatter.allow(RegExp(r'[0-9.\-]'))];
      forceLtr = true;
    } else if (field.type == FormFieldType.email) {
      keyboard = TextInputType.emailAddress;
      forceLtr = true;
    } else if (field.type == FormFieldType.phone) {
      keyboard = TextInputType.phone;
      forceLtr = true;
    } else if (isArea) {
      keyboard = TextInputType.multiline;
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: TextField(
        controller: controller,
        enabled: enabled,
        keyboardType: keyboard,
        inputFormatters: formatters,
        textDirection: forceLtr ? TextDirection.ltr : null,
        minLines: isArea ? 3 : 1,
        maxLines: isArea ? 6 : 1,
        maxLength: field.maxLength,
        textInputAction: isArea ? TextInputAction.newline : TextInputAction.next,
        onChanged: onChanged,
        decoration: InputDecoration(
          labelText: label,
          hintText: field.placeholder ?? (field.type == FormFieldType.phone ? '+971501234567' : null),
          helperText: help,
          errorText: errorText,
        ),
      ),
    );
  }
}

String pickOptionLabel(FormOption option, String languageCode) {
  final arabic = option.labelAr;
  if (languageCode == 'ar' && arabic != null && arabic.trim().isNotEmpty) return arabic;
  return option.label;
}

class _DateInput extends StatelessWidget {
  const _DateInput({
    required this.label,
    required this.value,
    required this.onChanged,
    required this.enabled,
    this.helperText,
    this.errorText,
  });

  final String label;
  final String? value;
  final ValueChanged<Object?> onChanged;
  final bool enabled;
  final String? helperText;
  final String? errorText;

  Future<void> _pick(BuildContext context) async {
    final now = DateTime.now();
    final current = Dates.parseCalendarDate(value);
    final picked = await showDatePicker(
      context: context,
      initialDate: current ?? now,
      firstDate: DateTime(1900),
      lastDate: DateTime(now.year + 50),
    );
    if (picked != null) onChanged(Dates.toIsoDate(picked));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final current = value;
    final hasValue = current != null && current.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Semantics(
        button: true,
        label: label,
        value: hasValue ? Dates.calendarDate(current, l10n.languageCode) : '',
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: enabled ? () => _pick(context) : null,
          child: InputDecorator(
            isEmpty: !hasValue,
            decoration: InputDecoration(
              labelText: label,
              helperText: helperText,
              errorText: errorText,
              enabled: enabled,
              suffixIcon: hasValue && enabled
                  ? IconButton(
                      tooltip: l10n.t('commonClear'),
                      icon: const Icon(PhosphorIconsRegular.x),
                      onPressed: () => onChanged(null),
                    )
                  : const Icon(PhosphorIconsRegular.calendarBlank),
            ),
            child: hasValue ? Text(Dates.calendarDate(current, l10n.languageCode)) : null,
          ),
        ),
      ),
    );
  }
}

/// A labelled group of single- or multiple-choice rows with an error line.
class _ChoiceGroup extends StatelessWidget {
  const _ChoiceGroup({required this.label, required this.children, this.helperText, this.errorText});

  final String? label;
  final List<Widget> children;
  final String? helperText;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final heading = label;
    final help = helperText;
    final error = errorText;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (heading != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(heading, style: theme.textTheme.titleSmall),
            ),
          if (help != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(help, style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
            ),
          Container(
            decoration: BoxDecoration(
              color: theme.colorScheme.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: error == null ? tokens.border : theme.colorScheme.error),
            ),
            child: Column(children: children),
          ),
          if (error != null)
            Padding(
              padding: const EdgeInsetsDirectional.only(top: 6, start: 12),
              child: Text(error, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
            ),
        ],
      ),
    );
  }
}

class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.label,
    required this.selected,
    required this.multiple,
    required this.enabled,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final bool multiple;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final IconData icon;
    if (multiple) {
      icon = selected ? PhosphorIconsFill.checkSquare : PhosphorIconsRegular.square;
    } else {
      icon = selected ? PhosphorIconsFill.radioButton : PhosphorIconsRegular.circle;
    }
    return Semantics(
      checked: multiple ? selected : null,
      inMutuallyExclusiveGroup: !multiple,
      selected: multiple ? null : selected,
      child: ListTile(
        enabled: enabled,
        leading: Icon(icon, color: selected ? scheme.secondary : null),
        title: Text(label),
        onTap: enabled ? onTap : null,
      ),
    );
  }
}
