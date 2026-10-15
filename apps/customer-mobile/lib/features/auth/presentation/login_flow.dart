import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/widgets/feedback.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/auth_controller.dart';
import '../data/auth_models.dart';
import '../data/auth_repository.dart';

/// Carries on after any sign-in call (password, phone code, invitation,
/// authenticator code): stores the session, or goes to the next step.
///
/// Returns true when the user is now signed in. The router then moves to the
/// home screen by itself.
Future<bool> continueSignIn(BuildContext context, WidgetRef ref, LoginResult result) async {
  switch (result.status) {
    case LoginStatus.ok:
      await ref.read(authControllerProvider.notifier).acceptLogin(result);
      return true;
    case LoginStatus.mfaRequired:
      final challenge = result.challengeToken;
      if (challenge == null || challenge.isEmpty) {
        throw const ApiException(kind: ApiErrorKind.unknown, code: 'INCOMPLETE_LOGIN', message: '');
      }
      if (!context.mounted) return false;
      await context.push<void>(Routes.mfa, extra: challenge);
      return false;
    case LoginStatus.selectTenant:
      // The account belongs to several centres. This app signs in to the
      // centre that is selected in the app.
      final slug = ref.read(tenantControllerProvider)?.slug;
      final selection = result.selectionToken;
      AuthMembership? match;
      for (final membership in result.memberships) {
        if (membership.tenantSlug == slug && membership.kind != 'STAFF') match = membership;
      }
      if (match == null || selection == null) {
        throw const SignInRejected('loginNotRegisteredHere');
      }
      final next = await ref.read(authRepositoryProvider).selectTenant(
            selectionToken: selection,
            membershipId: match.membershipId,
          );
      if (!context.mounted) return false;
      return continueSignIn(context, ref, next);
    case LoginStatus.unknown:
      throw const ApiException(kind: ApiErrorKind.unknown, code: 'INCOMPLETE_LOGIN', message: '');
  }
}

/// The sentence to show for a failed sign-in step.
String describeSignInError(BuildContext context, Object error) {
  if (error is SignInRejected) return context.l10n.t(error.reasonKey);
  return describeError(context.l10n, error);
}
