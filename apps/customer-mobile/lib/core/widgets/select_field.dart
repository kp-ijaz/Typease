import 'package:flutter/material.dart';

import '../l10n/l10n_ext.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

class SelectOption {
  const SelectOption({required this.value, required this.label});

  final String value;
  final String label;
}

/// A single-choice field that opens a searchable list. Used instead of a
/// drop-down so long lists (countries, services) stay usable on a phone.
class SelectField extends StatelessWidget {
  const SelectField({
    super.key,
    required this.label,
    required this.options,
    required this.value,
    required this.onChanged,
    this.errorText,
    this.helperText,
    this.hintText,
    this.enabled = true,
    this.allowClear = false,
  });

  final String label;
  final List<SelectOption> options;
  final String? value;
  final ValueChanged<String?> onChanged;
  final String? errorText;
  final String? helperText;
  final String? hintText;
  final bool enabled;
  final bool allowClear;

  String? get _selectedLabel {
    for (final option in options) {
      if (option.value == value) return option.label;
    }
    return null;
  }

  Future<void> _open(BuildContext context) async {
    final picked = await showModalBottomSheet<_Picked>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => _SelectSheet(title: label, options: options, selected: value, allowClear: allowClear),
    );
    if (picked != null) onChanged(picked.value);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selected = _selectedLabel;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      value: selected ?? '',
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: enabled ? () => _open(context) : null,
        child: InputDecorator(
          isEmpty: selected == null,
          decoration: InputDecoration(
            labelText: label,
            hintText: hintText,
            helperText: helperText,
            errorText: errorText,
            enabled: enabled,
            suffixIcon: const Icon(PhosphorIconsRegular.caretDown),
          ),
          child: selected == null ? null : Text(selected, style: theme.textTheme.bodyLarge),
        ),
      ),
    );
  }
}

class _Picked {
  const _Picked(this.value);

  final String? value;
}

class _SelectSheet extends StatefulWidget {
  const _SelectSheet({required this.title, required this.options, required this.selected, required this.allowClear});

  final String title;
  final List<SelectOption> options;
  final String? selected;
  final bool allowClear;

  @override
  State<_SelectSheet> createState() => _SelectSheetState();
}

class _SelectSheetState extends State<_SelectSheet> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final needle = _query.trim().toLowerCase();
    final visible = needle.isEmpty
        ? widget.options
        : widget.options.where((o) => o.label.toLowerCase().contains(needle) || o.value.toLowerCase() == needle).toList();
    final showSearch = widget.options.length > 8;
    final maxHeight = MediaQuery.of(context).size.height * 0.75;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Row(
                children: <Widget>[
                  Expanded(child: Text(widget.title, style: theme.textTheme.titleMedium)),
                  if (widget.allowClear && widget.selected != null)
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(const _Picked(null)),
                      child: Text(l10n.t('commonClear')),
                    ),
                ],
              ),
            ),
            if (showSearch)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  autofocus: false,
                  textInputAction: TextInputAction.search,
                  decoration: InputDecoration(
                    prefixIcon: const Icon(PhosphorIconsRegular.magnifyingGlass),
                    hintText: l10n.t('commonSearch'),
                  ),
                  onChanged: (text) => setState(() => _query = text),
                ),
              ),
            Flexible(
              child: visible.isEmpty
                  ? Padding(padding: const EdgeInsets.all(24), child: Text(l10n.t('commonNoMatches')))
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: visible.length,
                      itemBuilder: (context, index) {
                        final option = visible[index];
                        final isSelected = option.value == widget.selected;
                        return ListTile(
                          title: Text(option.label),
                          selected: isSelected,
                          trailing: isSelected ? const Icon(PhosphorIconsBold.check) : null,
                          onTap: () => Navigator.of(context).pop(_Picked(option.value)),
                        );
                      },
                    ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
