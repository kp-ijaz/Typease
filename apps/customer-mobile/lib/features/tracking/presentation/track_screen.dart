import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/illustration.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/status_badge.dart';
import '../../../core/widgets/status_timeline.dart';
import '../../tenant/application/tenant_controller.dart';
import '../data/tracking_repository.dart';

/// Track a request with its number and the tracking code given at submission.
/// Works without signing in (guests, or someone tracking for a relative).
class TrackScreen extends ConsumerStatefulWidget {
  const TrackScreen({super.key});

  @override
  ConsumerState<TrackScreen> createState() => _TrackScreenState();
}

class _TrackScreenState extends ConsumerState<TrackScreen> {
  final TextEditingController _number = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final TextEditingController _centre = TextEditingController();
  String? _centreError;
  String? _numberError;
  String? _codeError;
  String? _formError;
  bool _busy = false;
  TrackedRequest? _result;

  @override
  void dispose() {
    _number.dispose();
    _code.dispose();
    _centre.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    final number = _number.text.trim().toUpperCase();
    final code = _code.text.trim().toUpperCase();
    // A guest who has not chosen a centre names it here.
    final slug = ref.read(tenantControllerProvider)?.slug ?? _centre.text.trim().toLowerCase();
    setState(() {
      _centreError = slug.isEmpty
          ? l10n.t('centreCodeRequired')
          : (Validators.isSlug(slug) ? null : l10n.t('centreCodeInvalid'));
      _numberError = number.isEmpty ? l10n.t('trackNumberRequired') : null;
      _codeError = code.isEmpty ? l10n.t('trackCodeRequired') : null;
      _formError = null;
    });
    if (_centreError != null || _numberError != null || _codeError != null || _busy) return;
    FocusScope.of(context).unfocus();
    setState(() => _busy = true);
    try {
      final result = await ref.read(trackingRepositoryProvider).track(tenantSlug: slug, requestNo: number, trackingCode: code);
      if (mounted) setState(() => _result = result);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _result = null;
        _formError = error.statusCode == 404 ? l10n.t('trackNotFound') : describeError(l10n, error);
      });
    } catch (error) {
      if (mounted) setState(() => _formError = describeError(l10n, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final result = _result;
    final formError = _formError;
    final upper = <TextInputFormatter>[_UpperCaseFormatter()];
    final hasCentre = ref.watch(tenantControllerProvider) != null;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('trackTitle'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
        children: <Widget>[
          if (result == null) ...<Widget>[
            const Center(
              child: SpotIllustration(
                icon: PhosphorIconsRegular.path,
                satellites: <IconData>[PhosphorIconsRegular.hash, PhosphorIconsRegular.checkCircle, PhosphorIconsRegular.clock],
                size: 190,
              ),
            ),
            const SizedBox(height: 12),
            Text(l10n.t('trackHeadline'), textAlign: TextAlign.center, style: theme.textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              l10n.t('trackBody'),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: tokens.mutedText),
            ),
            const SizedBox(height: 24),
          ],
          if (formError != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: InfoBanner(tone: Tone.danger, icon: PhosphorIconsRegular.warningCircle, message: formError),
            ),
          if (!hasCentre)
            AppTextField(
              key: const Key('track-centre'),
              controller: _centre,
              label: l10n.t('centreCodeLabel'),
              hintText: 'al-noor',
              errorText: _centreError,
              forceLtr: true,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.next,
              prefixIcon: PhosphorIconsRegular.storefront,
            ),
          AppTextField(
            key: const Key('track-number'),
            controller: _number,
            label: l10n.t('trackNumberLabel'),
            hintText: 'AN-000062',
            errorText: _numberError,
            forceLtr: true,
            inputFormatters: upper,
            textInputAction: TextInputAction.next,
            prefixIcon: PhosphorIconsRegular.hash,
          ),
          AppTextField(
            key: const Key('track-code'),
            controller: _code,
            label: l10n.t('trackCodeLabel'),
            hintText: 'XXXXX-XXXXX',
            helperText: l10n.t('trackCodeHelp'),
            errorText: _codeError,
            forceLtr: true,
            inputFormatters: upper,
            textInputAction: TextInputAction.done,
            prefixIcon: PhosphorIconsRegular.key,
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 4),
          PrimaryButton(
            key: const Key('track-submit'),
            label: result == null ? l10n.t('trackSubmit') : l10n.t('trackRefresh'),
            icon: PhosphorIconsRegular.magnifyingGlass,
            loading: _busy,
            onPressed: _submit,
          ),
          if (result != null) ...<Widget>[const SizedBox(height: 24), _TrackResult(result: result)],
        ],
      ),
    );
  }
}

class _TrackResult extends StatelessWidget {
  const _TrackResult({required this.result});

  final TrackedRequest result;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final language = l10n.languageCode;
    final done = result.status == 'COMPLETED';
    final steps = result.timeline;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(gradient: tokens.brandGradient, borderRadius: BorderRadius.circular(AppTheme.radiusLg)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                result.requestNo,
                style: theme.textTheme.labelMedium?.copyWith(color: tokens.onBrand.withValues(alpha: 0.8), letterSpacing: 1),
              ),
              const SizedBox(height: 6),
              Text(
                context.pick(result.serviceName, result.serviceNameAr),
                style: theme.textTheme.titleLarge?.copyWith(color: tokens.onBrand),
              ),
              const SizedBox(height: 14),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: BoxDecoration(color: tokens.onBrand.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(99)),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Icon(done ? PhosphorIconsFill.checkCircle : PhosphorIconsFill.circleNotch, size: 16, color: tokens.onBrand),
                    const SizedBox(width: 6),
                    Text(
                      result.statusLabel.resolve(language),
                      style: theme.textTheme.labelLarge?.copyWith(color: tokens.onBrand, fontSize: 13.5),
                    ),
                  ],
                ),
              ),
              if (result.submittedAt != null) ...<Widget>[
                const SizedBox(height: 14),
                Text(
                  l10n.t('trackSubmittedOn', <String, Object?>{'date': Dates.date(result.submittedAt, language)}),
                  style: theme.textTheme.bodySmall?.copyWith(color: tokens.onBrand.withValues(alpha: 0.85)),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        if (steps.isNotEmpty)
          SectionCard(
            title: l10n.t('trackProgress'),
            child: StatusTimeline(
              entries: <TimelineEntry>[
                for (var i = 0; i < steps.length; i++)
                  TimelineEntry(
                    title: steps[i].label.resolve(language),
                    subtitle: Dates.dateTime(steps[i].at, language),
                    state: i == steps.length - 1 && !done ? TimelineState.current : TimelineState.done,
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _UpperCaseFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    return newValue.copyWith(text: newValue.text.toUpperCase());
  }
}
