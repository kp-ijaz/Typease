import { Injectable, Logger } from '@nestjs/common';
import type { TenantStatus } from '@typease/database';
import type { PlatformCreateTenantInput, PlatformTenantListQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant } from '../../common/context';
import { Prisma, SystemDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { UsageService } from '../../common/usage.service';
import { AuthService } from '../auth/auth.service';
import { BillingCore } from '../subscriptions/billing.core';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { OnboardingService, RESERVED_SLUGS } from '../tenancy/onboarding.service';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { auditForCentre, dayEndExclusive, dayStart, devTokens } from './platform.util';
import { actionProblem, platformSuspensionReason, rejectionReason, statusAfterReactivation, statusForSubscription, TenantAction } from './tenant-status';

const SORT = ['createdAt', 'name', 'slug', 'status'] as const;
const OPEN_TICKETS = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] as const;
const LIST_INCLUDE = { subscription: { select: { status: true, billingCycle: true, currentPeriodEnd: true, trialEndsAt: true, plan: { select: { key: true, name: true } } } } } as const;

type TenantRow = Prisma.TenantGetPayload<object>;

/**
 * Platform administration of centres (tenants).
 *
 * What TypEase staff can see here is metadata of the CENTRE: its profile, the
 * owner's contact details, its subscription, how much of its plan it uses, how
 * many branches and staff it has, its domains and how far onboarding got.
 * Nothing in this file reads customers, documents, requests or the centre's
 * own financial records - those need an approved support access grant.
 */
@Injectable()
export class PlatformTenantsService {
  private readonly logger = new Logger(PlatformTenantsService.name);
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
    private readonly auth: AuthService,
    private readonly usage: UsageService,
    private readonly onboarding: OnboardingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly billing: BillingCore,
    private readonly resolver: TenantResolver,
  ) {}

  // ------------------------------------------------------------------ reads
  private listView(t: Prisma.TenantGetPayload<{ include: typeof LIST_INCLUDE }>) {
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      legalName: t.legalName,
      status: t.status,
      emirate: t.emirate,
      contactEmail: t.contactEmail,
      contactPhone: t.contactPhone,
      suspendedAt: t.suspendedAt,
      suspensionReason: t.suspensionReason,
      archivedAt: t.archivedAt,
      offboardingAt: t.offboardingAt,
      createdAt: t.createdAt,
      plan: t.subscription ? { key: t.subscription.plan.key, name: t.subscription.plan.name } : null,
      subscription: t.subscription ? { status: t.subscription.status, billingCycle: t.subscription.billingCycle, currentPeriodEnd: t.subscription.currentPeriodEnd, trialEndsAt: t.subscription.trialEndsAt } : null,
    };
  }

  async list(query: PlatformTenantListQuery) {
    const createdAt = query.createdFrom || query.createdTo ? { ...(query.createdFrom ? { gte: dayStart(query.createdFrom) } : {}), ...(query.createdTo ? { lt: dayEndExclusive(query.createdTo) } : {}) } : undefined;
    const where: Prisma.TenantWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.plan === 'none' ? { subscription: { is: null } } : query.plan ? { subscription: { is: { plan: { key: query.plan } } } } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(query.offboarding === true ? { offboardingAt: { not: null } } : query.offboarding === false ? { offboardingAt: null } : {}),
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { legalName: { contains: query.q, mode: 'insensitive' } }, { slug: { contains: query.q.toLowerCase() } }, { contactEmail: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([this.sys.client.tenant.findMany({ where, include: LIST_INCLUDE, ...pageArgs(query, SORT, 'createdAt:desc') }), this.sys.client.tenant.count({ where })]);
    return pageResult(rows.map((r) => this.listView(r)), total, query);
  }

  async require(id: string): Promise<TenantRow> {
    return found(await this.sys.client.tenant.findUnique({ where: { id } }), 'Centre');
  }

  /** Everything the platform console shows about one centre. Tenant-level metadata only. */
  async detail(id: string) {
    const db = this.sys.client;
    const tenant = found(await db.tenant.findUnique({ where: { id }, include: { subscription: { include: { plan: true, pendingPlan: true } } } }), 'Centre');
    const [owners, branchesTotal, branchesActive, staffByStatus, domains, lastSession, lastLogin, lastAudit, openTickets, pendingAccess, activeAccess] = await Promise.all([
      db.tenantMembership.findMany({
        where: { tenantId: id, kind: 'STAFF', status: { not: 'REMOVED' }, role: { key: 'owner' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, invitedAt: true, joinedAt: true, user: { select: { id: true, fullName: true, email: true, phone: true, emailVerifiedAt: true, mfaEnabled: true, lastLoginAt: true, status: true } } },
      }),
      db.branch.count({ where: { tenantId: id } }),
      db.branch.count({ where: { tenantId: id, isActive: true } }),
      db.tenantMembership.groupBy({ by: ['status'], where: { tenantId: id, kind: 'STAFF' }, _count: { _all: true } }),
      db.tenantDomain.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, domain: true, kind: true, app: true, status: true, isPrimary: true, verifiedAt: true, lastCheckedAt: true, lastCheckError: true } }),
      db.session.aggregate({ where: { tenantId: id }, _max: { createdAt: true } }),
      db.loginActivity.aggregate({ where: { tenantId: id, success: true }, _max: { createdAt: true } }),
      db.auditLog.aggregate({ where: { tenantId: id }, _max: { createdAt: true } }),
      db.supportTicket.count({ where: { tenantId: id, scope: 'PLATFORM', status: { in: [...OPEN_TICKETS] } } }),
      db.accessGrant.count({ where: { tenantId: id, status: 'REQUESTED' } }),
      db.accessGrant.count({ where: { tenantId: id, status: 'APPROVED', revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    // Usage and onboarding progress are computed by their own services, inside the centre's
    // row-level-security context, so the numbers are exactly what the owner sees.
    const usage = await runAsTenant(id, () => this.usage.summary(), { actorLabel: 'platform:tenant-detail' });
    const firstOwner = owners[0];
    let onboarding: { currentStep: number; completed: boolean; canComplete: boolean; steps: Array<{ key: string; title: string; done: boolean; required: boolean }> } | null = null;
    if (firstOwner) {
      const state = await runAsTenant(id, () => this.onboarding.status(), { userId: firstOwner.user.id, actorLabel: 'platform:tenant-detail' });
      onboarding = { currentStep: state.currentStep, completed: state.completed, canComplete: state.canComplete, steps: state.steps.map((s) => ({ key: s.key, title: s.title, done: s.done, required: s.required })) };
    }
    // Why and by whom a deletion was scheduled is on the platform audit trail.
    const scheduled = tenant.offboardingAt
      ? await db.auditLog.findFirst({ where: { tenantId: null, action: 'tenant.offboarding_scheduled', resourceId: id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, actorLabel: true, after: true } })
      : null;
    const staff = Object.fromEntries(staffByStatus.map((s) => [s.status.toLowerCase(), s._count._all]));
    const activity = [lastSession._max.createdAt, lastLogin._max.createdAt, lastAudit._max.createdAt].filter((d): d is Date => !!d);
    const sub = tenant.subscription;
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      legalName: tenant.legalName,
      status: tenant.status,
      suspendedAt: tenant.suspendedAt,
      suspensionReason: tenant.suspensionReason,
      approvedAt: tenant.approvedAt,
      archivedAt: tenant.archivedAt,
      offboardingAt: tenant.offboardingAt,
      /** Present while a permanent deletion is scheduled. */
      offboarding: tenant.offboardingAt
        ? { purgeAt: tenant.offboardingAt, scheduledAt: scheduled?.createdAt ?? null, scheduledBy: scheduled?.actorLabel ?? null, reason: ((scheduled?.after ?? {}) as { reason?: string }).reason ?? null }
        : null,
      createdAt: tenant.createdAt,
      profile: {
        country: tenant.country,
        emirate: tenant.emirate,
        timezone: tenant.timezone,
        defaultCurrency: tenant.defaultCurrency,
        defaultLanguage: tenant.defaultLanguage,
        contactEmail: tenant.contactEmail,
        contactPhone: tenant.contactPhone,
        tradeLicenceNo: tenant.tradeLicenceNo,
        taxRegistrationNo: tenant.taxRegistrationNo,
        aiEnabled: tenant.aiEnabled,
      },
      owners: owners.map((o) => ({
        membershipId: o.id,
        userId: o.user.id,
        fullName: o.user.fullName,
        email: o.user.email,
        phone: o.user.phone,
        status: o.status,
        accountStatus: o.user.status,
        emailVerified: !!o.user.emailVerifiedAt,
        mfaEnabled: o.user.mfaEnabled,
        invitedAt: o.invitedAt,
        joinedAt: o.joinedAt,
        lastLoginAt: o.user.lastLoginAt,
      })),
      subscription: sub
        ? {
            id: sub.id,
            status: sub.status,
            billingCycle: sub.billingCycle,
            plan: { key: sub.plan.key, name: sub.plan.name, monthlyPrice: sub.plan.monthlyPrice, annualPrice: sub.plan.annualPrice, currency: sub.plan.currency },
            pendingPlan: sub.pendingPlan ? { key: sub.pendingPlan.key, name: sub.pendingPlan.name } : null,
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
            trialEndsAt: sub.trialEndsAt,
            graceEndsAt: sub.graceEndsAt,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            cancelledAt: sub.cancelledAt,
          }
        : null,
      usage,
      counts: { branches: { total: branchesTotal, active: branchesActive }, staff: { active: staff.active ?? 0, invited: staff.invited ?? 0, suspended: staff.suspended ?? 0 } },
      domains,
      onboarding,
      lastActivity: { at: activity.length ? new Date(Math.max(...activity.map((d) => d.getTime()))) : null, lastSessionAt: lastSession._max.createdAt, lastLoginAt: lastLogin._max.createdAt, lastAuditedActionAt: lastAudit._max.createdAt },
      support: { openPlatformTickets: openTickets, pendingAccessRequests: pendingAccess, activeAccessGrants: activeAccess },
    };
  }

  // ------------------------------------------------------------------ create on behalf
  /**
   * Sets up a centre for a customer of TypEase: the workspace is provisioned and
   * the owner receives an invitation to choose a password. No password is ever
   * set or seen by platform staff.
   */
  async create(input: PlatformCreateTenantInput) {
    const actorId = ctx().userId!;
    if (RESERVED_SLUGS.includes(input.slug)) throw Errors.conflict('SLUG_TAKEN', 'That web address is reserved. Please choose another.');
    if (await this.sys.client.tenant.findUnique({ where: { slug: input.slug }, select: { id: true } })) throw Errors.conflict('SLUG_TAKEN', 'That web address is already in use. Please choose another.');
    if (input.planKey) {
      const plan = await this.sys.client.subscriptionPlan.findUnique({ where: { key: input.planKey } });
      if (!plan || !plan.isActive || !plan.isPublic) throw Errors.unprocessable('PLAN_NOT_AVAILABLE', 'That plan is not available. Choose an active public plan, or leave the plan empty and assign one in Billing later.');
    }
    const existingUser = await this.sys.client.user.findUnique({ where: { email: input.ownerEmail } });
    if (existingUser?.platformRole) throw Errors.conflict('EMAIL_IN_USE', 'That email belongs to a TypEase staff account. Use the owner\'s own email address.');
    if (existingUser && (existingUser.status !== 'ACTIVE' || existingUser.deletedAt)) throw Errors.conflict('ACCOUNT_DISABLED', 'The account with that email is disabled.');
    if (input.ownerPhone) {
      const phoneOwner = await this.sys.client.user.findFirst({ where: { phone: input.ownerPhone }, select: { id: true } });
      if (phoneOwner && phoneOwner.id !== existingUser?.id) throw Errors.conflict('PHONE_IN_USE', 'That phone number is already linked to another account.');
    }

    const { tenant, membership } = await this.sys.tx(
      async (tx) => {
        const user = existingUser ?? (await tx.user.create({ data: { email: input.ownerEmail, fullName: input.ownerName, phone: input.ownerPhone ?? null, preferredLanguage: input.preferredLanguage } }));
        const created = await tx.tenant.create({
          data: {
            slug: input.slug,
            name: input.businessName,
            legalName: input.legalName ?? null,
            emirate: input.emirate ?? null,
            status: 'ONBOARDING',
            onboardingStep: 1,
            contactEmail: input.ownerEmail,
            contactPhone: input.ownerPhone ?? null,
            defaultLanguage: input.preferredLanguage,
          },
        });
        await this.provisioning.provisionTenant(tx, created);
        const ownerRole = await tx.role.findFirstOrThrow({ where: { tenantId: created.id, key: 'owner' } });
        const m = await tx.tenantMembership.create({
          data: { tenantId: created.id, userId: user.id, roleId: ownerRole.id, kind: 'STAFF', status: 'INVITED', allBranches: true, jobTitle: 'Owner', invitedById: actorId, invitedAt: new Date() },
        });
        return { tenant: created, membership: m };
      },
      { timeoutMs: 60_000 },
    );
    this.resolver.invalidate();
    await auditForCentre(
      this.audit,
      { action: 'tenant.created_by_platform', resourceType: 'Tenant', resourceId: tenant.id, summary: `${tenant.name} set up by TypEase; owner ${input.ownerEmail} invited`, after: { slug: tenant.slug, name: tenant.name, ownerEmail: input.ownerEmail, planKey: input.planKey ?? null } },
      tenant,
    );
    const { token } = await this.auth.sendInvitation({ tenantId: tenant.id, membershipId: membership.id, email: input.ownerEmail, fullName: input.ownerName, app: 'centre', language: input.preferredLanguage, centreName: tenant.name, roleName: 'Centre Owner' });

    let plan: { outcome: string; invoiceId: string | null } | { outcome: 'FAILED'; code: string; message: string } | null = null;
    if (input.planKey) {
      try {
        const started = await runAsTenant(tenant.id, () => this.subscriptions.start({ planKey: input.planKey!, billingCycle: input.billingCycle, couponCode: input.couponCode }), { userId: actorId, actorType: 'PLATFORM', actorLabel: ctx().actorLabel });
        plan = { outcome: started.outcome, invoiceId: started.invoiceId };
      } catch (e: any) {
        // The centre exists and the owner is invited; they can still choose a plan during onboarding.
        this.logger.warn(`plan ${input.planKey} could not be started for new centre ${tenant.slug}: ${e?.message ?? e}`);
        plan = { outcome: 'FAILED', code: e?.code ?? 'ERROR', message: e?.message ?? 'The plan could not be started.' };
      }
    }
    return { ...(await this.detail(tenant.id)), plan, invitation: { email: input.ownerEmail, status: 'SENT' as const, ...(devTokens() ? { dev: { invitationToken: token } } : {}) } };
  }

  /** Sends the owner's invitation again (only while it has not been accepted). */
  async resendOwnerInvitation(id: string) {
    const tenant = await this.require(id);
    const m = await this.sys.client.tenantMembership.findFirst({ where: { tenantId: id, kind: 'STAFF', status: 'INVITED', role: { key: 'owner' } }, include: { user: true }, orderBy: { createdAt: 'asc' } });
    if (!m) throw Errors.conflict('NO_PENDING_INVITATION', 'The owner has already accepted the invitation.');
    const { token } = await this.auth.sendInvitation({ tenantId: id, membershipId: m.id, email: m.user.email, fullName: m.user.fullName, app: 'centre', language: tenant.defaultLanguage, centreName: tenant.name, roleName: 'Centre Owner' });
    await auditForCentre(this.audit, { action: 'tenant.owner_invitation_resent', resourceType: 'TenantMembership', resourceId: m.id, summary: `Owner invitation sent again to ${m.user.email}` }, tenant);
    return { email: m.user.email, status: 'SENT' as const, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  // ------------------------------------------------------------------ state changes
  /** Loads the centre with a row lock and checks that the action fits its state. */
  private async locked(tx: Tx, id: string, action: TenantAction): Promise<TenantRow> {
    await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const tenant = found(await tx.tenant.findUnique({ where: { id } }), 'Centre');
    const problem = actionProblem(action, tenant);
    if (problem) throw Errors.conflict(problem.code, problem.message);
    return tenant;
  }
  private subscriptionStatus(tx: Tx, tenantId: string) {
    return tx.subscription.findUnique({ where: { tenantId }, select: { status: true } }).then((s) => s?.status ?? null);
  }
  private async changed(action: string, summary: string, before: TenantRow, after: TenantRow, extra: Record<string, unknown> = {}) {
    await auditForCentre(
      this.audit,
      { action, resourceType: 'Tenant', resourceId: after.id, summary, before: { status: before.status, suspensionReason: before.suspensionReason }, after: { status: after.status, suspensionReason: after.suspensionReason, ...extra } },
      after,
    );
    await this.audit.security(`TENANT_${action.split('.')[1].toUpperCase()}`, 'MEDIUM', { from: before.status, to: after.status, ...extra }, after.id);
  }

  /** PENDING_APPROVAL -> TRIAL / ACTIVE / ... according to the centre's subscription. */
  async approve(id: string, note?: string | null) {
    const { before, after } = await this.sys.tx(async (tx) => {
      const tenant = await this.locked(tx, id, 'approve');
      const next = statusForSubscription(await this.subscriptionStatus(tx, id));
      const updated = await tx.tenant.update({
        where: { id },
        data: { status: next.status, suspensionReason: next.suspensionReason, suspendedAt: next.status === 'SUSPENDED' ? new Date() : null, approvedAt: new Date(), approvedById: ctx().userId ?? null },
      });
      return { before: tenant, after: updated };
    });
    await this.changed('tenant.approved', `${after.name} approved: ${after.status}`, before, after, { note: note ?? null });
    return this.detail(id);
  }

  /** PENDING_APPROVAL -> SUSPENDED with the reason shown to the owner. A later "reactivate" approves it after all. */
  async reject(id: string, reason: string) {
    const { before, after } = await this.sys.tx(async (tx) => {
      const tenant = await this.locked(tx, id, 'reject');
      const updated = await tx.tenant.update({ where: { id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: rejectionReason(reason) } });
      return { before: tenant, after: updated };
    });
    await this.changed('tenant.rejected', `${after.name} was not approved`, before, after, { reason });
    return this.detail(id);
  }

  /**
   * Suspends a centre for a reason other than billing. The stored reason starts
   * with "PLATFORM:", which the subscription lifecycle respects: a payment never
   * lifts this suspension. Staff sessions stay valid so the owner can still read
   * the reason and the subscription page; every other route answers
   * TENANT_UNAVAILABLE from the next request on.
   */
  async suspend(id: string, reason: string) {
    const { before, after } = await this.sys.tx(async (tx) => {
      const tenant = await this.locked(tx, id, 'suspend');
      const updated = await tx.tenant.update({ where: { id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: platformSuspensionReason(reason) } });
      return { before: tenant, after: updated };
    });
    await this.changed('tenant.suspended', `${after.name} suspended by TypEase`, before, after, { reason });
    return this.detail(id);
  }

  /** Lifts a platform suspension (or an archive without offboarding). The centre returns to the state its subscription implies. */
  async reactivate(id: string, note?: string | null) {
    const { before, after } = await this.sys.tx(async (tx) => {
      const tenant = await this.locked(tx, id, 'reactivate');
      const next = statusAfterReactivation(tenant, await this.subscriptionStatus(tx, id));
      const updated = await tx.tenant.update({
        where: { id },
        data: {
          status: next.status,
          suspensionReason: next.suspensionReason,
          suspendedAt: next.status === 'SUSPENDED' ? new Date() : null,
          archivedAt: null,
          // Reactivating a centre that was never approved is the approval.
          ...(next.status !== 'ONBOARDING' && !tenant.approvedAt ? { approvedAt: new Date(), approvedById: ctx().userId ?? null } : {}),
        },
      });
      return { before: tenant, after: updated };
    });
    this.resolver.invalidate();
    await this.changed('tenant.reactivated', `${after.name} reactivated: ${after.status}`, before, after, { note: note ?? null });
    return this.detail(id);
  }

  /**
   * Ends the commercial relationship inside the caller's transaction: open
   * subscription invoices are voided and a running subscription is cancelled,
   * so the billing job never invoices an archived centre. Call AFTER the status
   * was set to ARCHIVED (billing then leaves tenants.status alone).
   */
  async endSubscription(tx: Tx, tenantId: string, why: string): Promise<void> {
    const sub = await this.billing.lockByTenant(tx, tenantId);
    if (!sub) return;
    await this.billing.voidOpenInvoices(tx, sub, {}, why);
    if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') return;
    await tx.subscription.update({ where: { id: sub.id }, data: { cancellationReason: why.slice(0, 500), cancelAtPeriodEnd: false } });
    await this.billing.cancelNow(tx, await this.billing.reload(tx, sub.id));
  }

  /** Signs everybody of the centre out (staff, customers, corporate users and support sessions). */
  async endSessions(tx: Tx, tenantId: string, reason: string): Promise<number> {
    const r = await tx.session.updateMany({ where: { tenantId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  /**
   * Retires a centre without deleting anything: nobody can sign in, the
   * subscription is ended. It can be reactivated later. For permanent deletion
   * use offboarding.
   */
  async archive(id: string, reason: string) {
    const { before, after, sessions } = await this.sys.tx(async (tx) => {
      const tenant = await this.locked(tx, id, 'archive');
      const updated = await tx.tenant.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await this.endSubscription(tx, id, `Centre archived by TypEase: ${reason}`);
      const ended = await this.endSessions(tx, id, 'TENANT_ARCHIVED');
      return { before: tenant, after: updated, sessions: ended };
    });
    this.resolver.invalidate();
    await this.changed('tenant.archived', `${after.name} archived by TypEase`, before, after, { reason, sessionsEnded: sessions });
    return this.detail(id);
  }

  /** Used by the dashboard and the metrics endpoint. */
  async countByStatus(): Promise<Record<TenantStatus, number>> {
    const rows = await this.sys.client.tenant.groupBy({ by: ['status'], _count: { _all: true } });
    const out = { ONBOARDING: 0, PENDING_APPROVAL: 0, TRIAL: 0, ACTIVE: 0, PAST_DUE: 0, SUSPENDED: 0, CANCELLED: 0, ARCHIVED: 0 } as Record<TenantStatus, number>;
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }
}
