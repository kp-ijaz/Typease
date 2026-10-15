import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ROLE_CATALOGUE, TENANT_PERMISSIONS } from '@typease/permissions';
import type { CorporateRoleInput, UpdateCorporateRoleInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { CorporateAccess } from './corporate-access.service';

/** The centre's company roles every company starts with. */
const DEFAULT_KEYS = ['corporate_admin', 'corporate_employee'];
const ADMIN = 'corporate_admin';
const EMPLOYEE = 'corporate_employee';
const CATALOGUE: string[] = ROLE_CATALOGUE.CORPORATE;
const rolePerms = { rolePermissions: { select: { permissionKey: true } } } as const;
type RoleRow = { id: string; key: string; name: string; description: string | null; isSystem: boolean; corporateAccountId: string | null; rolePermissions: { permissionKey: string }[] };

/** A company's own role keys embed its id, so they never collide with the centre's keys or another company's. */
const prefix = (accountId: string) => `co_${accountId.replace(/-/g, '')}_`;
export const companyRoleKey = (accountId: string, suffix: string) => prefix(accountId) + suffix;
/** The built-in key a company role was copied from ("corporate_admin"), or the key itself. */
const baseKey = (key: string, accountId: string) => (key.startsWith(prefix(accountId)) ? key.slice(prefix(accountId).length) : key);

/**
 * The roles of one company in the corporate portal. Every company starts on the centre's two company roles
 * (administrator, employee). The first time its administrator changes one, the company gets its own copy of
 * both and its people move onto them, so a change never reaches another company. Only the company's
 * administrator manages roles; that role keeps every company permission and cannot be deleted.
 */
@Injectable()
export class CorporateRolesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly access: CorporateAccess,
  ) {}

  /** The role a new colleague or employee login gets: the company's copy once it has one, else the centre's. */
  static async defaultRole(tx: Tx, tenantId: string, accountId: string, key: typeof ADMIN | typeof EMPLOYEE) {
    const rows = await tx.role.findMany({ where: { tenantId, kind: 'CORPORATE', key: { in: [companyRoleKey(accountId, key), key] } } });
    return rows.find((r) => r.corporateAccountId === accountId) ?? rows.find((r) => r.key === key) ?? null;
  }

  permissionCatalogue() {
    return CATALOGUE.map((key) => ({ key, ...(TENANT_PERMISSIONS as Record<string, { group: string; description: string }>)[key] }));
  }

  private assertAdmin(accountId: string) {
    const key = ctx().roleKey;
    if (key !== ADMIN && key !== companyRoleKey(accountId, ADMIN)) throw Errors.forbidden('COMPANY_ADMIN_ONLY', 'Only the company administrator can manage roles.');
  }
  private async writableAccount(tx: Tx) {
    const account = await this.access.ownAccount(tx);
    this.assertAdmin(account.id);
    this.access.assertPortalWritable(account);
    return account;
  }

  /** The company's roles: the centre defaults it has not copied yet, then its own. */
  private async roles(tx: Tx, accountId: string): Promise<RoleRow[]> {
    const tenantId = this.db.tenantId;
    const [defaults, own] = await Promise.all([
      tx.role.findMany({ where: { tenantId, corporateAccountId: null, kind: 'CORPORATE', key: { in: DEFAULT_KEYS } }, include: rolePerms }),
      tx.role.findMany({ where: { tenantId, corporateAccountId: accountId }, include: rolePerms, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] }),
    ]);
    const copied = new Set(own.map((r) => baseKey(r.key, accountId)));
    return [...defaults.filter((d) => !copied.has(d.key)).sort((a, b) => DEFAULT_KEYS.indexOf(a.key) - DEFAULT_KEYS.indexOf(b.key)), ...own];
  }
  private async requireRole(tx: Tx, accountId: string, id: string) {
    return found((await this.roles(tx, accountId)).find((r) => r.id === id), 'Role');
  }
  private shape(r: RoleRow, accountId: string, memberCount: number) {
    const base = baseKey(r.key, accountId);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: r.rolePermissions.map((p) => p.permissionKey),
      memberCount,
      builtIn: r.isSystem,
      baseKey: r.isSystem ? base : null,
      permissionsFixed: r.isSystem && base === ADMIN,
      canDelete: !r.isSystem,
    };
  }

  /** Before the first change the company gets its own copy of the centre defaults, and its people move onto them. */
  private async ownCopies(tx: Tx, accountId: string) {
    const tenantId = this.db.tenantId;
    const defaults = await tx.role.findMany({ where: { tenantId, corporateAccountId: null, kind: 'CORPORATE', key: { in: DEFAULT_KEYS } }, include: rolePerms });
    const copies = new Map<string, string>();
    for (const d of defaults) {
      const key = companyRoleKey(accountId, d.key);
      let copy = await tx.role.findFirst({ where: { tenantId, key }, select: { id: true } });
      if (!copy) {
        copy = await tx.role.create({ data: { tenantId, corporateAccountId: accountId, key, name: d.name, description: d.description, kind: 'CORPORATE', isSystem: true }, select: { id: true } });
        if (d.rolePermissions.length) await tx.rolePermission.createMany({ data: d.rolePermissions.map((p) => ({ tenantId, roleId: copy!.id, permissionKey: p.permissionKey })) });
        await tx.tenantMembership.updateMany({ where: { tenantId, corporateAccountId: accountId, kind: 'CORPORATE', roleId: d.id }, data: { roleId: copy.id } });
      }
      copies.set(d.id, copy.id);
    }
    return copies;
  }

  private assertPermissions(permissions: string[]) {
    const unknown = permissions.filter((p) => !CATALOGUE.includes(p));
    if (unknown.length) throw Errors.badRequest('UNKNOWN_PERMISSION', `Not a company permission: ${unknown.join(', ')}`);
  }
  private memberCounts(tx: Tx, accountId: string) {
    return tx.tenantMembership
      .groupBy({ by: ['roleId'], where: { tenantId: this.db.tenantId, corporateAccountId: accountId, kind: 'CORPORATE', status: { not: 'REMOVED' } }, _count: { _all: true } })
      .then((rows) => new Map(rows.map((r) => [r.roleId, r._count._all])));
  }

  // ------------------------------------------------------------------ roles
  list() {
    return this.db.tx(async (tx) => {
      const account = await this.access.ownAccount(tx);
      const [roles, counts] = await Promise.all([this.roles(tx, account.id), this.memberCounts(tx, account.id)]);
      return roles.map((r) => this.shape(r, account.id, counts.get(r.id) ?? 0));
    });
  }

  create(input: CorporateRoleInput) {
    return this.db.tx(async (tx) => {
      const account = await this.writableAccount(tx);
      const permissions = [...new Set(input.permissions)];
      this.assertPermissions(permissions);
      const tenantId = this.db.tenantId;
      const role = await tx.role.create({
        data: { tenantId, corporateAccountId: account.id, key: companyRoleKey(account.id, `r${randomUUID().slice(0, 8)}`), name: input.name, description: input.description ?? null, kind: 'CORPORATE', isSystem: false },
        include: rolePerms,
      });
      if (permissions.length) await tx.rolePermission.createMany({ data: permissions.map((permissionKey) => ({ tenantId, roleId: role.id, permissionKey })) });
      await this.audit.log({ action: 'corporate.role_created', resourceType: 'CorporateAccount', resourceId: account.id, summary: `Role "${input.name}" created`, after: { roleId: role.id, ...input } }, tx);
      return this.shape({ ...role, rolePermissions: permissions.map((permissionKey) => ({ permissionKey })) }, account.id, 0);
    });
  }

  update(id: string, input: UpdateCorporateRoleInput) {
    return this.db.tx(async (tx) => {
      const account = await this.writableAccount(tx);
      let role = await this.requireRole(tx, account.id, id);
      // A centre default is never changed from a company: the company gets its own copy and changes that.
      if (role.corporateAccountId === null) role = await this.requireRole(tx, account.id, (await this.ownCopies(tx, account.id)).get(role.id)!);
      const before = role.rolePermissions.map((p) => p.permissionKey);
      let after = before;
      if (input.permissions) {
        const next = [...new Set(input.permissions)];
        this.assertPermissions(next);
        if (role.isSystem && baseKey(role.key, account.id) === ADMIN && (next.length !== before.length || next.some((p) => !before.includes(p)))) {
          throw Errors.conflict('PERMISSIONS_FIXED', `The ${role.name} role always keeps every permission, so the company can always manage its roles. You can still rename it.`);
        }
        const tenantId = this.db.tenantId;
        await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: { notIn: next } } });
        const add = next.filter((p) => !before.includes(p));
        if (add.length) await tx.rolePermission.createMany({ data: add.map((permissionKey) => ({ tenantId, roleId: role.id, permissionKey })) });
        after = next;
      }
      const updated = await tx.role.update({ where: { id: role.id }, data: { name: input.name, description: input.description }, include: rolePerms });
      await this.audit.log(
        { action: 'corporate.role_updated', resourceType: 'CorporateAccount', resourceId: account.id, summary: `Role "${updated.name}" changed`, before: { roleId: role.id, name: role.name, description: role.description, permissions: before }, after: { roleId: role.id, ...input } },
        tx,
      );
      const counts = await this.memberCounts(tx, account.id);
      return this.shape({ ...updated, rolePermissions: after.map((permissionKey) => ({ permissionKey })) }, account.id, counts.get(role.id) ?? 0);
    });
  }

  remove(id: string) {
    return this.db.tx(async (tx) => {
      const account = await this.writableAccount(tx);
      const role = await this.requireRole(tx, account.id, id);
      if (role.isSystem) throw Errors.conflict('ROLE_REQUIRED', 'New colleagues and employee logins get this role, so it cannot be deleted. Edit it instead.');
      const tenantId = this.db.tenantId;
      const held = await tx.tenantMembership.count({ where: { tenantId, roleId: role.id, status: { not: 'REMOVED' } } });
      if (held) throw Errors.conflict('ROLE_IN_USE', 'Give the people on this role another role first.');
      // People who left keep their membership row for history: park it on the employee role.
      const fallback = (await CorporateRolesService.defaultRole(tx, tenantId, account.id, EMPLOYEE))!;
      await tx.tenantMembership.updateMany({ where: { tenantId, roleId: role.id, status: 'REMOVED' }, data: { roleId: fallback.id } });
      await tx.role.delete({ where: { id: role.id } });
      await this.audit.log({ action: 'corporate.role_deleted', resourceType: 'CorporateAccount', resourceId: account.id, summary: `Role "${role.name}" deleted`, before: { roleId: role.id, name: role.name } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  // ------------------------------------------------------------------ people
  /** Everybody with access to the company portal: colleagues and employee logins. */
  users() {
    return this.db.tx(async (tx) => {
      const account = await this.access.ownAccount(tx);
      const rows = await tx.tenantMembership.findMany({
        where: { tenantId: this.db.tenantId, corporateAccountId: account.id, kind: 'CORPORATE', status: { not: 'REMOVED' } },
        select: { id: true, status: true, userId: true, roleId: true, corporateEmployeeId: true, role: { select: { name: true } }, user: { select: { fullName: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const me = ctx().userId;
      return rows.map((m) => ({
        id: m.id,
        fullName: m.user.fullName,
        email: m.user.email,
        status: m.status,
        type: m.corporateEmployeeId ? ('EMPLOYEE' as const) : ('COLLEAGUE' as const),
        roleId: m.roleId,
        roleName: m.role.name,
        isMe: m.userId === me,
      }));
    });
  }

  async setUserRole(membershipId: string, roleId: string) {
    const userId = await this.db.tx(async (tx) => {
      const account = await this.writableAccount(tx);
      const tenantId = this.db.tenantId;
      const m = found(
        await tx.tenantMembership.findFirst({ where: { id: membershipId, tenantId, corporateAccountId: account.id, kind: 'CORPORATE', status: { not: 'REMOVED' } }, include: { role: true, user: { select: { email: true } } } }),
        'User',
      );
      if (m.userId === ctx().userId) throw Errors.forbidden('SELF_CHANGE', 'You cannot change your own role.');
      let role = await this.requireRole(tx, account.id, roleId);
      if (m.roleId === role.id) return null;
      if (role.corporateAccountId === null) role = await this.requireRole(tx, account.id, (await this.ownCopies(tx, account.id)).get(role.id)!);
      await tx.tenantMembership.update({ where: { id: m.id }, data: { roleId: role.id } });
      await this.audit.log(
        { action: 'corporate.user_role_changed', resourceType: 'CorporateAccount', resourceId: account.id, summary: `${m.user.email}: ${m.role.name} -> ${role.name}`, before: { membershipId: m.id, roleId: m.roleId }, after: { membershipId: m.id, roleId: role.id } },
        tx,
      );
      return m.userId;
    });
    // The new role applies at once: the person's sessions end and the next sign-in carries the new permissions.
    if (userId) await this.access.endSessions([userId], 'MEMBERSHIP_CHANGED');
    return { status: 'UPDATED' as const };
  }
}
