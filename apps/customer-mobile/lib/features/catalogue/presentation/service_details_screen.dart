import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/money.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/money_text.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/application/auth_controller.dart';
import '../../requests/application/requests_providers.dart';
import '../../requests/data/requests_repository.dart';
import '../application/catalogue_providers.dart';
import '../data/catalogue_models.dart';
import '../../../core/theme/app_theme.dart';
import 'catalogue_screen.dart' show processingTimeLabel;
import 'category_icons.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// Service details: what the centre does, the documents to prepare, fee
/// ESTIMATES (labelled as such) and the processing time. One primary action:
/// start the request.
class ServiceDetailsScreen extends ConsumerStatefulWidget {
  const ServiceDetailsScreen({super.key, required this.serviceId, this.renewalOf});

  final String serviceId;
  final String? renewalOf;

  @override
  ConsumerState<ServiceDetailsScreen> createState() => _ServiceDetailsScreenState();
}

class _ServiceDetailsScreenState extends ConsumerState<ServiceDetailsScreen> {
  bool _starting = false;

  Future<void> _start(CatalogueService service) async {
    if (_starting) return;
    final l10n = context.l10n;
    final repository = ref.read(requestsRepositoryProvider);
    setState(() => _starting = true);
    try {
      // Offer to continue an unfinished draft of the same service instead of
      // silently creating a second one.
      final drafts = await repository.list(statuses: const <String>['DRAFT'], serviceId: service.id, pageSize: 1);
      if (!mounted) return;
      if (drafts.items.isNotEmpty && (widget.renewalOf == null || widget.renewalOf!.isEmpty)) {
        final resume = await showConfirmDialog(
          context,
          title: l10n.t('serviceDraftExistsTitle'),
          message: l10n.t('serviceDraftExistsBody', <String, Object?>{'number': drafts.items.first.requestNo}),
          confirmLabel: l10n.t('serviceDraftContinue'),
        );
        if (!mounted) return;
        if (resume) {
          await context.push<void>(Routes.requestWizard(drafts.items.first.id));
          return;
        }
      }
      // The draft is created on the server now, so it can be continued on
      // another device.
      final draft = await repository.create(serviceId: service.id, renewalOfScheduleId: widget.renewalOf);
      ref.invalidate(requestListProvider);
      ref.invalidate(activeRequestsProvider);
      ref.invalidate(requestCountsProvider);
      if (!mounted) return;
      await context.push<void>(Routes.requestWizard(draft.id));
    } catch (error) {
      if (!mounted) return;
      showError(context, error);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final service = ref.watch(serviceDetailProvider(widget.serviceId));
    final loaded = service.valueOrNull;
    final guest = !ref.watch(authControllerProvider.select((auth) => auth.isSignedIn));

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('serviceTitle'))),
      body: AsyncValueView<CatalogueService>(
        value: service,
        onRetry: () => ref.invalidate(serviceDetailProvider(widget.serviceId)),
        data: (data) => _ServiceBody(service: data),
      ),
      bottomNavigationBar: loaded == null
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: guest
                    ? PrimaryButton(
                        key: const Key('service-sign-in'),
                        label: l10n.t('serviceGuestCta'),
                        icon: PhosphorIconsRegular.signIn,
                        onPressed: () => context.go(Routes.login),
                      )
                    : loaded.onlineAvailable
                    ? PrimaryButton(
                        key: const Key('service-start'),
                        label: l10n.t('serviceStart'),
                        icon: PhosphorIconsRegular.arrowRight,
                        loading: _starting,
                        onPressed: () => _start(loaded),
                      )
                    : InfoBanner(tone: Tone.neutral, message: l10n.t('serviceNotOnline')),
              ),
            ),
    );
  }
}

class _ServiceBody extends StatelessWidget {
  const _ServiceBody({required this.service});

  final CatalogueService service;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final description = context.pick(service.description, service.descriptionAr);
    final guidance = service.eligibilityGuidance;
    final hours = service.estimatedProcessingHours;
    final price = service.price;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: <Widget>[
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(gradient: tokens.brandGradient, borderRadius: BorderRadius.circular(AppTheme.radiusLg)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: tokens.onBrand.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(AppTheme.radiusMd),
                ),
                child: Icon(categoryIcon(service.categoryIcon), color: tokens.onBrand, size: 24),
              ),
              const SizedBox(height: 14),
              Semantics(
                header: true,
                child: Text(
                  context.pick(service.name, service.nameAr),
                  style: theme.textTheme.headlineSmall?.copyWith(color: tokens.onBrand),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                context.pick(service.categoryName, service.categoryNameAr),
                style: theme.textTheme.bodyMedium?.copyWith(color: tokens.onBrand.withValues(alpha: 0.82)),
              ),
              if (hours != null || price != null) ...<Widget>[
                const SizedBox(height: 16),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    if (hours != null) _HeroChip(icon: PhosphorIconsRegular.clock, label: processingTimeLabel(context, hours)),
                    if (price != null)
                      _HeroChip(
                        icon: PhosphorIconsRegular.tag,
                        label: l10n.t('catalogueFromEstimate', <String, Object?>{'amount': Money.format(price.total, price.currency)}),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        if (description.isNotEmpty)
          SectionCard(title: l10n.t('serviceAbout'), child: Text(description, style: theme.textTheme.bodyMedium)),
        // What the centre itself does. Never a claim of official authorisation.
        InfoBanner(
          tone: Tone.neutral,
          icon: PhosphorIconsRegular.info,
          title: l10n.t('serviceScopeTitle'),
          message: l10n.tOr('serviceScope_${service.complianceCapability}', l10n.t('serviceScope_DOCUMENT_PREPARATION_ONLY')),
        ),
        const SizedBox(height: 12),
        if (guidance != null && guidance.trim().isNotEmpty)
          SectionCard(title: l10n.t('serviceGuidance'), child: Text(guidance, style: theme.textTheme.bodyMedium)),
        SectionCard(
          title: l10n.t('serviceDocuments'),
          child: service.requirements.isEmpty
              ? Text(l10n.t('serviceNoDocuments'))
              : Column(
                  children: <Widget>[
                    for (final requirement in service.requirements)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Container(
                              width: 34,
                              height: 34,
                              decoration: BoxDecoration(color: tokens.surfaceMuted, borderRadius: BorderRadius.circular(AppTheme.radiusSm)),
                              child: Icon(PhosphorIconsRegular.fileText, size: 18, color: tokens.brand),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: <Widget>[
                                  Text(context.pick(requirement.label, requirement.labelAr)),
                                  if (requirement.description != null && requirement.description!.trim().isNotEmpty)
                                    Text(
                                      requirement.description!,
                                      style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            StatusBadge(
                              label: requirement.isMandatory ? l10n.t('commonRequired') : l10n.t('commonOptional'),
                              tone: requirement.isMandatory ? Tone.info : Tone.neutral,
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
        if (price != null) _FeeEstimateCard(price: price),
      ],
    );
  }
}

/// Fee estimates. Service fee, government fee and third-party charges are
/// shown separately, and every estimated amount says that it is an estimate.
class _FeeEstimateCard extends StatelessWidget {
  const _FeeEstimateCard({required this.price});

  final ServicePrice price;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);

    Widget row(String label, String amount, {bool estimate = false, bool strong = false}) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(label, style: strong ? theme.textTheme.titleSmall : theme.textTheme.bodyMedium),
                  if (estimate)
                    Text(l10n.t('feeEstimateTag'), style: theme.textTheme.bodySmall?.copyWith(color: tokens.warning)),
                ],
              ),
            ),
            MoneyText(amount, currency: price.currency, style: strong ? theme.textTheme.titleSmall : theme.textTheme.bodyMedium),
          ],
        ),
      );
    }

    return SectionCard(
      title: l10n.t('serviceFees'),
      trailing: StatusBadge(label: l10n.t('feeEstimateBadge'), tone: Tone.warning),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          row(l10n.t('feeService'), price.serviceFee),
          if (!Money.isZero(price.governmentFeeEstimate)) row(l10n.t('feeGovernment'), price.governmentFeeEstimate, estimate: true),
          if (!Money.isZero(price.thirdPartyFeeEstimate)) row(l10n.t('feeThirdParty'), price.thirdPartyFeeEstimate, estimate: true),
          if (!Money.isZero(price.taxAmount)) row(l10n.t('feeTax'), price.taxAmount),
          const Divider(height: 16),
          row(l10n.t('feeTotalEstimate'), price.total, estimate: price.containsEstimates, strong: true),
          const SizedBox(height: 8),
          Text(l10n.t('feeEstimateNote'), style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText)),
          const SizedBox(height: 6),
          Text(
            l10n.tOr('paymentPolicy_${price.paymentPolicy}', ''),
            style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
          ),
        ],
      ),
    );
  }
}

class _HeroChip extends StatelessWidget {
  const _HeroChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final tokens = BrandTokens.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
      decoration: BoxDecoration(color: tokens.onBrand.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(99)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 15, color: tokens.onBrand),
          const SizedBox(width: 6),
          Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: tokens.onBrand)),
        ],
      ),
    );
  }
}
