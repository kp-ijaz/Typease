import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/utils/countries.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/select_field.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/data/auth_repository.dart';
import '../application/profile_providers.dart';
import '../data/profile_models.dart';
import '../data/profile_repository.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

const List<String> _emirates = <String>[
  'Abu Dhabi',
  'Dubai',
  'Sharjah',
  'Ajman',
  'Umm Al Quwain',
  'Ras Al Khaimah',
  'Fujairah',
];

/// Localisation key of an emirate name, e.g. `emirate_Abu_Dhabi`.
String _emirateKey(String emirate) {
  final slug = emirate.replaceAll(' ', '_');
  return 'emirate_$slug';
}

/// Edit the fields a customer may change themselves: name, Arabic name,
/// language and address. Everything else is changed by the centre.
class EditProfileScreen extends ConsumerStatefulWidget {
  const EditProfileScreen({super.key});

  @override
  ConsumerState<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends ConsumerState<EditProfileScreen> {
  final TextEditingController _name = TextEditingController();
  final TextEditingController _nameAr = TextEditingController();
  final TextEditingController _line1 = TextEditingController();
  final TextEditingController _city = TextEditingController();
  String _language = 'en';
  String? _emirate;
  String? _country;
  bool _seeded = false;
  bool _busy = false;
  Map<String, String> _errors = <String, String>{};
  String? _formError;

  @override
  void dispose() {
    _name.dispose();
    _nameAr.dispose();
    _line1.dispose();
    _city.dispose();
    super.dispose();
  }

  void _seed(CustomerProfile profile) {
    if (_seeded) return;
    _seeded = true;
    _name.text = profile.fullName;
    _nameAr.text = profile.fullNameAr ?? '';
    _language = profile.preferredLanguage == 'ar' ? 'ar' : 'en';
    final address = profile.address;
    _line1.text = address?.line1 ?? '';
    _city.text = address?.city ?? '';
    final emirate = address?.emirate;
    _emirate = (emirate != null && _emirates.contains(emirate)) ? emirate : null;
    final country = address?.country;
    _country = (country == null || country.isEmpty) ? null : country.toUpperCase();
  }

  Future<void> _save() async {
    if (_busy) return;
    final l10n = context.l10n;
    final errors = <String, String>{};
    if (_name.text.trim().length < 2) errors['fullName'] = l10n.t('validationNameRequired');
    setState(() {
      _errors = errors;
      _formError = null;
    });
    if (errors.isNotEmpty) return;

    setState(() => _busy = true);
    try {
      await ref.read(profileRepositoryProvider).update(
            fullName: _name.text,
            fullNameAr: _nameAr.text,
            preferredLanguage: _language,
            address: PostalAddress(line1: _line1.text, city: _city.text, emirate: _emirate, country: _country),
          );
      // The sign-in account carries its own copy of name and language.
      await ref.read(authRepositoryProvider).updateAccount(fullName: _name.text, preferredLanguage: _language);
      await ref.read(authControllerProvider.notifier).reloadSession();
      ref.invalidate(profileProvider);
      if (!mounted) return;
      showMessage(context, l10n.t('profileSaved'));
      context.pop();
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      setState(() {
        _errors = fields;
        _formError = fields.isEmpty ? describeError(l10n, error) : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _formError = describeError(l10n, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final language = l10n.languageCode;
    final profile = ref.watch(profileProvider);
    final formError = _formError;
    final loaded = profile.valueOrNull;
    if (loaded != null) _seed(loaded);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('profileEditTitle'))),
      body: AsyncValueView<CustomerProfile>(
        value: profile,
        onRetry: () => ref.invalidate(profileProvider),
        data: (_) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: <Widget>[
            if (formError != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
              ),
            AppTextField(
              controller: _name,
              label: l10n.t('fieldFullName'),
              errorText: _errors['fullName'],
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.next,
              enabled: !_busy,
            ),
            AppTextField(
              controller: _nameAr,
              label: l10n.t('fieldFullNameAr'),
              errorText: _errors['fullNameAr'],
              textInputAction: TextInputAction.next,
              enabled: !_busy,
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: SelectField(
                label: l10n.t('profileLanguage'),
                helperText: l10n.t('profileLanguageHelp'),
                value: _language,
                enabled: !_busy,
                options: const <SelectOption>[
                  SelectOption(value: 'en', label: 'English'),
                  SelectOption(value: 'ar', label: 'العربية'),
                ],
                onChanged: (value) => setState(() => _language = value ?? 'en'),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 10),
              child: Semantics(
                header: true,
                child: Text(l10n.t('profileAddress'), style: Theme.of(context).textTheme.titleMedium),
              ),
            ),
            AppTextField(
              controller: _line1,
              label: l10n.t('profileAddressLine'),
              errorText: _errors['address.line1'],
              textInputAction: TextInputAction.next,
              enabled: !_busy,
            ),
            AppTextField(
              controller: _city,
              label: l10n.t('profileCity'),
              errorText: _errors['address.city'],
              textInputAction: TextInputAction.done,
              enabled: !_busy,
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: SelectField(
                label: l10n.t('profileEmirate'),
                value: _emirate,
                enabled: !_busy,
                allowClear: true,
                options: <SelectOption>[
                  for (final emirate in _emirates) SelectOption(value: emirate, label: l10n.tOr(_emirateKey(emirate), emirate)),
                ],
                onChanged: (value) => setState(() => _emirate = value),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: SelectField(
                label: l10n.t('profileCountry'),
                value: _country,
                enabled: !_busy,
                allowClear: true,
                options: <SelectOption>[
                  for (final country in Countries.sorted(language)) SelectOption(value: country.code, label: country.name(language)),
                ],
                onChanged: (value) => setState(() => _country = value),
              ),
            ),
            InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.info, message: l10n.t('profileEditNote')),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: PrimaryButton(label: l10n.t('commonSave'), loading: _busy, onPressed: loaded == null ? null : _save),
        ),
      ),
    );
  }
}
