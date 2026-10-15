import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import type { MembershipKind, User } from '@typease/database';
import type { AppKey, AuthMembership, LoginResult, SessionInfo } from '@typease/types';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ApiSessionInfo, PrincipalService } from '../../common/auth/principal.service';
import { signAccessToken } from '../../common/auth/tokens';
import { ctx, tryCtx } from '../../common/context';
import { decryptText, encryptText, numericCode, randomToken, sha256 } from '../../common/crypto';
import { SystemDb, Tx } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { Messenger } from '../../common/messenger';
import { assertPasswordPolicy, passwordPolicy } from '../../common/password-policy';
import { isWhiteLabel } from '../../common/white-label';
import { SequenceService } from '../../common/sequence.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
/** Verified against when the account does not exist, so timing does not reveal which emails are registered. */
let dummyHash: Promise<string> | undefined;
const DUMMY_HASH = () => (dummyHash ??= hash('typease-timing-equaliser', ARGON));

const KINDS_FOR_APP: Record<string, MembershipKind[]> = {
  centre: ['STAFF'],
  customer: ['CUSTOMER', 'CORPORATE'],
  mobile: ['CUSTOMER', 'CORPORATE'],
  corporate: ['CORPORATE'],
};
const APP_URL = (app: string | undefined) => {
  const e = env();
  return { centre: e.CENTRE_WEB_URL, customer: e.CUSTOMER_WEB_URL, mobile: e.CUSTOMER_WEB_URL, corporate: e.CORPORATE_WEB_URL, platform: e.PLATFORM_ADMIN_URL }[app ?? 'customer'] ?? e.CUSTOMER_WEB_URL;
};

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  session: ApiSessionInfo;
  landing: string;
}
export type LoginOutcome =
  | ({ status: 'OK' } & IssuedSession)
  | { status: 'MFA_REQUIRED'; challengeToken: string }
  | { status: 'SELECT_TENANT'; selectionToken: string; memberships: AuthMembership[] };

export const hashPassword = (plain: string) => hash(plain, ARGON);

/**
 * Live sessions one user may have per app (staff app, customer portal, mobile ...). A sign-in beyond that ends
 * the oldest ones, so that sessions cannot pile up without limit (forgotten devices, scripted sign-ins).
 */
export const MAX_LIVE_SESSIONS_PER_APP = 20;
export const SESSION_LIMIT_REASON = 'SESSION_LIMIT';

/** Lifetime of the one-time code that carries a support session from the platform console to the staff app. */
export const SUPPORT_HANDOFF_TTL_SECONDS = 60;
const SUPPORT_HANDOFF = 'SUPPORT_HANDOFF';
const SUPPORT_TENANT_STATES = ['ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE'];

/** Issuer of authenticator-app entries wherever the centre's own brand does not apply. */
export const MFA_ISSUER = 'TypEase';

@Injectable()
export class AuthService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly messenger: Messenger,
    private readonly principals: PrincipalService,
    private readonly tenants: TenantResolver,
    private readonly sequences: SequenceService,
  ) {}

  // ------------------------------------------------------------------ one-time tokens
  async createToken(
    type: string,
    opts: { userId?: string | null; tenantId?: string | null; target?: string; ttlSeconds: number; meta?: Record<string, unknown>; secret?: string; maxAttempts?: number },
    tx: Tx = this.sys.client as unknown as Tx,
  ): Promise<string> {
    const secret = opts.secret ?? randomToken(32);
    await tx.authToken.create({
      data: {
        type,
        userId: opts.userId ?? null,
        tenantId: opts.tenantId ?? null,
        target: opts.target ?? null,
        tokenHash: sha256(secret),
        meta: (opts.meta ?? {}) as any,
        maxAttempts: opts.maxAttempts ?? 5,
        expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000),
      },
    });
    return secret;
  }

  /** Atomically consume a link-style token (256-bit secret looked up by hash). */
  async consumeToken(type: string, secret: string) {
    const token = await this.sys.client.authToken.findFirst({ where: { type, tokenHash: sha256(secret) } });
    if (!token || token.consumedAt || token.expiresAt < new Date()) {
      throw Errors.badRequest('TOKEN_INVALID', 'This link is invalid or has expired. Please request a new one.');
    }
    const claimed = await this.sys.client.authToken.updateMany({ where: { id: token.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw Errors.badRequest('TOKEN_INVALID', 'This link has already been used.');
    return token;
  }

  /** Verify a short numeric code for a target (phone). Attempts are counted and capped. */
  async verifyCode(type: string, target: string, code: string) {
    const token = await this.sys.client.authToken.findFirst({
      where: { type, target, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) throw Errors.badRequest('CODE_INVALID', 'The code is incorrect or has expired.');
    if (token.attempts >= token.maxAttempts) throw Errors.tooMany('Too many incorrect codes. Request a new code.');
    if (token.tokenHash !== sha256(`${target}:${code}`)) {
      await this.sys.client.authToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
      throw Errors.badRequest('CODE_INVALID', 'The code is incorrect or has expired.');
    }
    const claimed = await this.sys.client.authToken.updateMany({ where: { id: token.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw Errors.badRequest('CODE_INVALID', 'The code has already been used.');
    return token;
  }

  private dev<T extends object>(body: T, extra: Record<string, string>): T {
    return env().EXPOSE_DEV_TOKENS && env().NODE_ENV !== 'production' ? { ...body, dev: extra } : body;
  }

  // ------------------------------------------------------------------ sessions
  private async issue(
    user: User,
    opts: { app: string; tenantId?: string | null; membershipId?: string | null; mfaVerified: boolean; supportGrantId?: string | null; familyId?: string; deviceName?: string | null },
  ): Promise<IssuedSession> {
    const c = tryCtx();
    const refreshToken = randomToken(48);
    let expiresAt = new Date(Date.now() + env().REFRESH_TTL_DAYS * 86400_000);
    if (opts.supportGrantId) {
      // A support session never outlives the access the centre approved (it is also re-checked on every request).
      const grant = await this.sys.client.accessGrant.findUnique({ where: { id: opts.supportGrantId }, select: { expiresAt: true } });
      if (grant?.expiresAt && grant.expiresAt < expiresAt) expiresAt = grant.expiresAt;
    }
    const session = await this.sys.client.session.create({
      data: {
        userId: user.id,
        tenantId: opts.tenantId ?? null,
        membershipId: opts.membershipId ?? null,
        supportGrantId: opts.supportGrantId ?? null,
        app: opts.app,
        refreshTokenHash: sha256(refreshToken),
        familyId: opts.familyId ?? randomUUID(),
        mfaVerified: opts.mfaVerified,
        userAgent: c?.userAgent?.slice(0, 300) ?? null,
        ip: c?.ip ?? null,
        deviceName: opts.deviceName ?? null,
        expiresAt,
      },
    });
    await this.enforceSessionLimit(user.id, opts.app, session.id);
    const claims = {
      sub: user.id,
      sid: session.id,
      app: opts.app,
      ...(opts.tenantId && opts.membershipId ? { tid: opts.tenantId, mid: opts.membershipId } : {}),
      ...(opts.supportGrantId ? { sg: opts.supportGrantId } : {}),
    };
    const { token, expiresIn } = signAccessToken(claims);
    const principal = await this.principals.resolve(claims);
    return { accessToken: token, expiresIn, refreshToken, session: principal.session, landing: landingFor(opts.app, principal.session) };
  }

  /**
   * Keeps at most MAX_LIVE_SESSIONS_PER_APP live sessions of the user in this app: everything older than the
   * newest twenty is ended (reason SESSION_LIMIT). The session that was just created is never one of them.
   */
  private async enforceSessionLimit(userId: string, app: string, keepSessionId: string): Promise<number> {
    const surplus = await this.sys.client.session.findMany({
      where: { userId, app, revokedAt: null, expiresAt: { gt: new Date() }, id: { not: keepSessionId } },
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: MAX_LIVE_SESSIONS_PER_APP - 1,
      select: { id: true },
    });
    if (!surplus.length) return 0;
    const ended = await this.sys.client.session.updateMany({ where: { id: { in: surplus.map((s) => s.id) }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: SESSION_LIMIT_REASON } });
    if (ended.count) await this.audit.security('SESSION_LIMIT_REACHED', 'INFO', { userId, app, ended: ended.count, limit: MAX_LIVE_SESSIONS_PER_APP }, null);
    return ended.count;
  }

  private async membershipsFor(userId: string, app: string, tenantId?: string | null): Promise<AuthMembership[]> {
    const kinds = KINDS_FOR_APP[app] ?? [];
    const rows = await this.sys.client.tenantMembership.findMany({
      where: { userId, status: 'ACTIVE', kind: { in: kinds }, ...(tenantId ? { tenantId } : {}), tenant: { status: { notIn: ['ARCHIVED'] } } },
      include: { tenant: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      membershipId: m.id,
      tenantId: m.tenantId,
      tenantSlug: m.tenant.slug,
      tenantName: m.tenant.name,
      kind: m.kind,
      roleKey: m.role.key,
      roleName: m.role.name,
    }));
  }

  private async completeLogin(user: User, app: string, tenantId: string | null, mfaVerified: boolean, deviceName?: string | null): Promise<LoginOutcome> {
    if (app === 'platform') {
      if (!user.platformRole) throw Errors.forbidden('NO_ACCESS', 'This account does not have access to the platform console.');
      return { status: 'OK', ...(await this.issue(user, { app, mfaVerified, deviceName })) };
    }
    const memberships = await this.membershipsFor(user.id, app, tenantId);
    if (!memberships.length) {
      throw Errors.forbidden('NO_ACCESS', app === 'centre' ? 'This account is not a staff member of any centre.' : 'This account is not registered with this centre.');
    }
    if (memberships.length > 1) {
      const selectionToken = await this.createToken('TENANT_SELECTION', { userId: user.id, ttlSeconds: 600, meta: { app, mfaVerified, deviceName } });
      return { status: 'SELECT_TENANT', selectionToken, memberships };
    }
    const m = memberships[0];
    return { status: 'OK', ...(await this.issue(user, { app, tenantId: m.tenantId, membershipId: m.membershipId, mfaVerified, deviceName })) };
  }

  private async record(email: string | null, userId: string | null, success: boolean, reason: string | null, app?: string, tenantId?: string | null) {
    const c = tryCtx();
    await this.sys.client.loginActivity.create({
      data: { email, userId, success, reason, app, tenantId: tenantId ?? null, ip: c?.ip ?? null, userAgent: c?.userAgent?.slice(0, 300) ?? null },
    });
  }

  // ------------------------------------------------------------------ password login
  async login(input: { email: string; password: string; app: AppKey; tenantSlug?: string; deviceName?: string }): Promise<LoginOutcome> {
    const tenantId = input.app === 'platform' ? null : await this.tenants.resolveId(input.tenantSlug);
    const user = await this.sys.client.user.findUnique({ where: { email: input.email } });
    const invalid = () => Errors.unauthorized('INVALID_CREDENTIALS', 'The email or password is incorrect.');

    if (!user || !user.passwordHash || user.deletedAt) {
      await verify(await DUMMY_HASH(), input.password).catch(() => false);
      await this.record(input.email, null, false, 'UNKNOWN_EMAIL', input.app, tenantId);
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.record(input.email, user.id, false, 'LOCKED', input.app, tenantId);
      throw Errors.tooMany('This account is temporarily locked after too many failed attempts. Try again later or reset your password.');
    }
    const ok = await verify(user.passwordHash, input.password).catch(() => false);
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      const lock = failures >= env().LOGIN_MAX_FAILURES;
      await this.sys.client.user.update({
        where: { id: user.id },
        data: { failedLoginCount: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + env().LOGIN_LOCK_MINUTES * 60_000) : null },
      });
      await this.record(input.email, user.id, false, lock ? 'LOCKED_NOW' : 'BAD_PASSWORD', input.app, tenantId);
      await this.audit.security(lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', lock ? 'MEDIUM' : 'LOW', { email: input.email, app: input.app }, tenantId);
      throw invalid();
    }
    if (user.status !== 'ACTIVE') throw Errors.forbidden('ACCOUNT_DISABLED', 'This account is disabled.');
    if (!user.emailVerifiedAt) {
      throw Errors.forbidden('EMAIL_NOT_VERIFIED', 'Please confirm your email address first. We can send you a new confirmation link.');
    }
    await this.sys.client.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    if (user.mfaEnabled) {
      const challengeToken = await this.createToken('MFA_CHALLENGE', {
        userId: user.id,
        ttlSeconds: 300,
        meta: { app: input.app, tenantId, deviceName: input.deviceName ?? null },
      });
      return { status: 'MFA_REQUIRED', challengeToken };
    }
    const outcome = await this.completeLogin(user, input.app, tenantId, false, input.deviceName);
    await this.afterLogin(user, input.app, outcome, tenantId);
    return outcome;
  }

  private async afterLogin(user: User, app: string, outcome: LoginOutcome, tenantId: string | null) {
    if (outcome.status !== 'OK') return;
    await this.sys.client.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.record(user.email, user.id, true, null, app, outcome.session.tenant?.id ?? tenantId);
  }

  async verifyMfa(challengeToken: string, code: string): Promise<LoginOutcome> {
    const challenge = await this.sys.client.authToken.findFirst({ where: { type: 'MFA_CHALLENGE', tokenHash: sha256(challengeToken) }, include: { user: true } });
    if (!challenge?.user || challenge.consumedAt || challenge.expiresAt < new Date()) {
      throw Errors.unauthorized('MFA_CHALLENGE_EXPIRED', 'Verification timed out. Please sign in again.');
    }
    if (challenge.attempts >= challenge.maxAttempts) throw Errors.tooMany('Too many incorrect codes. Please sign in again.');
    const user = challenge.user;
    if (!(await this.checkMfaCode(user, code))) {
      await this.sys.client.authToken.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      await this.audit.security('MFA_FAILED', 'MEDIUM', { userId: user.id });
      throw Errors.unauthorized('MFA_CODE_INVALID', 'That code is not correct.');
    }
    await this.sys.client.authToken.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
    const meta = challenge.meta as any;
    const outcome = await this.completeLogin(user, meta.app, meta.tenantId ?? null, true, meta.deviceName);
    await this.afterLogin(user, meta.app, outcome, meta.tenantId ?? null);
    return outcome;
  }

  /** Accepts a current TOTP code or an unused recovery code (which is then burned). */
  private async checkMfaCode(user: User, code: string): Promise<boolean> {
    if (!user.mfaSecretEnc) return false;
    const clean = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) return authenticator.check(clean, decryptText(user.mfaSecretEnc));
    const h = sha256(clean.toUpperCase());
    if (!user.mfaRecoveryHashes.includes(h)) return false;
    await this.sys.client.user.update({ where: { id: user.id }, data: { mfaRecoveryHashes: user.mfaRecoveryHashes.filter((x) => x !== h) } });
    await this.audit.security('MFA_RECOVERY_CODE_USED', 'MEDIUM', { userId: user.id });
    return true;
  }

  async selectTenant(selectionToken: string, membershipId: string): Promise<LoginOutcome> {
    const token = await this.sys.client.authToken.findFirst({ where: { type: 'TENANT_SELECTION', tokenHash: sha256(selectionToken) }, include: { user: true } });
    if (!token?.user || token.consumedAt || token.expiresAt < new Date()) throw Errors.unauthorized('SELECTION_EXPIRED', 'Please sign in again.');
    const meta = token.meta as any;
    const membership = (await this.membershipsFor(token.user.id, meta.app)).find((m) => m.membershipId === membershipId);
    if (!membership) throw Errors.forbidden('NO_ACCESS', 'You do not have access to that centre.');
    await this.sys.client.authToken.update({ where: { id: token.id }, data: { consumedAt: new Date() } });
    const outcome: LoginOutcome = {
      status: 'OK',
      ...(await this.issue(token.user, { app: meta.app, tenantId: membership.tenantId, membershipId, mfaVerified: !!meta.mfaVerified, deviceName: meta.deviceName })),
    };
    await this.afterLogin(token.user, meta.app, outcome, membership.tenantId);
    return outcome;
  }

  /** Move the current session to another centre the user belongs to. */
  async switchTenant(membershipId: string): Promise<IssuedSession> {
    const c = ctx();
    const session = await this.sys.client.session.findUnique({ where: { id: c.sessionId! }, include: { user: true } });
    if (!session) throw Errors.unauthorized();
    const membership = (await this.membershipsFor(session.userId, session.app)).find((m) => m.membershipId === membershipId);
    if (!membership) throw Errors.forbidden('NO_ACCESS', 'You do not have access to that centre.');
    await this.sys.client.session.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokedReason: 'SWITCHED_TENANT' } });
    return this.issue(session.user, { app: session.app, tenantId: membership.tenantId, membershipId, mfaVerified: session.mfaVerified, familyId: session.familyId, deviceName: session.deviceName });
  }

  async listMemberships(): Promise<AuthMembership[]> {
    const c = ctx();
    return this.membershipsFor(c.userId!, c.app ?? 'centre');
  }

  // ------------------------------------------------------------------ refresh / logout
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const session = await this.sys.client.session.findUnique({ where: { refreshTokenHash: sha256(refreshToken) }, include: { user: true } });
    const expired = () => Errors.unauthorized('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    if (!session) throw expired();
    if (session.revokedAt) {
      if (session.revokedReason === 'ROTATED') {
        // A rotated refresh token was presented again: assume theft and end the whole session family.
        await this.sys.client.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'TOKEN_REUSE' } });
        await this.audit.security('REFRESH_TOKEN_REUSE', 'HIGH', { userId: session.userId, familyId: session.familyId }, session.tenantId);
      }
      throw expired();
    }
    if (session.expiresAt < new Date() || session.user.status !== 'ACTIVE') throw expired();
    const rotated = await this.sys.client.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'ROTATED' } });
    if (rotated.count !== 1) throw expired();
    if (session.supportGrantId) {
      const grant = await this.sys.client.accessGrant.findFirst({ where: { id: session.supportGrantId, status: 'APPROVED', revokedAt: null, expiresAt: { gt: new Date() } } });
      if (!grant) throw Errors.unauthorized('SUPPORT_ACCESS_ENDED', 'Support access has expired or was revoked.');
    }
    return this.issue(session.user, {
      app: session.app,
      tenantId: session.tenantId,
      membershipId: session.membershipId,
      supportGrantId: session.supportGrantId,
      mfaVerified: session.mfaVerified,
      familyId: session.familyId,
      deviceName: session.deviceName,
    });
  }

  async logout(refreshToken?: string): Promise<void> {
    const c = tryCtx();
    const where = refreshToken ? { refreshTokenHash: sha256(refreshToken) } : c?.sessionId ? { id: c.sessionId } : null;
    if (!where) return;
    const session = await this.sys.client.session.findFirst({ where });
    if (!session) return;
    await this.sys.client.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'LOGOUT' } });
  }

  /**
   * The user's live sessions, most recent first, at most `limit` of them. The session that asks is always in
   * the answer (flagged `current`), also when more recent ones fill the limit. `total` = all live sessions.
   */
  async listSessions(query: { limit?: number; app?: string } = {}) {
    const c = ctx();
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const where = { userId: c.userId!, revokedAt: null, expiresAt: { gt: new Date() }, ...(query.app ? { app: query.app } : {}) };
    const select = { id: true, app: true, tenantId: true, deviceName: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true, supportGrantId: true } as const;
    const [recent, total] = await Promise.all([
      this.sys.client.session.findMany({ where, orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: limit, select }),
      this.sys.client.session.count({ where }),
    ]);
    let rows = recent;
    if (c.sessionId && !rows.some((r) => r.id === c.sessionId)) {
      const current = await this.sys.client.session.findFirst({ where: { ...where, id: c.sessionId }, select });
      if (current) rows = [...rows.slice(0, limit - 1), current];
    }
    return {
      total,
      sessions: rows.map(({ supportGrantId, ...r }) => ({ ...r, supportSession: !!supportGrantId, current: r.id === c.sessionId })),
    };
  }
  async revokeSession(id: string): Promise<void> {
    const c = ctx();
    const session = await this.sys.client.session.findFirst({ where: { id, userId: c.userId! } });
    if (!session) throw Errors.notFound('Session');
    await this.sys.client.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' } });
  }
  async revokeOtherSessions(): Promise<{ revoked: number }> {
    const c = ctx();
    const r = await this.sys.client.session.updateMany({ where: { userId: c.userId!, revokedAt: null, id: { not: c.sessionId } }, data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' } });
    return { revoked: r.count };
  }
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.sys.client.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }
  async loginActivity() {
    return this.sys.client.loginActivity.findMany({
      where: { userId: ctx().userId! },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, success: true, reason: true, app: true, ip: true, userAgent: true, createdAt: true },
    });
  }

  // ------------------------------------------------------------------ registration + verification
  async registerCustomer(input: { tenantSlug?: string; fullName: string; email: string; phone?: string; password: string; preferredLanguage: string; marketingOptIn: boolean }) {
    assertPasswordPolicy(input.password);
    const tenant = await this.tenants.require(input.tenantSlug);
    if (!['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(tenant.status)) throw Errors.forbidden('TENANT_UNAVAILABLE', 'This centre is not accepting registrations at the moment.');
    if ((tenant.settings as any)?.allowSelfRegistration === false) throw Errors.forbidden('REGISTRATION_CLOSED', 'Please contact the centre to open an account.');

    const existing = await this.sys.client.user.findFirst({ where: { OR: [{ email: input.email }, ...(input.phone ? [{ phone: input.phone }] : [])] } });
    if (existing) {
      throw Errors.conflict('ACCOUNT_EXISTS', 'An account with this email or phone already exists. Please sign in, or reset your password.');
    }
    const role = await this.sys.client.role.findFirst({ where: { tenantId: tenant.id, key: 'customer' } });
    if (!role) throw new Error(`Tenant ${tenant.slug} has no customer role (not provisioned).`);
    const passwordHash = await hashPassword(input.password);
    const token = randomToken(32);
    const user = await this.sys.tx(async (tx) => {
      const u = await tx.user.create({
        data: { email: input.email, phone: input.phone ?? null, fullName: input.fullName, passwordHash, preferredLanguage: input.preferredLanguage, passwordChangedAt: new Date() },
      });
      // The customer record is linked only after the email is proven (see verifyEmail).
      await tx.tenantMembership.create({ data: { tenantId: tenant.id, userId: u.id, roleId: role.id, kind: 'CUSTOMER', status: 'INVITED', allBranches: true } });
      await this.createToken('EMAIL_VERIFY', { userId: u.id, tenantId: tenant.id, target: u.email, ttlSeconds: 48 * 3600, secret: token, meta: { marketingOptIn: input.marketingOptIn, app: 'customer' } }, tx);
      return u;
    });
    await this.messenger.send({
      eventKey: 'account.email_verification',
      channel: 'EMAIL',
      to: user.email,
      language: user.preferredLanguage,
      tenantId: tenant.id,
      data: { name: user.fullName, link: await this.tenants.portalLink(tenant.id, '/verify-email', { token }), centre: tenant.name },
    });
    await this.audit.logSystem({ action: 'user.registered', resourceType: 'User', resourceId: user.id, summary: 'Customer self-registration' }, tenant.id);
    return this.dev({ status: 'VERIFICATION_SENT' as const, email: user.email }, { emailVerificationToken: token });
  }

  async verifyEmail(secret: string) {
    const token = await this.consumeToken('EMAIL_VERIFY', secret);
    if (!token.userId) throw Errors.badRequest('TOKEN_INVALID', 'This link is invalid.');
    const meta = token.meta as any;
    await this.sys.tx(async (tx) => {
      const user = await tx.user.update({ where: { id: token.userId! }, data: { emailVerifiedAt: new Date() } });
      const pending = await tx.tenantMembership.findMany({ where: { userId: user.id, kind: 'CUSTOMER', status: 'INVITED', customerId: null } });
      for (const m of pending) {
        // Link to an existing walk-in record ONLY on an exact, now-verified email match that
        // is unambiguous and not yet linked to another login. Otherwise create a new record.
        const candidates = await tx.customer.findMany({
          where: { tenantId: m.tenantId, email: user.email, status: 'ACTIVE', deletedAt: null, tenantMemberships: { none: {} } },
          take: 2,
        });
        const customer =
          candidates.length === 1
            ? candidates[0]
            : await tx.customer.create({
                data: {
                  tenantId: m.tenantId,
                  customerNo: await this.sequences.next(tx, 'customer', 6, m.tenantId),
                  fullName: user.fullName,
                  email: user.email,
                  phone: user.phone,
                  preferredLanguage: user.preferredLanguage,
                  marketingOptIn: !!meta?.marketingOptIn,
                  lastActivityAt: new Date(),
                },
              });
        await tx.tenantMembership.update({ where: { id: m.id }, data: { status: 'ACTIVE', customerId: customer.id, joinedAt: new Date() } });
        const now = new Date();
        for (const [purpose, granted, basis] of [
          ['SERVICE_PROCESSING', true, 'CONTRACT'],
          ['MARKETING', !!meta?.marketingOptIn, 'CONSENT'],
        ] as const) {
          await tx.consentRecord.create({
            data: { tenantId: m.tenantId, customerId: customer.id, userId: user.id, purpose, status: granted ? 'GRANTED' : 'WITHDRAWN', lawfulBasis: basis, capturedVia: 'PORTAL', ip: tryCtx()?.ip ?? null },
          });
          await tx.customerConsent.upsert({
            where: { customerId_purpose: { customerId: customer.id, purpose } },
            create: { tenantId: m.tenantId, customerId: customer.id, purpose, status: granted ? 'GRANTED' : 'WITHDRAWN', lawfulBasis: basis, grantedAt: granted ? now : null, withdrawnAt: granted ? null : now },
            update: {},
          });
        }
        await tx.outboxEvent.create({ data: { tenantId: m.tenantId, type: 'customer.created', payload: { customerId: customer.id, source: 'SELF_REGISTRATION' } } });
      }
    });
    return { status: 'VERIFIED' as const };
  }

  async resendVerification(email: string) {
    const user = await this.sys.client.user.findUnique({ where: { email } });
    let token: string | undefined;
    if (user && !user.emailVerifiedAt) {
      const membership = await this.sys.client.tenantMembership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
      token = await this.createToken('EMAIL_VERIFY', { userId: user.id, tenantId: membership?.tenantId, target: email, ttlSeconds: 48 * 3600 });
      const link =
        membership && membership.kind !== 'STAFF'
          ? await this.tenants.portalLink(membership.tenantId, '/verify-email', { token }, membership.kind === 'CORPORATE' ? 'corporate' : 'customer')
          : `${env().CENTRE_WEB_URL}/verify-email?token=${token}`;
      await this.messenger.send({ eventKey: 'account.email_verification', channel: 'EMAIL', to: email, language: user.preferredLanguage, tenantId: membership?.tenantId, data: { name: user.fullName, link } });
    }
    // Same answer whether or not the account exists.
    return this.dev({ status: 'SENT_IF_REGISTERED' as const }, token ? { emailVerificationToken: token } : {});
  }

  // ------------------------------------------------------------------ phone OTP
  async requestPhoneOtp(phone: string, purpose: 'LOGIN_OTP' | 'PHONE_VERIFY', userId?: string, language = 'en', tenantId?: string | null) {
    const code = numericCode(6);
    const recent = await this.sys.client.authToken.count({ where: { type: purpose, target: phone, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent >= 1) throw Errors.tooMany('Please wait a minute before requesting another code.');
    await this.createToken(purpose, { userId, target: phone, ttlSeconds: env().OTP_TTL_SECONDS, secret: `${phone}:${code}`, tenantId });
    await this.messenger.send({ eventKey: 'account.otp', channel: 'SMS', to: phone, language, tenantId, data: { code, minutes: Math.round(env().OTP_TTL_SECONDS / 60) } });
    return code;
  }

  async requestLoginOtp(input: { phone: string; app: AppKey; tenantSlug?: string }) {
    const tenantId = input.app === 'platform' ? null : await this.tenants.resolveId(input.tenantSlug);
    const user = await this.sys.client.user.findFirst({ where: { phone: input.phone, phoneVerifiedAt: { not: null }, status: 'ACTIVE', deletedAt: null } });
    let code: string | undefined;
    if (user) code = await this.requestPhoneOtp(input.phone, 'LOGIN_OTP', user.id, user.preferredLanguage, tenantId);
    return this.dev({ status: 'SENT_IF_REGISTERED' as const }, code ? { otp: code } : {});
  }

  async verifyLoginOtp(input: { phone: string; code: string; app: AppKey; tenantSlug?: string; deviceName?: string }): Promise<LoginOutcome> {
    const tenantId = input.app === 'platform' ? null : await this.tenants.resolveId(input.tenantSlug);
    const token = await this.verifyCode('LOGIN_OTP', input.phone, input.code);
    const user = token.userId ? await this.sys.client.user.findUnique({ where: { id: token.userId } }) : null;
    if (!user || user.status !== 'ACTIVE') throw Errors.unauthorized('INVALID_CREDENTIALS', 'The code is incorrect or has expired.');
    if (user.mfaEnabled) {
      const challengeToken = await this.createToken('MFA_CHALLENGE', { userId: user.id, ttlSeconds: 300, meta: { app: input.app, tenantId, deviceName: input.deviceName ?? null } });
      return { status: 'MFA_REQUIRED', challengeToken };
    }
    const outcome = await this.completeLogin(user, input.app, tenantId, false, input.deviceName);
    await this.afterLogin(user, input.app, outcome, tenantId);
    return outcome;
  }

  async requestPhoneVerification(phone: string) {
    const c = ctx();
    const taken = await this.sys.client.user.findFirst({ where: { phone, id: { not: c.userId! } } });
    if (taken) throw Errors.conflict('PHONE_IN_USE', 'This phone number is already linked to another account.');
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: c.userId! } });
    const code = await this.requestPhoneOtp(phone, 'PHONE_VERIFY', user.id, user.preferredLanguage, c.tenantId);
    return this.dev({ status: 'SENT' as const }, { otp: code });
  }
  async confirmPhoneVerification(phone: string, code: string) {
    const c = ctx();
    const token = await this.verifyCode('PHONE_VERIFY', phone, code);
    if (token.userId !== c.userId) throw Errors.badRequest('CODE_INVALID', 'The code is incorrect or has expired.');
    await this.sys.client.user.update({ where: { id: c.userId! }, data: { phone, phoneVerifiedAt: new Date() } });
    return { status: 'VERIFIED' as const };
  }

  // ------------------------------------------------------------------ passwords
  async forgotPassword(email: string, app?: string, tenantSlug?: string) {
    const user = await this.sys.client.user.findUnique({ where: { email } });
    let token: string | undefined;
    if (user && user.status === 'ACTIVE' && !user.deletedAt) {
      token = await this.createToken('PASSWORD_RESET', { userId: user.id, target: email, ttlSeconds: 3600 });
      const tenantId = app && app !== 'centre' && app !== 'platform' ? await this.tenants.resolveId(tenantSlug).catch(() => null) : null;
      const link = tenantId
        ? await this.tenants.portalLink(tenantId, '/reset-password', { token }, app === 'corporate' ? 'corporate' : 'customer')
        : `${APP_URL(app)}/reset-password?token=${token}`;
      await this.messenger.send({ eventKey: 'account.password_reset', channel: 'EMAIL', to: email, language: user.preferredLanguage, tenantId, data: { name: user.fullName, link, minutes: 60 } });
    }
    return this.dev({ status: 'SENT_IF_REGISTERED' as const }, token ? { passwordResetToken: token } : {});
  }

  async resetPassword(secret: string, newPassword: string) {
    // Before the link is used up: a password that is too weak must not cost the person their reset link.
    assertPasswordPolicy(newPassword);
    const token = await this.consumeToken('PASSWORD_RESET', secret);
    if (!token.userId) throw Errors.badRequest('TOKEN_INVALID', 'This link is invalid.');
    await this.sys.client.user.update({
      where: { id: token.userId },
      // Possession of the mailbox was just proven, so the address counts as verified.
      data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() },
    });
    await this.revokeAllForUser(token.userId, 'PASSWORD_RESET');
    await this.audit.security('PASSWORD_RESET', 'INFO', { userId: token.userId });
    return { status: 'PASSWORD_UPDATED' as const };
  }

  async changePassword(currentPassword: string, newPassword: string) {
    assertPasswordPolicy(newPassword, 'newPassword');
    const c = ctx();
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: c.userId! } });
    if (!user.passwordHash || !(await verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw Errors.badRequest('INVALID_CREDENTIALS', 'Your current password is not correct.');
    }
    await this.sys.client.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() } });
    await this.sys.client.session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: c.sessionId } }, data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' } });
    await this.audit.security('PASSWORD_CHANGED', 'INFO', { userId: user.id });
    return { status: 'PASSWORD_UPDATED' as const };
  }

  async updateProfile(input: { fullName?: string; preferredLanguage?: string }) {
    const c = ctx();
    await this.sys.client.user.update({ where: { id: c.userId! }, data: input });
    return { status: 'UPDATED' as const };
  }

  // ------------------------------------------------------------------ MFA (TOTP)
  async mfaSetup() {
    const c = ctx();
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: c.userId! } });
    if (user.mfaEnabled) throw Errors.conflict('MFA_ALREADY_ENABLED', 'Two-step verification is already on.');
    const secret = authenticator.generateSecret();
    await this.sys.client.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptText(secret) } });
    const issuer = await this.mfaIssuer(c.tenantId ?? null);
    return { secret, issuer, otpauthUrl: authenticator.keyuri(user.email, issuer, secret) };
  }

  /**
   * The name an authenticator app shows next to the code. People of a white-label centre (staff,
   * customers, company users) know the centre under its own brand and may never have heard of TypEase,
   * so their entry carries the centre's brand name. Platform staff, and everybody at a centre that is
   * presented as TypEase, get "TypEase". The rule for "white label" is the one the portals use (the plan
   * includes it AND the centre switched it on).
   */
  async mfaIssuer(tenantId: string | null): Promise<string> {
    if (!tenantId) return MFA_ISSUER;
    try {
      const [tenant, branding, subscription] = await Promise.all([
        this.sys.client.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        this.sys.client.brandingSettings.findFirst({ where: { tenantId, branchId: null }, select: { mode: true, businessName: true } }),
        this.sys.client.subscription.findUnique({ where: { tenantId }, select: { plan: { select: { features: true } } } }),
      ]);
      if (!tenant || !isWhiteLabel(branding?.mode, subscription?.plan.features)) return MFA_ISSUER;
      // Authenticator apps split "issuer:account" at the colon; a name is one line of ordinary length.
      const name = (branding?.businessName ?? tenant.name).replace(/[:\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
      return name || MFA_ISSUER;
    } catch {
      return MFA_ISSUER;
    }
  }

  async mfaEnable(code: string) {
    const c = ctx();
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: c.userId! } });
    if (user.mfaEnabled) throw Errors.conflict('MFA_ALREADY_ENABLED', 'Two-step verification is already on.');
    if (!user.mfaSecretEnc || !authenticator.check(code, decryptText(user.mfaSecretEnc))) {
      throw Errors.badRequest('MFA_CODE_INVALID', 'That code is not correct. Check the time on your phone and try again.');
    }
    const recoveryCodes = Array.from({ length: 10 }, () => randomToken(6).replace(/[^A-Za-z0-9]/g, 'X').slice(0, 8).toUpperCase());
    await this.sys.client.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaRecoveryHashes: recoveryCodes.map((r) => sha256(r)) } });
    // The current session proved the second factor; every other session must sign in again.
    await this.sys.client.session.update({ where: { id: c.sessionId! }, data: { mfaVerified: true } });
    await this.sys.client.session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: c.sessionId } }, data: { revokedAt: new Date(), revokedReason: 'MFA_ENABLED' } });
    await this.audit.security('MFA_ENABLED', 'INFO', { userId: user.id });
    return { status: 'MFA_ENABLED' as const, recoveryCodes };
  }

  async mfaDisable(password: string, code: string) {
    const c = ctx();
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: c.userId! } });
    if (!user.mfaEnabled) return { status: 'MFA_DISABLED' as const };
    if (!user.passwordHash || !(await verify(user.passwordHash, password).catch(() => false)) || !(await this.checkMfaCode(user, code))) {
      throw Errors.badRequest('INVALID_CREDENTIALS', 'The password or code is not correct.');
    }
    await this.sys.client.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] } });
    await this.audit.security('MFA_DISABLED', 'MEDIUM', { userId: user.id });
    return { status: 'MFA_DISABLED' as const };
  }

  // ------------------------------------------------------------------ invitations
  /**
   * Used by staff, customer-portal and corporate invitations. The membership row
   * must already be committed (status INVITED). One-time tokens live outside the
   * tenant-scoped connection, so call this AFTER the tenant transaction.
   */
  async sendInvitation(opts: { tenantId: string; membershipId: string; email: string; fullName: string; app: AppKey; language?: string; centreName: string; roleName: string }): Promise<{ token: string }> {
    // A new invitation replaces any earlier unused one for the same membership.
    await this.sys.client.authToken.updateMany({
      where: { type: 'INVITATION', tenantId: opts.tenantId, consumedAt: null, meta: { path: ['membershipId'], equals: opts.membershipId } },
      data: { consumedAt: new Date() },
    });
    const token = await this.createToken('INVITATION', { tenantId: opts.tenantId, target: opts.email, ttlSeconds: 7 * 86400, meta: { membershipId: opts.membershipId, app: opts.app, fullName: opts.fullName } });
    const link =
      opts.app === 'centre'
        ? `${env().CENTRE_WEB_URL}/accept-invitation?token=${token}`
        : await this.tenants.portalLink(opts.tenantId, '/accept-invitation', { token }, opts.app === 'corporate' ? 'corporate' : 'customer');
    await this.messenger.send({
      eventKey: 'staff.invitation',
      channel: 'EMAIL',
      to: opts.email,
      language: opts.language ?? 'en',
      tenantId: opts.tenantId,
      data: { name: opts.fullName, centre: opts.centreName, role: opts.roleName, link, days: 7 },
    });
    return { token };
  }

  async previewInvitation(secret: string) {
    const token = await this.sys.client.authToken.findFirst({ where: { type: 'INVITATION', tokenHash: sha256(secret) } });
    if (!token || token.consumedAt || token.expiresAt < new Date()) throw Errors.badRequest('TOKEN_INVALID', 'This invitation is invalid or has expired. Ask the centre to send a new one.');
    const meta = token.meta as any;
    const membership = await this.sys.client.tenantMembership.findUnique({ where: { id: meta.membershipId }, include: { tenant: true, role: true } });
    if (!membership || membership.status !== 'INVITED') throw Errors.badRequest('TOKEN_INVALID', 'This invitation is no longer valid.');
    const existing = await this.sys.client.user.findUnique({ where: { id: membership.userId } });
    return { email: token.target, fullName: meta.fullName, centreName: membership.tenant.name, roleName: membership.role.name, needsPassword: !existing?.passwordHash, app: meta.app, passwordPolicy: passwordPolicy() };
  }

  async acceptInvitation(input: { token: string; fullName?: string; password?: string; app: AppKey }): Promise<LoginOutcome> {
    const preview = await this.previewInvitation(input.token);
    if (preview.needsPassword && !input.password) throw Errors.badRequest('PASSWORD_REQUIRED', 'Choose a password to activate your account.');
    // Before the invitation is used up (see resetPassword).
    if (preview.needsPassword) assertPasswordPolicy(input.password!);
    const token = await this.consumeToken('INVITATION', input.token);
    const meta = token.meta as any;
    const membership = await this.sys.client.tenantMembership.findUniqueOrThrow({ where: { id: meta.membershipId } });
    const user = await this.sys.tx(async (tx) => {
      const u = await tx.user.update({
        where: { id: membership.userId },
        data: {
          emailVerifiedAt: new Date(),
          ...(preview.needsPassword ? { passwordHash: await hashPassword(input.password!), passwordChangedAt: new Date() } : {}),
          ...(input.fullName && preview.needsPassword ? { fullName: input.fullName } : {}),
        },
      });
      await tx.tenantMembership.update({ where: { id: membership.id }, data: { status: 'ACTIVE', joinedAt: new Date() } });
      if (membership.kind === 'CORPORATE') {
        await tx.corporateMember.updateMany({ where: { tenantId: membership.tenantId, userId: u.id, status: 'INVITED' }, data: { status: 'ACTIVE' } });
      }
      return u;
    });
    await this.audit.logSystem({ action: 'invitation.accepted', resourceType: 'TenantMembership', resourceId: membership.id }, membership.tenantId);
    if (user.mfaEnabled) {
      const challengeToken = await this.createToken('MFA_CHALLENGE', { userId: user.id, ttlSeconds: 300, meta: { app: meta.app, tenantId: membership.tenantId } });
      return { status: 'MFA_REQUIRED', challengeToken };
    }
    return { status: 'OK', ...(await this.issue(user, { app: meta.app, tenantId: membership.tenantId, membershipId: membership.id, mfaVerified: false })) };
  }

  /** Platform staff enter a tenant under an approved access grant (issued by the platform module). */
  async issueSupportSession(userId: string, grantId: string, tenantId: string): Promise<IssuedSession> {
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: userId } });
    return this.issue(user, { app: 'centre', tenantId, supportGrantId: grantId, mfaVerified: user.mfaEnabled });
  }

  // ------------------------------------------------------------------ support session hand-off
  /**
   * The platform console and the staff app live on different origins, and a token must never travel in a URL.
   * So the console receives a one-time code instead: 256 bits of randomness, stored only as a hash, valid for
   * 60 seconds, usable once. The staff app reads it from the URL fragment (never sent to a server, never in an
   * access log) and exchanges it for its own session. A new code for the same grant replaces the unused ones.
   */
  async createSupportHandoff(userId: string, grant: { id: string; tenantId: string }): Promise<{ code: string; expiresAt: Date; url: string }> {
    await this.sys.client.authToken.updateMany({
      where: { type: SUPPORT_HANDOFF, userId, consumedAt: null, meta: { path: ['grantId'], equals: grant.id } },
      data: { consumedAt: new Date() },
    });
    const code = await this.createToken(SUPPORT_HANDOFF, { userId, tenantId: grant.tenantId, ttlSeconds: SUPPORT_HANDOFF_TTL_SECONDS, meta: { grantId: grant.id }, maxAttempts: 1 });
    return { code, expiresAt: new Date(Date.now() + SUPPORT_HANDOFF_TTL_SECONDS * 1000), url: `${env().CENTRE_WEB_URL.replace(/\/+$/, '')}/support-session#code=${code}` };
  }

  /**
   * Exchanges the one-time code for a support session of the staff app. Everything is checked again at this
   * moment: the code (single use - of two simultaneous exchanges exactly one claims it), the grant (approved,
   * not revoked, not expired, asked for by this person), the platform account and the centre.
   */
  async exchangeSupportHandoff(code: string): Promise<IssuedSession> {
    const invalid = () => Errors.badRequest('HANDOFF_INVALID', 'This link is invalid, has expired or was already used. Start the support session again from the platform console.');
    const token = await this.sys.client.authToken.findFirst({ where: { type: SUPPORT_HANDOFF, tokenHash: sha256(code) } });
    if (!token || !token.userId || !token.tenantId) {
      await this.audit.security('SUPPORT_HANDOFF_REJECTED', 'MEDIUM', { reason: 'UNKNOWN_CODE' }, null);
      throw invalid();
    }
    const now = new Date();
    // The claim is one conditional UPDATE: a used or expired code matches no row.
    const claimed = await this.sys.client.authToken.updateMany({ where: { id: token.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
    if (claimed.count !== 1) {
      await this.audit.security('SUPPORT_HANDOFF_REJECTED', 'MEDIUM', { reason: token.consumedAt ? 'CODE_REUSED' : 'CODE_EXPIRED', grantId: (token.meta as any)?.grantId ?? null, userId: token.userId }, token.tenantId);
      throw invalid();
    }
    const grantId = String((token.meta as any)?.grantId ?? '');
    const [user, grant] = await Promise.all([
      this.sys.client.user.findUnique({ where: { id: token.userId } }),
      this.sys.client.accessGrant.findFirst({ where: { id: grantId, tenantId: token.tenantId, requestedById: token.userId }, include: { tenant: { select: { status: true, slug: true, name: true } } } }),
    ]);
    if (!user || user.status !== 'ACTIVE' || user.deletedAt || !user.platformRole) throw Errors.forbidden('ACCOUNT_DISABLED', 'This account can no longer open support sessions.');
    if (!grant || grant.status !== 'APPROVED' || grant.revokedAt || !grant.expiresAt || grant.expiresAt <= now) {
      throw Errors.forbidden('SUPPORT_ACCESS_ENDED', 'This access has expired or was revoked. Ask the centre again if you still need it.');
    }
    if (!SUPPORT_TENANT_STATES.includes(grant.tenant.status)) throw Errors.forbidden('TENANT_UNAVAILABLE', 'This centre is currently not available.');

    const session = await this.issue(user, { app: 'centre', tenantId: grant.tenantId, supportGrantId: grant.id, mfaVerified: user.mfaEnabled });
    const c = tryCtx();
    const trail = (tenantId: string | null, summary: string) => ({
      tenantId,
      actorUserId: user.id,
      actorType: 'PLATFORM' as const,
      actorLabel: `${user.fullName} (TypEase support)`,
      action: 'support_access.entered',
      resourceType: 'AccessGrant',
      resourceId: grant.id,
      summary,
      after: { via: 'HANDOFF', app: 'centre', scopes: grant.scopes, expiresAt: grant.expiresAt!.toISOString() },
      supportGrantId: grant.id,
      requestId: c?.requestId ?? null,
      ip: c?.ip ?? null,
      userAgent: c?.userAgent?.slice(0, 300) ?? null,
    });
    await this.sys.client.auditLog.createMany({
      data: [
        trail(grant.tenantId, `TypEase support (${user.fullName}) opened a support session in the staff app under an approved access grant`),
        trail(null, `Support session opened in the staff app [centre ${grant.tenant.slug}]`),
      ],
    });
    await this.sys.client.securityEvent.create({
      data: { type: 'SUPPORT_ACCESS_ENTERED', severity: 'MEDIUM', tenantId: grant.tenantId, userId: user.id, ip: c?.ip ?? null, details: { grantId: grant.id, scopes: grant.scopes, expiresAt: grant.expiresAt.toISOString(), via: 'HANDOFF', requestId: c?.requestId ?? null } },
    });
    return session;
  }
}

function landingFor(app: string, session: SessionInfo): string {
  // A support session has no dashboard of its own (that route is closed to it): start at the root, where the
  // staff app shows the banner and the areas the granted scopes open.
  if (session.supportGrant) return '/';
  if (session.mfaRequiredSetup) return '/settings/security?setup=mfa';
  if (app === 'centre' && session.tenant && ['ONBOARDING'].includes(session.tenant.status) && session.membership?.roleKey === 'owner') return '/onboarding';
  return '/dashboard';
}

export type { LoginResult };
