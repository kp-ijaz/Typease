import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../documents/application/document_providers.dart';
import '../../documents/data/document_models.dart';
import '../../documents/presentation/document_actions.dart';
import '../application/form_engine.dart';
import '../application/requests_providers.dart';
import '../data/form_schema.dart';
import '../data/request_models.dart';
import '../data/requests_repository.dart';
import 'checklist_tile.dart';
import 'dynamic_form_field.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// New request wizard.
///
/// The draft already exists on the server (it was created when the customer
/// tapped "Start request"), and every step is saved there, so the request can
/// be continued later or on another device.
///
/// Steps: the pages of the service's dynamic form -> documents -> review and
/// submit. After submitting, the tracking code is shown once.
class RequestWizardScreen extends ConsumerStatefulWidget {
  const RequestWizardScreen({super.key, required this.requestId});

  final String requestId;

  @override
  ConsumerState<RequestWizardScreen> createState() => _RequestWizardScreenState();
}

class _RequestWizardScreenState extends ConsumerState<RequestWizardScreen> {
  RequestDetail? _detail;
  Object? _loadError;
  bool _loading = true;
  bool _saving = false;
  int _step = 0;

  /// Current answers: what the server has, plus unsaved edits.
  final Map<String, Object?> _values = <String, Object?>{};
  final Map<String, TextEditingController> _controllers = <String, TextEditingController>{};
  final TextEditingController _instructions = TextEditingController();
  final ScrollController _scroll = ScrollController();
  Map<String, String> _errors = <String, String>{};
  String? _linkingItemId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    _instructions.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // ------------------------------------------------------------------ data

  Future<void> _load() async {
    // Called from initState (already "loading") and from "Try again".
    if (!_loading || _loadError != null) {
      setState(() {
        _loading = true;
        _loadError = null;
      });
    }
    try {
      final detail = await ref.read(requestsRepositoryProvider).detail(widget.requestId);
      if (!mounted) return;
      if (!detail.isDraft) {
        // Already submitted (perhaps on another device): show the case instead.
        context.pushReplacement(Routes.request(detail.id));
        return;
      }
      _adopt(detail, replaceValues: true);
      setState(() => _loading = false);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = error;
      });
    }
  }

  /// Reloads checklist and submit state after an upload, keeping typed text.
  Future<void> _reloadQuietly() async {
    try {
      final detail = await ref.read(requestsRepositoryProvider).detail(widget.requestId);
      if (!mounted) return;
      setState(() => _adopt(detail, replaceValues: false));
      ref.invalidate(checklistAssistProvider(widget.requestId));
    } catch (_) {
      // The next action reports a problem if there is one.
    }
  }

  void _adopt(RequestDetail detail, {required bool replaceValues}) {
    _detail = detail;
    if (replaceValues) {
      _values
        ..clear()
        ..addAll(detail.formValues);
      for (final entry in _controllers.entries) {
        final text = _values[entry.key]?.toString() ?? '';
        if (entry.value.text != text) entry.value.text = text;
      }
      _instructions.text = detail.customerInstructions ?? '';
    }
  }

  TextEditingController _controllerFor(FormFieldDef field) {
    return _controllers.putIfAbsent(field.key, () => TextEditingController(text: _values[field.key]?.toString() ?? ''));
  }

  static bool _usesController(FormFieldDef field) {
    return field.type == FormFieldType.text ||
        field.type == FormFieldType.textarea ||
        field.type == FormFieldType.number ||
        field.type == FormFieldType.email ||
        field.type == FormFieldType.phone;
  }

  void _setValue(FormFieldDef field, Object? value) {
    setState(() {
      _values[field.key] = value;
      _errors = Map<String, String>.of(_errors)..remove(field.key);
    });
  }

  // ------------------------------------------------------------------ steps

  int get _formStepCount => _detail?.formSchema.steps.length ?? 0;
  int get _documentsStep => _formStepCount;
  int get _reviewStep => _formStepCount + 1;
  int get _stepCount => _formStepCount + 2;

  void _goTo(int step) {
    setState(() => _step = step);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  /// Validates and saves the answers of form step [index].
  /// With [draftOnly] empty required fields are accepted (leaving the wizard).
  Future<bool> _saveFormStep(int index, {bool draftOnly = false}) async {
    final detail = _detail;
    if (detail == null || index >= detail.formSchema.steps.length) return true;
    final l10n = context.l10n;
    final schema = detail.formSchema;
    final step = schema.steps[index];
    final keys = <String>{for (final field in step.fields) field.key};

    final issues = FormEngine.validate(schema, _values, partial: draftOnly, onlyKeys: keys);
    if (issues.isNotEmpty && !draftOnly) {
      final messages = <String, String>{};
      for (final field in step.fields) {
        final issue = issues[field.key];
        if (issue != null) messages[field.key] = describeFormIssue(l10n, field, issue);
      }
      setState(() => _errors = messages);
      return false;
    }

    final payload = FormEngine.payload(schema, _values, onlyKeys: keys);
    if (payload.isEmpty) {
      setState(() => _errors = <String, String>{});
      return true;
    }
    setState(() {
      _saving = true;
      _errors = <String, String>{};
    });
    try {
      final saved = await ref.read(requestsRepositoryProvider).saveFields(detail.id, payload);
      if (!mounted) return false;
      setState(() => _adopt(saved, replaceValues: false));
      return true;
    } on ApiException catch (error) {
      if (!mounted) return false;
      final fields = error.fieldErrorMap;
      if (fields.isNotEmpty) {
        // Field messages from the server (FORM_INVALID.details).
        setState(() => _errors = fields);
      }
      if (!draftOnly) showError(context, error);
      return false;
    } catch (error) {
      if (!mounted) return false;
      if (!draftOnly) showError(context, error);
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _next() async {
    if (_saving) return;
    if (_step < _formStepCount) {
      final ok = await _saveFormStep(_step);
      if (!ok || !mounted) return;
    }
    if (_step == _documentsStep) await _reloadQuietly();
    if (!mounted) return;
    if (_step < _stepCount - 1) _goTo(_step + 1);
  }

  Future<void> _back() async {
    if (_saving) return;
    if (_step == 0) {
      await _leave();
      return;
    }
    // Keep what was typed on this page without insisting on completeness.
    if (_step < _formStepCount) await _saveFormStep(_step, draftOnly: true);
    if (!mounted) return;
    _goTo(_step - 1);
  }

  /// Leaves the wizard. The draft stays on the server.
  Future<void> _leave() async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (_step < _formStepCount) await _saveFormStep(_step, draftOnly: true);
    await _saveInstructions(silent: true);
    ref.invalidate(requestListProvider);
    ref.invalidate(activeRequestsProvider);
    ref.invalidate(requestCountsProvider);
    if (!mounted) return;
    messenger?.showSnackBar(SnackBar(content: Text(l10n.t('wizardDraftSaved'))));
    if (context.canPop()) {
      context.pop();
    } else {
      context.go(Routes.requests);
    }
  }

  Future<bool> _saveInstructions({bool silent = false}) async {
    final detail = _detail;
    if (detail == null) return true;
    final text = _instructions.text.trim();
    if (text == (detail.customerInstructions ?? '').trim()) return true;
    try {
      final saved = await ref.read(requestsRepositoryProvider).updateInstructions(
            detail.id,
            instructions: text,
            version: detail.version,
          );
      if (mounted) setState(() => _adopt(saved, replaceValues: false));
      return true;
    } catch (error) {
      if (mounted && !silent) showError(context, error);
      return false;
    }
  }

  Future<void> _submit() async {
    final detail = _detail;
    if (detail == null || _saving) return;
    final l10n = context.l10n;
    setState(() => _saving = true);
    try {
      if (!await _saveInstructions()) return;
      final submitted = await ref.read(requestsRepositoryProvider).submit(detail.id);
      ref.invalidate(requestListProvider);
      ref.invalidate(activeRequestsProvider);
      ref.invalidate(actionRequestsProvider);
      ref.invalidate(requestCountsProvider);
      ref.invalidate(requestDetailProvider(detail.id));
      if (!mounted) return;
      await _showTrackingCode(submitted);
      if (!mounted) return;
      context.pushReplacement(Routes.request(submitted.id));
    } on ApiException catch (error) {
      if (!mounted) return;
      final fields = error.fieldErrorMap;
      if (error.code == 'FORM_INVALID' && fields.isNotEmpty) {
        // Take the customer to the first page that still has a problem.
        var target = _formStepCount;
        for (final key in fields.keys) {
          final index = detail.formSchema.stepIndexOf(key);
          if (index >= 0 && index < target) target = index;
        }
        setState(() {
          _errors = fields;
          if (target < _formStepCount) _step = target;
        });
        showMessage(context, l10n.t('wizardFixFields'), isError: true);
      } else {
        showError(context, error);
      }
    } catch (error) {
      if (!mounted) return;
      showError(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// The tracking code is returned once by `submit`; the server only keeps
  /// its hash. It lets the customer follow the request without signing in.
  Future<void> _showTrackingCode(RequestDetail submitted) async {
    final code = submitted.trackingCode;
    final l10n = context.l10n;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        final theme = Theme.of(dialogContext);
        return AlertDialog(
          icon: Icon(PhosphorIconsFill.checkCircle, color: BrandTokens.of(dialogContext).success, size: 40),
          title: Text(l10n.t('wizardSubmittedTitle')),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(l10n.t('wizardSubmittedBody', <String, Object?>{'number': submitted.requestNo})),
                if (code != null && code.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 16),
                  Text(l10n.t('wizardTrackingLabel'), style: theme.textTheme.labelLarge),
                  const SizedBox(height: 6),
                  SelectableText(
                    code,
                    textDirection: TextDirection.ltr,
                    style: theme.textTheme.headlineSmall?.copyWith(letterSpacing: 2),
                  ),
                  const SizedBox(height: 6),
                  Text(l10n.t('wizardTrackingOnce'), style: theme.textTheme.bodySmall),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: code));
                      if (dialogContext.mounted) {
                        ScaffoldMessenger.maybeOf(dialogContext)?.showSnackBar(SnackBar(content: Text(l10n.t('commonCopied'))));
                      }
                    },
                    icon: const Icon(PhosphorIconsRegular.copy, size: 18),
                    label: Text(l10n.t('wizardCopyCode')),
                  ),
                ],
              ],
            ),
          ),
          actions: <Widget>[
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: Text(l10n.t('wizardViewRequest')),
            ),
          ],
        );
      },
    );
  }

  // ------------------------------------------------------------------ documents

  Future<void> _openUpload(ChecklistItem item) async {
    await context.push<void>(Routes.requestUpload(widget.requestId, checklistItemId: item.id));
    if (!mounted) return;
    await _reloadQuietly();
  }

  Future<void> _reuse(ChecklistItem item, AssistCandidate candidate) async {
    setState(() => _linkingItemId = item.id);
    try {
      final updated = await ref.read(requestsRepositoryProvider).linkDocument(widget.requestId, item.id, candidate.documentId);
      if (!mounted) return;
      setState(() => _adopt(updated, replaceValues: false));
      ref.invalidate(checklistAssistProvider(widget.requestId));
    } catch (error) {
      if (!mounted) return;
      showError(context, error);
    } finally {
      if (mounted) setState(() => _linkingItemId = null);
    }
  }

  // ------------------------------------------------------------------ build

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final detail = _detail;

    if (_loading || detail == null) {
      final error = _loadError;
      return Scaffold(
        appBar: AppBar(title: Text(l10n.t('wizardTitle'))),
        body: error != null ? ErrorStateView(error: error, onRetry: _load) : const LoadingView(),
      );
    }

    final isLastStep = _step == _reviewStep;
    final submitTransition = detail.transitionTo('SUBMITTED');
    final submitBlocked = submitTransition != null && !submitTransition.enabled;
    final String stepTitle;
    if (_step < _formStepCount) {
      stepTitle = detail.formSchema.steps[_step].displayTitle(l10n.languageCode);
    } else if (_step == _documentsStep) {
      stepTitle = l10n.t('wizardDocumentsTitle');
    } else {
      stepTitle = l10n.t('wizardReviewTitle');
    }

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) _back();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            tooltip: _step == 0 ? l10n.t('wizardSaveAndClose') : l10n.t('commonBack'),
            icon: Icon(_step == 0 ? PhosphorIconsRegular.x : PhosphorIconsRegular.arrowLeft),
            onPressed: _back,
          ),
          title: Text(context.pick(detail.serviceName, detail.serviceNameAr), maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: <Widget>[
            TextButton(key: const Key('wizard-save-draft'), onPressed: _saving ? null : _leave, child: Text(l10n.t('wizardSaveDraft'))),
          ],
        ),
        body: Column(
          children: <Widget>[
            _StepHeader(current: _step + 1, total: _stepCount, title: stepTitle),
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                children: _stepChildren(context, detail),
              ),
            ),
          ],
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: isLastStep
                ? PrimaryButton(
                    key: const Key('wizard-submit'),
                    label: l10n.t('wizardSubmit'),
                    icon: PhosphorIconsFill.paperPlaneRight,
                    loading: _saving,
                    onPressed: submitBlocked ? null : _submit,
                  )
                : PrimaryButton(key: const Key('wizard-next'), label: l10n.t('commonNext'), loading: _saving, onPressed: _next),
          ),
        ),
      ),
    );
  }

  List<Widget> _stepChildren(BuildContext context, RequestDetail detail) {
    if (_step < _formStepCount) return _formStep(context, detail, detail.formSchema.steps[_step]);
    if (_step == _documentsStep) return _documentsStepChildren(context, detail);
    return _reviewStepChildren(context, detail);
  }

  List<Widget> _formStep(BuildContext context, RequestDetail detail, FormStepDef step) {
    final l10n = context.l10n;
    final visible = FormEngine.visibleKeys(detail.formSchema, _values).toSet();
    final description = step.description;
    final fields = step.fields.where((f) => visible.contains(f.key)).toList();
    return <Widget>[
      if (description != null && description.trim().isNotEmpty)
        Padding(padding: const EdgeInsets.only(bottom: 16), child: Text(description)),
      if (fields.any((f) => f.isRequired))
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(l10n.t('wizardRequiredHint'), style: Theme.of(context).textTheme.bodySmall),
        ),
      for (final field in fields)
        DynamicFormField(
          key: ValueKey<String>('field-${field.key}'),
          field: field,
          value: _values[field.key],
          controller: _usesController(field) ? _controllerFor(field) : null,
          errorText: _errors[field.key],
          enabled: !_saving,
          onChanged: (value) => _setValue(field, value),
        ),
      if (fields.isEmpty) Text(l10n.t('wizardNoFields')),
    ];
  }

  List<Widget> _documentsStepChildren(BuildContext context, RequestDetail detail) {
    final l10n = context.l10n;
    final assist = ref.watch(checklistAssistProvider(detail.id)).valueOrNull;
    final items = detail.inputItems;
    final canUpload = detail.can('upload_documents');
    return <Widget>[
      Text(l10n.t('wizardDocumentsIntro')),
      const SizedBox(height: 12),
      if (items.isEmpty)
        SectionCard(child: Text(l10n.t('wizardNoDocumentsNeeded')))
      else
        SectionCard(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Column(
            children: <Widget>[
              for (var i = 0; i < items.length; i++) ...<Widget>[
                if (i > 0) const Divider(),
                ChecklistTile(
                  item: items[i],
                  assist: assist?.forItem(items[i].id),
                  busy: _linkingItemId == items[i].id,
                  onUpload: canUpload ? () => _openUpload(items[i]) : null,
                  onReuse: (candidate) => _reuse(items[i], candidate),
                  onView: items[i].document == null ? null : () => openDocument(context, ref, items[i].document!.id),
                ),
              ],
            ],
          ),
        ),
      InfoBanner(tone: Tone.neutral, icon: PhosphorIconsRegular.lockSimple, message: l10n.t('wizardDocumentsPrivacy')),
    ];
  }

  List<Widget> _reviewStepChildren(BuildContext context, RequestDetail detail) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final schema = detail.formSchema;
    final visible = FormEngine.visibleKeys(schema, _values).toSet();
    final submitTransition = detail.transitionTo('SUBMITTED');
    final blockedMessage = (submitTransition != null && !submitTransition.enabled) ? submitTransition.blockedMessage : null;
    final missingMandatory = detail.inputItems.where((c) => c.blocksSubmission).toList();

    return <Widget>[
      if (blockedMessage != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: InfoBanner(tone: Tone.warning, icon: PhosphorIconsRegular.warning, title: l10n.t('wizardCannotSubmitYet'), message: blockedMessage),
        ),
      for (var i = 0; i < schema.steps.length; i++)
        SectionCard(
          title: schema.steps[i].displayTitle(l10n.languageCode),
          trailing: TextButton(onPressed: _saving ? null : () => _goTo(i), child: Text(l10n.t('commonEdit'))),
          child: Column(
            children: <Widget>[
              for (final field in schema.steps[i].fields)
                if (visible.contains(field.key))
                  DetailRow(
                    label: field.displayLabel(l10n.languageCode),
                    value: describeFormValue(l10n, field, _values[field.key]),
                  ),
            ],
          ),
        ),
      SectionCard(
        title: l10n.t('wizardDocumentsTitle'),
        trailing: TextButton(onPressed: _saving ? null : () => _goTo(_documentsStep), child: Text(l10n.t('commonEdit'))),
        child: detail.inputItems.isEmpty
            ? Text(l10n.t('wizardNoDocumentsNeeded'))
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  for (final item in detail.inputItems)
                    DetailRow(
                      label: context.pick(item.label, item.labelAr),
                      value: l10n.tOr('checklistShort_${item.status}', item.status),
                    ),
                  if (missingMandatory.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        l10n.t('wizardMissingDocuments', <String, Object?>{'count': missingMandatory.length}),
                        style: theme.textTheme.bodySmall?.copyWith(color: BrandTokens.of(context).warning),
                      ),
                    ),
                ],
              ),
      ),
      SectionCard(
        title: l10n.t('wizardInstructionsTitle'),
        child: TextField(
          controller: _instructions,
          enabled: !_saving,
          minLines: 2,
          maxLines: 5,
          maxLength: 2000,
          decoration: InputDecoration(hintText: l10n.t('wizardInstructionsHint')),
        ),
      ),
      InfoBanner(icon: PhosphorIconsRegular.flag, title: l10n.t('wizardWhatNextTitle'), message: l10n.t('wizardWhatNextBody')),
    ];
  }
}

/// "Step 2 of 4" with a progress bar and the page title.
class _StepHeader extends StatelessWidget {
  const _StepHeader({required this.current, required this.total, required this.title});

  final int current;
  final int total;
  final String title;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final progress = l10n.t('wizardStepOf', <String, Object?>{'current': current, 'total': total});
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surface,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(progress, style: theme.textTheme.labelMedium?.copyWith(color: tokens.mutedText)),
          const SizedBox(height: 2),
          Semantics(header: true, child: Text(title, style: theme.textTheme.titleMedium)),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(value: total == 0 ? 0 : current / total, minHeight: 6, semanticsLabel: progress),
          ),
        ],
      ),
    );
  }
}
