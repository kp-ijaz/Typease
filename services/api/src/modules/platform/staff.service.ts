import { Injectable } from '@nestjs/common';
import { PLATFORM_ROLES } from '@typease/permissions';
import type { CreatePlatformStaffInput, PlatformStaffQuery, UpdatePlatformStaffInput } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, SystemDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { Messenger } from '../../common/messenger';
import { AuthService } from '../auth/auth.service';
import { AccessGrantsService } from './access-grants.service';
import { devTokens } from './platform.util';

const INVITATION_TTL_HOURS = 72;
const SELECT = { id: true, email: true, fullName: true, platformRole: true, status: true, mfaEnabled: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true, passwordHash: true } as const;
type StaffRow = Prisma.UserGetPayload<{ select: typeof SELECT }>;

/**
 * TypEase's own staff accounts (Super Admins and Support Agents).
 *
 * Two rules protect the console from locking itself out or being taken over
 * by one person: nobody can change or disable their OWN account, and there is
 * always at least one active Super Admin.
 */
@Injectable()
export class PlatformStaffService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly messenger: Messenger,
    private readonly grants: AccessGrantsService,
  ) {}

  private view(u: StaffRow) {
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      role: u.platformRole,
      roleName: u.platformRole ? PLATFORM_ROLES[u.platformRole].name : null,
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      /** The person has not chosen a password yet. */
      invitationPending: !u.passwordHash,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      isYou: u.id === ctx().userId,
    };
  }

  async list(query: PlatformStaffQuery) {
    const rows = await this.sys.client.user.findMany({
      where: {
        platformRole: query.role ?? { not: null },
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { OR: [{ fullName: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q.toLowerCase() } }] } : {}),
      },
      orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
      select: SELECT,
    });
    return rows.map((r) => this.view(r));
  }

  private async one(id: string, db: Pick<Tx, 'user'> = this.sys.client): Promise<StaffRow> {
    return found(await db.user.findFirst({ where: { id, platformRole: { not: null }, deletedAt: null }, select: SELECT }), 'Staff member');
  }

  /** Emails a link to choose a password. It uses the same one-time token as a password reset. */
  private async invite(user: { id: string; email: string; fullName: string; platformRole: 'SUPER_ADMIN' | 'SUPPORT_AGENT' | null }) {
    // A new link replaces any earlier unused one.
    await this.sys.client.authToken.updateMany({ where: { type: 'PASSWORD_RESET', userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } });
    const token = await this.auth.createToken('PASSWORD_RESET', { userId: user.id, target: user.email, ttlSeconds: INVITATION_TTL_HOURS * 3600, meta: { purpose: 'PLATFORM_STAFF_INVITATION' } });
    await this.messenger.send({
      eventKey: 'staff.invitation',
      channel: 'EMAIL',
      to: user.email,
      language: 'en',
      tenantId: null,
      data: { name: user.fullName, centre: 'the TypEase platform console', role: user.platformRole ? PLATFORM_ROLES[user.platformRole].name : 'Platform staff', link: `${env().PLATFORM_ADMIN_URL}/reset-password?token=${token}`, days: Math.round(INVITATION_TTL_HOURS / 24) },
    });
    return token;
  }

  async create(input: CreatePlatformStaffInput) {
    const existing = await this.sys.client.user.findUnique({ where: { email: input.email }, select: { id: true, platformRole: true } });
    if (existing) {
      throw Errors.conflict(
        existing.platformRole ? 'ALREADY_STAFF' : 'EMAIL_IN_USE',
        existing.platformRole ? 'This person already has a platform account.' : 'That email already belongs to an account of a typing centre. Platform staff need a separate TypEase address.',
      );
    }
    const user = await this.sys.client.user.create({ data: { email: input.email, fullName: input.fullName, platformRole: input.role }, select: SELECT });
    await this.audit.logSystem({ action: 'platform.staff_created', resourceType: 'User', resourceId: user.id, summary: `${user.fullName} added as ${PLATFORM_ROLES[input.role].name}`, after: { email: user.email, role: input.role } });
    await this.audit.security('PLATFORM_STAFF_CREATED', 'MEDIUM', { staffUserId: user.id, role: input.role }, null);
    const token = await this.invite(user);
    return { ...this.view(user), ...(devTokens() ? { dev: { passwordResetToken: token } } : {}) };
  }

  async resendInvitation(id: string) {
    const user = await this.one(id);
    if (user.passwordHash) throw Errors.conflict('ALREADY_ACTIVATED', 'This person has already chosen a password. They can use "Forgot password" on the sign-in page.');
    if (user.status !== 'ACTIVE') throw Errors.conflict('ACCOUNT_DISABLED', 'This account is disabled. Enable it first.');
    const token = await this.invite(user);
    await this.audit.logSystem({ action: 'platform.staff_invitation_resent', resourceType: 'User', resourceId: id, summary: `Invitation sent again to ${user.email}` });
    return { status: 'SENT' as const, email: user.email, ...(devTokens() ? { dev: { passwordResetToken: token } } : {}) };
  }

  /** Serialises role / status changes so two of them can never remove the last Super Admin between them. */
  private async guarded<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sys.tx(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('platform-staff', 0))::text AS locked`;
      return fn(tx);
    });
  }
  private async assertAnotherSuperAdmin(tx: Tx, exceptId: string) {
    const others = await tx.user.count({ where: { platformRole: 'SUPER_ADMIN', status: 'ACTIVE', deletedAt: null, id: { not: exceptId } } });
    if (others < 1) throw Errors.conflict('LAST_SUPER_ADMIN', 'This is the only active Platform Super Admin. Make someone else a Super Admin first.');
  }
  private assertNotSelf(id: string, what: string) {
    if (id === ctx().userId) throw Errors.forbidden('SELF_CHANGE', `You cannot ${what} your own account. Ask another Super Admin.`);
  }

  async update(id: string, input: UpdatePlatformStaffInput) {
    if (input.role !== undefined) this.assertNotSelf(id, 'change the role of');
    const { before, after } = await this.guarded(async (tx) => {
      const user = await this.one(id, tx);
      const data: Prisma.UserUpdateInput = {};
      if (input.fullName !== undefined) data.fullName = input.fullName;
      if (input.role !== undefined && input.role !== user.platformRole) {
        if (user.platformRole === 'SUPER_ADMIN' && user.status === 'ACTIVE') await this.assertAnotherSuperAdmin(tx, id);
        data.platformRole = input.role;
      }
      const updated = await tx.user.update({ where: { id }, data, select: SELECT });
      return { before: user, after: updated };
    });
    if (before.platformRole !== after.platformRole) {
      // Permissions are read from the account on every request, so the change is immediate.
      await this.audit.logSystem({ action: 'platform.staff_role_changed', resourceType: 'User', resourceId: id, summary: `${after.fullName}: ${before.platformRole} -> ${after.platformRole}`, before: { role: before.platformRole }, after: { role: after.platformRole } });
      await this.audit.security('PLATFORM_ROLE_CHANGED', 'HIGH', { staffUserId: id, from: before.platformRole, to: after.platformRole }, null);
    } else if (before.fullName !== after.fullName) {
      await this.audit.logSystem({ action: 'platform.staff_updated', resourceType: 'User', resourceId: id, summary: `${before.fullName} renamed to ${after.fullName}`, before: { fullName: before.fullName }, after: { fullName: after.fullName } });
    }
    return this.view(after);
  }

  /** Disables the account, signs it out everywhere and closes every support access it had asked for. */
  async disable(id: string) {
    this.assertNotSelf(id, 'disable');
    const user = await this.guarded(async (tx) => {
      const current = await this.one(id, tx);
      if (current.status === 'DISABLED') throw Errors.conflict('ALREADY_DISABLED', 'This account is already disabled.');
      if (current.platformRole === 'SUPER_ADMIN') await this.assertAnotherSuperAdmin(tx, id);
      return tx.user.update({ where: { id }, data: { status: 'DISABLED' }, select: SELECT });
    });
    await this.auth.revokeAllForUser(id, 'ACCOUNT_DISABLED');
    const grants = await this.grants.revokeAllOf(id);
    await this.audit.logSystem({ action: 'platform.staff_disabled', resourceType: 'User', resourceId: id, summary: `${user.fullName} disabled; sessions ended`, before: { status: 'ACTIVE' }, after: { status: 'DISABLED', accessGrantsClosed: grants } });
    await this.audit.security('PLATFORM_STAFF_DISABLED', 'HIGH', { staffUserId: id }, null);
    return this.view(user);
  }

  async enable(id: string) {
    this.assertNotSelf(id, 'enable');
    const user = await this.guarded(async (tx) => {
      const current = await this.one(id, tx);
      if (current.status === 'ACTIVE') throw Errors.conflict('ALREADY_ACTIVE', 'This account is already active.');
      return tx.user.update({ where: { id }, data: { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null }, select: SELECT });
    });
    await this.audit.logSystem({ action: 'platform.staff_enabled', resourceType: 'User', resourceId: id, summary: `${user.fullName} enabled`, before: { status: 'DISABLED' }, after: { status: 'ACTIVE' } });
    await this.audit.security('PLATFORM_STAFF_ENABLED', 'MEDIUM', { staffUserId: id }, null);
    return this.view(user);
  }
}
