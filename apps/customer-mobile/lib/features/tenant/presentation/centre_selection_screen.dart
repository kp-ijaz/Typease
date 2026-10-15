import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/providers.dart';
import '../../../core/routing/deep_links.dart';
import '../../../core/routing/routes.dart';
import '../../../core/utils/validators.dart';
import '../../../core/widgets/feedback.dart';
import '../../../core/widgets/form_fields.dart';
import '../../../core/widgets/illustration.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/status_badge.dart';
import '../../auth/presentation/auth_scaffold.dart';
import '../application/tenant_controller.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// First launch (or "Switch centre"): the user tells the app which typing
/// centre they are a customer of.
///
/// The centre is always verified with the server
/// (`GET /public/tenant-config`); the app then takes its name, logo and
/// colours from the answer. Opening an invitation or portal link does the
/// same without typing.
class CentreSelectionScreen extends ConsumerStatefulWidget {
  const CentreSelectionScreen({super.key, this.toRegister = false});

  /// Continue to registration instead of sign-in once the centre is known.
  final bool toRegister;

  @override
  ConsumerState<CentreSelectionScreen> createState() => _CentreSelectionScreenState();
}

class _CentreSelectionScreenState extends ConsumerState<CentreSelectionScreen> {
  final TextEditingController _code = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    final input = _code.text.trim();
    if (input.isEmpty) {
      setState(() => _error = l10n.t('centreCodeRequired'));
      return;
    }

    // A pasted link is accepted as well as a plain code.
    String? slug;
    String? host;
    final uri = Uri.tryParse(input);
    if (uri != null && uri.hasScheme && input.contains('://')) {
      final config = ref.read(appConfigProvider);
      final target = DeepLinkParser(scheme: config.deepLinkScheme, allowedHosts: config.deepLinkHosts).parse(uri);
      slug = target?.tenantSlug;
      host = target?.tenantHost;
      if (slug == null && host == null) {
        setState(() => _error = l10n.t('centreLinkNotRecognised'));
        return;
      }
    } else {
      final candidate = input.toLowerCase();
      if (!Validators.isSlug(candidate)) {
        setState(() => _error = l10n.t('centreCodeInvalid'));
        return;
      }
      slug = candidate;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final controller = ref.read(tenantControllerProvider.notifier);
      if (slug != null) {
        await controller.select(slug);
      } else if (host != null) {
        await controller.selectByHost(host);
      }
      // The redirect rules keep /centre reachable while signed out (to switch
      // centre), so moving on to sign-in is up to this screen.
      if (mounted) context.go(widget.toRegister ? Routes.register : Routes.login);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.statusCode == 404 ? l10n.t('centreNotFound') : describeError(l10n, error);
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = describeError(l10n, error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AuthScaffold(
      title: l10n.t('centreTitle'),
      subtitle: l10n.t('centreSubtitle'),
      hero: const SpotIllustration(
        icon: PhosphorIconsRegular.storefront,
        satellites: <IconData>[PhosphorIconsRegular.qrCode, PhosphorIconsRegular.mapPin, PhosphorIconsRegular.sealCheck],
        size: 200,
      ),
      children: <Widget>[
        AppTextField(
          key: const Key('centre-code'),
          controller: _code,
          label: l10n.t('centreCodeLabel'),
          hintText: l10n.t('centreCodeHint'),
          helperText: l10n.t('centreCodeHelp'),
          errorText: _error,
          forceLtr: true,
          keyboardType: TextInputType.url,
          textInputAction: TextInputAction.done,
          prefixIcon: PhosphorIconsRegular.storefront,
          onSubmitted: (_) => _submit(),
        ),
        const SizedBox(height: 4),
        PrimaryButton(
          key: const Key('centre-submit'),
          label: l10n.t('commonContinue'),
          icon: PhosphorIconsRegular.arrowRight,
          onPressed: _submit,
          loading: _busy,
        ),
        OrDivider(label: l10n.t('commonOr')),
        InfoBanner(
          tone: Tone.neutral,
          icon: PhosphorIconsRegular.qrCode,
          title: l10n.t('centreLinkTitle'),
          message: l10n.t('centreLinkBody'),
        ),
      ],
    );
  }
}
