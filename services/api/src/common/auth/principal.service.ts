import { Injectable } from '@nestjs/common';
import { PLATFORM_ROLES, SUPPORT_GRANTABLE, SYSTEM_ROLES } from '@typease/permissions';
import type { SessionInfo } from '@typease/types';
import { env } from '../../config/env';
import { Ctx } from '../context';
import { SystemDb } from '../db/prisma.service';
import { Errors } from '../errors';
import { SUPPORT_WRITE_SCOPES } from './support-session';
import { AccessClaims } from './tokens';

/** Tenant states in which normal work is possible. */
const OPERATIONAL = ['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE'];
const CUSTOMER_FACING = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

/**
 * What the staff app needs to show the permanent "support session" banner. A superset of the shared
 * `SessionInfo.supportGrant` (id + expiresAt), so older clients keep working.
 */
export interface SupportGrantInfo {
  id: string;
  /** Granted scopes = the permissions of this session. */
  scopes: string[];
  /** The granted scopes that allow a change (see SUPPORT_WRITE_SCOPES). Empty = the session is read-only. */
  writeScopes: string[];
  readOnly: boolean;
  startsAt: string | null;
  /** The session ends at this moment at the latest (earlier if the centre revokes the access). */
  expiresAt: string;
  tenantId: string;
  tenantName: string;
  /** The reason the support agent gave when asking; the centre saw it when it approved. */
  reason: string;
}
export type ApiSessionInfo = Omit<SessionInfo, 'supportGrant'> & { supportGrant: SupportGrantInfo | null };

export interface Principal {
  context: Partial<Ctx>;
  session: ApiSessionInfo;
  tenantStatus: string | null;
  mfaSetupRequired: boolean;
}

/** A session's `lastUsedAt` is written at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

/**
 * Turns verified token claims into the request's security context by loading
 * the session, user, membership, role and (if any) support grant from the
 * database on every request. Revoking a session, suspending a member or
 * changing a role therefore takes effect immediately.
 */
@Injectable()
export class PrincipalService {
  constructor(private readonly sys: SystemDb) {}

  async resolve(claims: AccessClaims): Promise<Principal> {
    const db = this.sys.client;
    const session = await db.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
    if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt < new Date()) {
      throw Errors.unauthorized('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    }
    const user = session.user;
    // "Last used" in the list of sessions: moved forward by use, at most once a minute per session (one small
    // conditional UPDATE; two requests at the same moment cannot both write). A refresh rotates the session -
    // the row that replaces it starts with "last used: now" - so this covers the time between two refreshes.
    if (Date.now() - session.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      const now = new Date();
      await db.session
        .updateMany({ where: { id: session.id, revokedAt: null, lastUsedAt: { lte: new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS) } }, data: { lastUsedAt: now } })
        .catch(() => undefined); // never a reason to refuse a request
    }
    if (user.status !== 'ACTIVE' || user.deletedAt) throw Errors.unauthorized('ACCOUNT_DISABLED', 'This account is disabled.');
    if (user.mfaEnabled && !session.mfaVerified) throw Errors.unauthorized('MFA_REQUIRED', 'Two-step verification is required.');

    const base: Partial<Ctx> = {
      userId: user.id,
      sessionId: session.id,
      app: session.app,
      platformRole: user.platformRole,
      actorLabel: user.fullName,
      actorType: user.platformRole ? 'PLATFORM' : 'CUSTOMER',
      permissions: new Set(user.platformRole ? PLATFORM_ROLES[user.platformRole].permissions : []),
    };
    const sessionUser: SessionInfo['user'] = {
      id: user.id,
      email: user.email,
      phone: user.phone,
      fullName: user.fullName,
      preferredLanguage: user.preferredLanguage,
      platformRole: user.platformRole,
      mfaEnabled: user.mfaEnabled,
      emailVerified: !!user.emailVerifiedAt,
      phoneVerified: !!user.phoneVerifiedAt,
    };
    const enforce = env().MFA_ENFORCEMENT === 'required';

    // --- Platform staff inside a tenant under an approved, unexpired access grant -------------
    if (claims.sg) {
      if (!user.platformRole || session.supportGrantId !== claims.sg) throw Errors.unauthorized();
      const grant = await db.accessGrant.findFirst({
        where: { id: claims.sg, requestedById: user.id, status: 'APPROVED', revokedAt: null, expiresAt: { gt: new Date() } },
        include: { tenant: true },
      });
      if (!grant) throw Errors.unauthorized('SUPPORT_ACCESS_ENDED', 'Support access has expired or was revoked.');
      const scopes = grant.scopes.filter((s) => (SUPPORT_GRANTABLE as string[]).includes(s));
      return {
        context: {
          ...base,
          actorType: 'PLATFORM',
          actorLabel: `${user.fullName} (TypEase support)`,
          tenantId: grant.tenantId,
          supportGrantId: grant.id,
          permissions: new Set(scopes),
          allBranches: true,
          branchIds: [],
        },
        session: {
          user: sessionUser,
          tenant: tenantInfo(grant.tenant),
          membership: null,
          permissions: scopes,
          supportGrant: {
            id: grant.id,
            scopes,
            writeScopes: scopes.filter((s) => SUPPORT_WRITE_SCOPES.includes(s)),
            readOnly: !scopes.some((s) => SUPPORT_WRITE_SCOPES.includes(s)),
            startsAt: grant.startsAt?.toISOString() ?? null,
            expiresAt: grant.expiresAt!.toISOString(),
            tenantId: grant.tenantId,
            tenantName: grant.tenant.name,
            reason: grant.reason,
          },
          mfaRequiredSetup: false,
        },
        tenantStatus: grant.tenant.status,
        mfaSetupRequired: false,
      };
    }

    // --- Platform scope (no tenant) ---------------------------------------------------------
    if (!claims.tid || !claims.mid) {
      const mfaSetupRequired = enforce && !!user.platformRole && !user.mfaEnabled;
      return {
        context: base,
        session: {
          user: sessionUser,
          tenant: null,
          membership: null,
          permissions: [...(base.permissions ?? [])],
          supportGrant: null,
          mfaRequiredSetup: mfaSetupRequired,
        },
        tenantStatus: null,
        mfaSetupRequired,
      };
    }

    // --- Tenant member -----------------------------------------------------------------------
    const m = await db.tenantMembership.findFirst({
      where: { id: claims.mid, userId: user.id, tenantId: claims.tid },
      include: { tenant: true, role: { include: { rolePermissions: true } }, membershipBranches: true },
    });
    if (!m || m.status !== 'ACTIVE' || session.membershipId !== m.id) {
      throw Errors.unauthorized('MEMBERSHIP_INACTIVE', 'Your access to this centre is no longer active.');
    }
    const permissions = m.role.rolePermissions.map((rp) => rp.permissionKey);
    const mfaSetupRequired = enforce && m.kind === 'STAFF' && (SYSTEM_ROLES[m.role.key]?.requiresMfa ?? false) && !user.mfaEnabled;
    return {
      context: {
        ...base,
        actorType: m.kind,
        tenantId: m.tenantId,
        membershipId: m.id,
        roleKey: m.role.key,
        permissions: new Set(permissions),
        allBranches: m.kind !== 'STAFF' ? true : m.allBranches,
        branchIds: m.membershipBranches.map((b) => b.branchId),
        customerId: m.customerId,
        corporateAccountId: m.corporateAccountId,
        corporateEmployeeId: m.corporateEmployeeId,
      },
      session: {
        user: sessionUser,
        tenant: tenantInfo(m.tenant),
        membership: {
          id: m.id,
          kind: m.kind,
          roleKey: m.role.key,
          roleName: m.role.name,
          allBranches: m.allBranches,
          branchIds: m.membershipBranches.map((b) => b.branchId),
          customerId: m.customerId,
          corporateAccountId: m.corporateAccountId,
        },
        permissions,
        supportGrant: null,
        mfaRequiredSetup: mfaSetupRequired,
      },
      tenantStatus: m.tenant.status,
      mfaSetupRequired,
    };
  }

  static tenantUsable(status: string, kind: string): boolean {
    return (kind === 'STAFF' || kind === 'PLATFORM' ? OPERATIONAL : CUSTOMER_FACING).includes(status);
  }
}

function tenantInfo(t: { id: string; slug: string; name: string; status: string; timezone: string; defaultCurrency: string }) {
  return { id: t.id, slug: t.slug, name: t.name, status: t.status, timezone: t.timezone, currency: t.defaultCurrency };
}
