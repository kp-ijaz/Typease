import { Injectable } from '@nestjs/common';
import { ROLE_CATALOGUE, SYSTEM_ROLES, TENANT_PERMISSIONS, TOP_ROLE_KEYS, type RoleKind } from '@typease/permissions';
import { OPEN_STATUSES } from '@typease/types';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { SystemDb, TenantDb, Tx } from '../../common/db/prisma.service';
import { DomainEvents } from '../../common/events.service';
import { Errors, found } from '../../common/errors';
import { branchFilter } from '../../common/scope';
import { UsageService } from '../../common/usage.service';
import { AuthService } from '../auth/auth.service';

/** The top role of the centre or a company: always every permission of its kind, never deleted. */
const isTopRole = (role: { key: string; isSystem: boolean }) => role.isSystem && (TOP_ROLE_KEYS as readonly string[]).includes(role.key);
const ROLE_KINDS: RoleKind[] = ['STAFF', 'CUSTOMER', 'CORPORATE'];

@Injectable()
export class OrganisationService {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly auth: AuthService,
    private readonly events: DomainEvents,
  ) {}

  // ------------------------------------------------------------------ tenant
  async getTenant() {
    return this.db.tx(async (tx) => {
      const t = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      const { onboardingData: _draft, ...rest } = t;
      return rest;
    });
  }
  async updateTenant(input: Record<string, any>) {
    input = { ...input };
    return this.db.tx(async (tx) => {
      const before = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      if (input.aiEnabled === true) await this.usage.assertFeature('aiAssistant', tx);
      const after = await tx.tenant.update({ where: { id: before.id }, data: input as any });
      await this.audit.log({ action: 'tenant.updated', resourceType: 'Tenant', resourceId: before.id, before: pick(before, Object.keys(input)), after: input }, tx);
      return after;
    });
  }
  async updateSettings(patch: Record<string, any>) {
    patch = { ...patch };
    return this.db.tx(async (tx) => {
      const t = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      const settings = { ...(t.settings as object), ...patch };
      await tx.tenant.update({ where: { id: t.id }, data: { settings: settings as any } });
      await this.audit.log({ action: 'tenant.settings_updated', resourceType: 'Tenant', resourceId: t.id, after: patch }, tx);
      return settings;
    });
  }

  // ------------------------------------------------------------------ branches
  listBranches(includeInactive = false) {
    return this.db.tx((tx) =>
      tx.branch.findMany({
        where: { tenantId: this.db.tenantId, ...(includeInactive ? {} : { isActive: true }), ...(branchFilter() ? { id: branchFilter() } : {}) },
        orderBy: [{ isHeadOffice: 'desc' }, { name: 'asc' }],
      }),
    );
  }
  /** Public-facing branch details only (no internal fields). */
  branchDirectory() {
    return this.db.tx((tx) =>
      tx.branch.findMany({
        where: { tenantId: this.db.tenantId, isActive: true },
        orderBy: [{ isHeadOffice: 'desc' }, { name: 'asc' }],
        select: { id: true, code: true, name: true, nameAr: true, address: true, emirate: true, phone: true, email: true, timezone: true, isHeadOffice: true, workingHours: true },
      }),
    );
  }

  async createBranch(input: any) {
    return this.db.tx(async (tx) => {
      await this.usage.assertWithinLimit('branches', tx);
      if (input.isHeadOffice) await tx.branch.updateMany({ where: { tenantId: this.db.tenantId, isHeadOffice: true }, data: { isHeadOffice: false } });
      const branch = await tx.branch.create({ data: { ...input, tenantId: this.db.tenantId } });
      await this.audit.log({ action: 'branch.created', resourceType: 'Branch', resourceId: branch.id, after: input }, tx);
      return branch;
    });
  }
  async updateBranch(id: string, input: any) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.branch.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Branch');
      if (input.isActive === false) {
        if (before.isHeadOffice) throw Errors.conflict('HEAD_OFFICE_REQUIRED', 'Choose another head office before deactivating this branch.');
        const open = await tx.serviceRequest.count({ where: { tenantId: this.db.tenantId, branchId: id, status: { in: OPEN_STATUSES }, deletedAt: null } });
        if (open) throw Errors.conflict('BRANCH_HAS_OPEN_REQUESTS', `This branch still has ${open} open request(s). Complete or move them first.`);
      }
      if (input.isActive === true && !before.isActive) await this.usage.assertWithinLimit('branches', tx);
      if (input.isHeadOffice === true && !before.isHeadOffice) {
        await tx.branch.updateMany({ where: { tenantId: this.db.tenantId, isHeadOffice: true }, data: { isHeadOffice: false } });
      }
      if (input.isHeadOffice === false && before.isHeadOffice) throw Errors.conflict('HEAD_OFFICE_REQUIRED', 'A centre always needs one head office.');
      const after = await tx.branch.update({ where: { id }, data: input });
      await this.audit.log({ action: 'branch.updated', resourceType: 'Branch', resourceId: id, before: pick(before, Object.keys(input)), after: input }, tx);
      return after;
    });
  }

  // ------------------------------------------------------------------ roles
  permissionCatalogue(kind: string = 'STAFF') {
    const k = ROLE_KINDS.includes(kind as RoleKind) ? (kind as RoleKind) : 'STAFF';
    return ROLE_CATALOGUE[k].map((key) => ({ key, ...TENANT_PERMISSIONS[key] }));
  }
  /** The centre's roles: built-in and custom, staff and portal. A company's own roles stay in its portal. */
  listRoles() {
    return this.db.tx(async (tx) => {
      const roles = await tx.role.findMany({
        where: { tenantId: this.db.tenantId, corporateAccountId: null },
        include: { rolePermissions: { select: { permissionKey: true } }, _count: { select: { tenantMemberships: { where: { status: { not: 'REMOVED' } } } } } },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      });
      return roles.map(({ rolePermissions, _count, ...r }) => ({
        ...r,
        permissions: rolePermissions.map((p) => p.permissionKey),
        memberCount: _count.tenantMemberships,
        permissionsFixed: isTopRole(r),
        canDelete: r.kind === 'STAFF' && !isTopRole(r),
        requiresMfa: SYSTEM_ROLES[r.key]?.requiresMfa ?? false,
      }));
    });
  }
  /** Roles are the owner's to change: the role that holds every permission decides who gets which. */
  private assertOwner() {
    if (ctx().roleKey !== 'owner') throw Errors.forbidden('OWNER_ONLY', 'Only the centre owner can create, change or delete roles.');
  }
  /** Only permissions a role of this kind can hold, and nobody hands out staff permissions they do not hold themselves. */
  private assertGrantable(kind: RoleKind, permissions: string[]) {
    const c = ctx();
    const catalogue: string[] = ROLE_CATALOGUE[kind];
    const unknown = permissions.filter((p) => !catalogue.includes(p));
    if (unknown.length) throw Errors.badRequest('UNKNOWN_PERMISSION', `Not a permission for this kind of role: ${unknown.join(', ')}`);
    const escalation = kind === 'STAFF' ? permissions.filter((p) => !c.permissions.has(p)) : [];
    if (escalation.length) throw Errors.forbidden('PRIVILEGE_ESCALATION', `You cannot grant permissions you do not have: ${escalation.join(', ')}`);
  }
  async createRole(input: { key: string; name: string; description?: string | null; permissions: string[] }) {
    this.assertOwner();
    this.assertGrantable('STAFF', input.permissions);
    if (SYSTEM_ROLES[input.key]) throw Errors.conflict('DUPLICATE', 'That role key is reserved.');
    return this.db.tx(async (tx) => {
      const role = await tx.role.create({ data: { tenantId: this.db.tenantId, key: input.key, name: input.name, description: input.description ?? null, kind: 'STAFF', isSystem: false } });
      await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((permissionKey) => ({ tenantId: this.db.tenantId, roleId: role.id, permissionKey })) });
      await this.audit.log({ action: 'role.created', resourceType: 'Role', resourceId: role.id, after: input }, tx);
      return { ...role, permissions: input.permissions };
    });
  }
  /** Any role of the centre, built-in ones included. The top role keeps all its permissions. */
  async updateRole(id: string, input: { name?: string; description?: string | null; permissions?: string[] }) {
    this.assertOwner();
    return this.db.tx(async (tx) => {
      const role = found(await tx.role.findFirst({ where: { id, tenantId: this.db.tenantId, corporateAccountId: null }, include: { rolePermissions: true } }), 'Role');
      const before = role.rolePermissions.map((p) => p.permissionKey);
      if (input.permissions) {
        const next = [...new Set(input.permissions)];
        if (isTopRole(role) && (next.length !== before.length || next.some((p) => !before.includes(p)))) {
          throw Errors.conflict('PERMISSIONS_FIXED', `The ${role.name} role always keeps every permission, so the people who manage roles cannot lock themselves out. You can still rename it.`);
        }
        this.assertGrantable(role.kind as RoleKind, next.filter((p) => !before.includes(p)));
        await tx.rolePermission.deleteMany({ where: { roleId: id, permissionKey: { notIn: next } } });
        const add = next.filter((p) => !before.includes(p));
        if (add.length) await tx.rolePermission.createMany({ data: add.map((permissionKey) => ({ tenantId: this.db.tenantId, roleId: id, permissionKey })) });
      }
      const updated = await tx.role.update({ where: { id }, data: { name: input.name, description: input.description } });
      await this.audit.log({ action: 'role.updated', resourceType: 'Role', resourceId: id, before: { name: role.name, description: role.description, permissions: before }, after: input }, tx);
      return { ...updated, permissions: input.permissions ?? before };
    });
  }
  async deleteRole(id: string) {
    this.assertOwner();
    return this.db.tx(async (tx) => {
      const role = found(await tx.role.findFirst({ where: { id, tenantId: this.db.tenantId, corporateAccountId: null }, include: { _count: { select: { tenantMemberships: { where: { status: { not: 'REMOVED' } } } } } } }), 'Role');
      if (isTopRole(role)) throw Errors.conflict('ROLE_LOCKED', 'The owner role cannot be deleted: a centre always needs an owner.');
      if (role.kind !== 'STAFF') throw Errors.conflict('ROLE_REQUIRED', 'The portals give this role to everyone who signs up or is invited, so it cannot be deleted. Edit it instead.');
      if (role._count.tenantMemberships) throw Errors.conflict('ROLE_IN_USE', 'Move the staff members on this role to another role first.');
      // Former members keep a membership row for history: park those rows on another built-in staff role.
      const fallback = await tx.role.findFirstOrThrow({ where: { tenantId: this.db.tenantId, corporateAccountId: null, kind: 'STAFF', isSystem: true, id: { not: id }, key: { in: ['receptionist', 'owner'] } }, orderBy: { key: 'desc' } });
      await tx.tenantMembership.updateMany({ where: { tenantId: this.db.tenantId, roleId: id, status: 'REMOVED' }, data: { roleId: fallback.id } });
      await tx.role.delete({ where: { id } });
      await this.audit.log({ action: 'role.deleted', resourceType: 'Role', resourceId: id, before: { key: role.key, name: role.name, isSystem: role.isSystem } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  // ------------------------------------------------------------------ staff
  private staffInclude = {
    user: { select: { id: true, email: true, fullName: true, phone: true, mfaEnabled: true, lastLoginAt: true } },
    role: { select: { id: true, key: true, name: true } },
    membershipBranches: { select: { branchId: true } },
    staffSkills: { select: { serviceId: true } },
  } as const;
  private shapeStaff = (m: any) => {
    const { membershipBranches, staffSkills, ...rest } = m;
    return { ...rest, branchIds: membershipBranches.map((b: any) => b.branchId), serviceIds: staffSkills.map((s: any) => s.serviceId) };
  };

  async listStaff(query: { status?: string; branchId?: string; roleKey?: string; q?: string } = {}) {
    return this.db.tx(async (tx) => {
      const rows = await tx.tenantMembership.findMany({
        where: {
          tenantId: this.db.tenantId,
          kind: 'STAFF',
          status: query.status ? (query.status as any) : { not: 'REMOVED' },
          ...(query.roleKey ? { role: { key: query.roleKey } } : {}),
          ...(query.branchId ? { OR: [{ allBranches: true }, { membershipBranches: { some: { branchId: query.branchId } } }] } : {}),
          ...(query.q ? { user: { OR: [{ fullName: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q, mode: 'insensitive' } }] } } : {}),
        },
        include: this.staffInclude,
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(this.shapeStaff);
    });
  }

  async getStaff(id: string) {
    return this.db.tx(async (tx) =>
      this.shapeStaff(found(await tx.tenantMembership.findFirst({ where: { id, tenantId: this.db.tenantId, kind: 'STAFF', status: { not: 'REMOVED' } }, include: this.staffInclude }), 'Staff member')),
    );
  }

  private async assertRoleAssignable(tx: Tx, roleKey: string) {
    const role = found(await tx.role.findFirst({ where: { tenantId: this.db.tenantId, key: roleKey, kind: 'STAFF' }, include: { rolePermissions: true } }), 'Role');
    const c = ctx();
    const escalation = role.rolePermissions.map((p) => p.permissionKey).filter((p) => !c.permissions.has(p));
    if (escalation.length && c.roleKey !== 'owner') {
      throw Errors.forbidden('PRIVILEGE_ESCALATION', 'You cannot assign a role that has more permissions than your own.');
    }
    return role;
  }
  private async assertBranches(tx: Tx, branchIds: string[]) {
    if (!branchIds.length) return;
    const n = await tx.branch.count({ where: { tenantId: this.db.tenantId, id: { in: branchIds } } });
    if (n !== new Set(branchIds).size) throw Errors.notFound('Branch');
  }

  async inviteStaff(input: { email: string; fullName: string; roleKey: string; jobTitle?: string | null; allBranches: boolean; branchIds: string[] }) {
    const c = ctx();
    if (!input.allBranches && !input.branchIds.length) throw Errors.badRequest('BRANCH_REQUIRED', 'Choose at least one branch, or give access to all branches.');
    // Users are global identities, so the placeholder account is created on the system connection.
    const user = await this.sys.client.user.upsert({ where: { email: input.email }, create: { email: input.email, fullName: input.fullName }, update: {} });
    const { membership, invitation } = await this.db.tx(async (tx) => {
      const role = await this.assertRoleAssignable(tx, input.roleKey);
      await this.assertBranches(tx, input.branchIds);
      const existing = await tx.tenantMembership.findFirst({ where: { tenantId: this.db.tenantId, userId: user.id, kind: 'STAFF' } });
      if (existing && existing.status !== 'REMOVED') throw Errors.conflict('ALREADY_MEMBER', 'This person is already on your team.');
      await this.usage.assertWithinLimit('staffUsers', tx);
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      const data = { roleId: role.id, status: 'INVITED' as const, allBranches: input.allBranches, jobTitle: input.jobTitle ?? null, invitedById: c.userId, invitedAt: new Date(), joinedAt: null };
      const m = existing
        ? await tx.tenantMembership.update({ where: { id: existing.id }, data })
        : await tx.tenantMembership.create({ data: { ...data, tenantId: this.db.tenantId, userId: user.id, kind: 'STAFF' } });
      await tx.membershipBranch.deleteMany({ where: { membershipId: m.id } });
      if (!input.allBranches) await tx.membershipBranch.createMany({ data: input.branchIds.map((branchId) => ({ tenantId: this.db.tenantId, membershipId: m.id, branchId })) });
      const invitation = { tenantId: this.db.tenantId, membershipId: m.id, email: input.email, fullName: input.fullName, app: 'centre' as const, centreName: tenant.name, roleName: role.name, language: tenant.defaultLanguage };
      await this.audit.log({ action: 'staff.invited', resourceType: 'TenantMembership', resourceId: m.id, after: { email: input.email, roleKey: input.roleKey, branchIds: input.branchIds, allBranches: input.allBranches } }, tx);
      await this.events.emit(tx, 'staff.invited', { membershipId: m.id, email: input.email, roleKey: input.roleKey });
      return { membership: m, invitation };
    });
    const { token } = await this.auth.sendInvitation(invitation);
    return { id: membership.id, status: membership.status, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  async resendInvitation(id: string) {
    const m = await this.db.tx(async (tx) =>
      found(await tx.tenantMembership.findFirst({ where: { id, tenantId: this.db.tenantId, kind: 'STAFF', status: 'INVITED' }, include: { user: true, role: true, tenant: true } }), 'Invitation'),
    );
    const { token } = await this.auth.sendInvitation({ tenantId: m.tenantId, membershipId: m.id, email: m.user.email, fullName: m.user.fullName, app: 'centre', centreName: m.tenant.name, roleName: m.role.name });
    return { status: 'SENT' as const, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  async updateStaff(id: string, input: { roleKey?: string; jobTitle?: string | null; allBranches?: boolean; branchIds?: string[]; status?: 'ACTIVE' | 'SUSPENDED'; isAvailable?: boolean; serviceIds?: string[] }) {
    const c = ctx();
    const result = await this.db.tx(async (tx) => {
      const m = found(await tx.tenantMembership.findFirst({ where: { id, tenantId: this.db.tenantId, kind: 'STAFF', status: { not: 'REMOVED' } }, include: { role: true } }), 'Staff member');
      const self = m.userId === c.userId;
      if (self && (input.roleKey || input.status)) throw Errors.forbidden('SELF_CHANGE', 'You cannot change your own role or status.');
      const data: any = {};
      if (input.roleKey && input.roleKey !== m.role.key) {
        if (!can('role.manage')) throw Errors.forbidden('FORBIDDEN', 'Changing roles requires the "manage roles" permission.');
        const role = await this.assertRoleAssignable(tx, input.roleKey);
        if (m.role.key === 'owner') await this.assertAnotherOwner(tx, m.id);
        data.roleId = role.id;
      }
      if (input.status && input.status !== m.status) {
        if (m.status === 'INVITED') throw Errors.conflict('INVITATION_PENDING', 'This person has not accepted the invitation yet.');
        if (input.status === 'SUSPENDED' && m.role.key === 'owner') await this.assertAnotherOwner(tx, m.id);
        if (input.status === 'ACTIVE') await this.usage.assertWithinLimit('staffUsers', tx, m.status === 'ACTIVE' ? 0 : 0);
        data.status = input.status;
      }
      if (input.jobTitle !== undefined) data.jobTitle = input.jobTitle;
      if (input.isAvailable !== undefined) data.isAvailable = input.isAvailable;
      if (input.allBranches !== undefined) data.allBranches = input.allBranches;
      if (input.branchIds) {
        await this.assertBranches(tx, input.branchIds);
        await tx.membershipBranch.deleteMany({ where: { membershipId: id } });
        if (input.branchIds.length) await tx.membershipBranch.createMany({ data: input.branchIds.map((branchId) => ({ tenantId: this.db.tenantId, membershipId: id, branchId })) });
      }
      if (input.serviceIds) {
        const n = await tx.service.count({ where: { tenantId: this.db.tenantId, id: { in: input.serviceIds } } });
        if (n !== new Set(input.serviceIds).size) throw Errors.notFound('Service');
        await tx.staffSkill.deleteMany({ where: { membershipId: id } });
        if (input.serviceIds.length) await tx.staffSkill.createMany({ data: input.serviceIds.map((serviceId) => ({ tenantId: this.db.tenantId, membershipId: id, serviceId })) });
      }
      const updated = await tx.tenantMembership.update({ where: { id }, data, include: this.staffInclude });
      await this.audit.log({ action: 'staff.updated', resourceType: 'TenantMembership', resourceId: id, before: { roleKey: m.role.key, status: m.status }, after: input }, tx);
      return { updated, revoke: !!data.roleId || data.status === 'SUSPENDED', userId: m.userId };
    });
    // Role or status changes take effect at once: existing sessions for this centre are ended.
    if (result.revoke) await this.sys.client.session.updateMany({ where: { userId: result.userId, tenantId: this.db.tenantId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'MEMBERSHIP_CHANGED' } });
    return this.shapeStaff(result.updated);
  }

  private async assertAnotherOwner(tx: Tx, exceptMembershipId: string) {
    const others = await tx.tenantMembership.count({ where: { tenantId: this.db.tenantId, kind: 'STAFF', status: 'ACTIVE', role: { key: 'owner' }, id: { not: exceptMembershipId } } });
    if (!others) throw Errors.conflict('LAST_OWNER', 'A centre must always have at least one active owner.');
  }

  async removeStaff(id: string) {
    const c = ctx();
    const userId = await this.db.tx(async (tx) => {
      const m = found(await tx.tenantMembership.findFirst({ where: { id, tenantId: this.db.tenantId, kind: 'STAFF', status: { not: 'REMOVED' } }, include: { role: true } }), 'Staff member');
      if (m.userId === c.userId) throw Errors.forbidden('SELF_CHANGE', 'You cannot remove yourself.');
      if (m.role.key === 'owner') await this.assertAnotherOwner(tx, m.id);
      const open = await tx.serviceRequest.count({ where: { tenantId: this.db.tenantId, assignedToId: id, status: { in: OPEN_STATUSES }, deletedAt: null } });
      if (open) throw Errors.conflict('STAFF_HAS_OPEN_REQUESTS', `Reassign this person's ${open} open request(s) first.`);
      await tx.tenantMembership.update({ where: { id }, data: { status: 'REMOVED' } });
      await this.audit.log({ action: 'staff.removed', resourceType: 'TenantMembership', resourceId: id }, tx);
      return m.userId;
    });
    await this.sys.client.session.updateMany({ where: { userId, tenantId: this.db.tenantId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'MEMBERSHIP_REMOVED' } });
    return { status: 'REMOVED' as const };
  }

  getSchedule(id: string) {
    return this.db.tx(async (tx) => {
      found(await tx.tenantMembership.findFirst({ where: { id, tenantId: this.db.tenantId, kind: 'STAFF' } }), 'Staff member');
      return tx.staffSchedule.findMany({ where: { tenantId: this.db.tenantId, membershipId: id, isActive: true }, orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] });
    });
  }
  setSchedule(id: string, entries: Array<{ branchId: string; weekday: number; startTime: string; endTime: string }>) {
    return this.db.tx(async (tx) => {
      found(await tx.tenantMembership.findFirst({ where: { id, tenantId: this.db.tenantId, kind: 'STAFF' } }), 'Staff member');
      for (const e of entries) if (e.startTime >= e.endTime) throw Errors.badRequest('INVALID_SCHEDULE', 'Each shift must end after it starts.');
      await this.assertBranches(tx, [...new Set(entries.map((e) => e.branchId))]);
      await tx.staffSchedule.deleteMany({ where: { tenantId: this.db.tenantId, membershipId: id } });
      if (entries.length) await tx.staffSchedule.createMany({ data: entries.map((e) => ({ ...e, tenantId: this.db.tenantId, membershipId: id })) });
      await this.audit.log({ action: 'staff.schedule_updated', resourceType: 'TenantMembership', resourceId: id, after: { entries: entries.length } }, tx);
      return tx.staffSchedule.findMany({ where: { tenantId: this.db.tenantId, membershipId: id }, orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] });
    });
  }

  /** Open requests and tasks per staff member (workload dashboard and auto-assignment). */
  workload(branchId?: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const scope = branchId ? { branchId } : branchFilter() ? { branchId: branchFilter() } : {};
      const [staff, requests, tasks, completed] = await Promise.all([
        tx.tenantMembership.findMany({ where: { tenantId, kind: 'STAFF', status: 'ACTIVE' }, include: { user: { select: { fullName: true } }, role: { select: { key: true, name: true } } } }),
        tx.serviceRequest.groupBy({ by: ['assignedToId'], where: { tenantId, status: { in: OPEN_STATUSES }, deletedAt: null, assignedToId: { not: null }, ...scope }, _count: { _all: true } }),
        tx.taskAssignment.groupBy({ by: ['assigneeId'], where: { tenantId, unassignedAt: null, task: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }, _count: { _all: true } }),
        tx.serviceRequest.groupBy({ by: ['assignedToId'], where: { tenantId, status: 'COMPLETED', completedAt: { gte: new Date(Date.now() - 30 * 86400_000) }, assignedToId: { not: null }, ...scope }, _count: { _all: true } }),
      ]);
      const count = (rows: any[], key: string, id: string) => rows.find((r) => r[key] === id)?._count._all ?? 0;
      return staff.map((m) => ({
        membershipId: m.id,
        name: m.user.fullName,
        roleKey: m.role.key,
        roleName: m.role.name,
        isAvailable: m.isAvailable,
        openRequests: count(requests, 'assignedToId', m.id),
        openTasks: count(tasks, 'assigneeId', m.id),
        completedLast30Days: count(completed, 'assignedToId', m.id),
      }));
    });
  }
}

const devTokens = () => process.env.EXPOSE_DEV_TOKENS === 'true' && process.env.NODE_ENV !== 'production';
function pick(obj: Record<string, any>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
