import '../../../core/utils/json.dart';

/// `SessionInfo.user`
class SessionUser {
  const SessionUser({
    required this.id,
    required this.email,
    required this.fullName,
    required this.preferredLanguage,
    required this.mfaEnabled,
    required this.emailVerified,
    required this.phoneVerified,
    this.phone,
  });

  factory SessionUser.fromJson(Object? json) {
    final map = asMap(json);
    return SessionUser(
      id: asString(map['id']),
      email: asString(map['email']),
      phone: asStringOrNull(map['phone']),
      fullName: asString(map['fullName']),
      preferredLanguage: asString(map['preferredLanguage'], 'en'),
      mfaEnabled: asBool(map['mfaEnabled']),
      emailVerified: asBool(map['emailVerified']),
      phoneVerified: asBool(map['phoneVerified']),
    );
  }

  final String id;
  final String email;
  final String? phone;
  final String fullName;
  final String preferredLanguage;
  final bool mfaEnabled;
  final bool emailVerified;
  final bool phoneVerified;

  /// First word of the name, for the greeting.
  String get firstName {
    final trimmed = fullName.trim();
    if (trimmed.isEmpty) return '';
    return trimmed.split(RegExp(r'\s+')).first;
  }
}

/// `SessionInfo.tenant`
class SessionTenant {
  const SessionTenant({
    required this.id,
    required this.slug,
    required this.name,
    required this.status,
    required this.timezone,
    required this.currency,
  });

  factory SessionTenant.fromJson(Object? json) {
    final map = asMap(json);
    return SessionTenant(
      id: asString(map['id']),
      slug: asString(map['slug']),
      name: asString(map['name']),
      status: asString(map['status']),
      timezone: asString(map['timezone'], 'Asia/Dubai'),
      currency: asString(map['currency'], 'AED'),
    );
  }

  final String id;
  final String slug;
  final String name;
  final String status;
  final String timezone;
  final String currency;
}

/// `SessionInfo.membership`
class SessionMembership {
  const SessionMembership({
    required this.id,
    required this.kind,
    required this.roleKey,
    required this.roleName,
    this.customerId,
    this.corporateAccountId,
  });

  factory SessionMembership.fromJson(Object? json) {
    final map = asMap(json);
    return SessionMembership(
      id: asString(map['id']),
      kind: asString(map['kind']),
      roleKey: asString(map['roleKey']),
      roleName: asString(map['roleName']),
      customerId: asStringOrNull(map['customerId']),
      corporateAccountId: asStringOrNull(map['corporateAccountId']),
    );
  }

  final String id;

  /// `STAFF`, `CUSTOMER` or `CORPORATE`.
  final String kind;
  final String roleKey;
  final String roleName;
  final String? customerId;
  final String? corporateAccountId;
}

/// Returned by `GET /auth/me` and embedded in sign-in responses.
class SessionInfo {
  const SessionInfo({required this.user, required this.permissions, this.tenant, this.membership});

  factory SessionInfo.fromJson(Object? json) {
    final map = asMap(json);
    final tenant = asMapOrNull(map['tenant']);
    final membership = asMapOrNull(map['membership']);
    return SessionInfo(
      user: SessionUser.fromJson(map['user']),
      tenant: tenant == null ? null : SessionTenant.fromJson(tenant),
      membership: membership == null ? null : SessionMembership.fromJson(membership),
      permissions: asStringList(map['permissions']),
    );
  }

  final SessionUser user;
  final SessionTenant? tenant;
  final SessionMembership? membership;
  final List<String> permissions;

  bool can(String permission) => permissions.contains(permission);

  /// This app is for customers and company users; staff use the centre web app.
  bool get isPortalMember => membership?.kind == 'CUSTOMER' || membership?.kind == 'CORPORATE';

  /// True when the signed-in user has a personal customer record.
  bool get hasCustomerProfile => membership?.kind == 'CUSTOMER' && membership?.customerId != null;
}

/// One entry of `SELECT_TENANT.memberships`.
class AuthMembership {
  const AuthMembership({
    required this.membershipId,
    required this.tenantSlug,
    required this.tenantName,
    required this.kind,
  });

  factory AuthMembership.fromJson(Object? json) {
    final map = asMap(json);
    return AuthMembership(
      membershipId: asString(map['membershipId']),
      tenantSlug: asString(map['tenantSlug']),
      tenantName: asString(map['tenantName']),
      kind: asString(map['kind']),
    );
  }

  final String membershipId;
  final String tenantSlug;
  final String tenantName;
  final String kind;
}

enum LoginStatus { ok, mfaRequired, selectTenant, unknown }

/// The three shapes of `LoginResult` (packages/types/src/api.ts).
class LoginResult {
  const LoginResult({
    required this.status,
    this.accessToken,
    this.refreshToken,
    this.expiresIn,
    this.session,
    this.challengeToken,
    this.selectionToken,
    this.memberships = const <AuthMembership>[],
  });

  factory LoginResult.fromJson(Object? json) {
    final map = asMap(json);
    final status = asString(map['status']);
    if (status == 'OK') {
      return LoginResult(
        status: LoginStatus.ok,
        accessToken: asStringOrNull(map['accessToken']),
        refreshToken: asStringOrNull(map['refreshToken']),
        expiresIn: asIntOrNull(map['expiresIn']),
        session: SessionInfo.fromJson(map['session']),
      );
    }
    if (status == 'MFA_REQUIRED') {
      return LoginResult(status: LoginStatus.mfaRequired, challengeToken: asStringOrNull(map['challengeToken']));
    }
    if (status == 'SELECT_TENANT') {
      return LoginResult(
        status: LoginStatus.selectTenant,
        selectionToken: asStringOrNull(map['selectionToken']),
        memberships: asMapList(map['memberships']).map(AuthMembership.fromJson).toList(growable: false),
      );
    }
    return const LoginResult(status: LoginStatus.unknown);
  }

  final LoginStatus status;
  final String? accessToken;

  /// Present for the mobile app only (web apps get an HttpOnly cookie).
  final String? refreshToken;
  final int? expiresIn;
  final SessionInfo? session;
  final String? challengeToken;
  final String? selectionToken;
  final List<AuthMembership> memberships;

  /// A complete, usable sign-in.
  bool get hasTokens {
    final access = accessToken;
    final refresh = refreshToken;
    return status == LoginStatus.ok && access != null && access.isNotEmpty && refresh != null && refresh.isNotEmpty && session != null;
  }
}

/// A "sent" acknowledgement. In local development the API also returns the
/// secret that would normally only be delivered by email or SMS (`dev` field).
class DeliveryAck {
  const DeliveryAck({required this.status, this.devToken, this.devOtp});

  factory DeliveryAck.fromJson(Object? json) {
    final map = asMap(json);
    final dev = asMap(map['dev']);
    return DeliveryAck(
      status: asString(map['status']),
      devToken: asStringOrNull(dev['emailVerificationToken']) ?? asStringOrNull(dev['passwordResetToken']),
      devOtp: asStringOrNull(dev['otp']),
    );
  }

  final String status;
  final String? devToken;
  final String? devOtp;
}

/// `GET /auth/invitations/preview`
class InvitationPreview {
  const InvitationPreview({
    required this.email,
    required this.centreName,
    required this.needsPassword,
    this.fullName,
  });

  factory InvitationPreview.fromJson(Object? json) {
    final map = asMap(json);
    return InvitationPreview(
      email: asString(map['email']),
      fullName: asStringOrNull(map['fullName']),
      centreName: asString(map['centreName']),
      needsPassword: asBool(map['needsPassword'], true),
    );
  }

  final String email;
  final String? fullName;
  final String centreName;
  final bool needsPassword;
}

/// One row of `GET /auth/sessions`.
class AuthSession {
  const AuthSession({
    required this.id,
    required this.app,
    required this.current,
    this.deviceName,
    this.ip,
    this.createdAt,
    this.lastUsedAt,
  });

  factory AuthSession.fromJson(Object? json) {
    final map = asMap(json);
    return AuthSession(
      id: asString(map['id']),
      app: asString(map['app']),
      deviceName: asStringOrNull(map['deviceName']),
      ip: asStringOrNull(map['ip']),
      createdAt: asStringOrNull(map['createdAt']),
      lastUsedAt: asStringOrNull(map['lastUsedAt']),
      current: asBool(map['current']),
    );
  }

  final String id;
  final String app;
  final String? deviceName;
  final String? ip;
  final String? createdAt;
  final String? lastUsedAt;
  final bool current;
}
